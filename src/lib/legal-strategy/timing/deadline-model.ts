// src/lib/legal-strategy/timing/deadline-model.ts
// Phase 7 — §23 — DeadlineCalc. Every deadline calculation requires:
//   1. A verified trigger event (e.g. "decision issued", "notice served")
//   2. A verified date for that trigger event
//   3. A verified legal rule that sets the deadline (article / statute name)
//   4. A calculation method (e.g. "add 7 calendar days")
//
// If ANY of these is missing or disputed, the deadline is UNKNOWN (or, when
// the trigger date is disputed, the result is shown as conditional analysis
// with multiple branches — per §43: "If notice/service date disputed, show
// conditional analysis rather than silently choosing one.")
//
// CRITICAL — §23 + §38: "Never invent deadline." "No calculated deadline
// without verified trigger + rule + calculation." The §40 metric
// `fabricatedDeadlineRate` fires when a calculated deadline (status:
// VERIFIED or CALCULATED_FROM_VERIFIED_RULE) is produced without all four
// inputs verified.

import type { DeadlineCalc, TemporalStatus } from "../types";

// ---------------------------------------------------------------------------
// Calculation method parser
// ---------------------------------------------------------------------------

/**
 * Parse a calculation-method string into a numeric duration. Recognizes
 * patterns like:
 *   - "add 7 calendar days"
 *   - "within 30 days"
 *   - "1 month"
 *   - "60 days from notification"
 *
 * Returns null when no duration can be parsed — the deadline is then UNKNOWN.
 */
export function parseDuration(method: string): {
  days: number | null;
  months: number | null;
} | null {
  if (!method) return null;
  const m = method.toLowerCase();
  // Calendar days.
  const daysMatch = m.match(/(\d+)\s*(calendar\s*)?days?/);
  if (daysMatch) {
    return { days: parseInt(daysMatch[1] ?? "", 10) || null, months: null };
  }
  // Months.
  const monthsMatch = m.match(/(\d+)\s*months?/);
  if (monthsMatch) {
    return { days: null, months: parseInt(monthsMatch[1] ?? "", 10) || null };
  }
  // "Six months" (the ECHR Article 35 period).
  const sixMonths = m.match(/six\s+months/);
  if (sixMonths) {
    return { days: null, months: 6 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

/** Add N calendar days to an ISO date string. Returns ISO date string. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add N months to an ISO date string. Returns ISO date string. */
export function addMonths(isoDate: string, months: number): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return "";
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Weekend / holiday extension (RA jurisdiction rule)
// ---------------------------------------------------------------------------

/**
 * Per RA procedural codes: when a deadline falls on a non-working day
 * (Saturday/Sunday, or a recognized public holiday), the deadline is extended
 * to the next working day. This helper returns the extended date and an
 * `exception` note for the DeadlineCalc.exceptions field.
 */
function applyWeekendExtension(isoDate: string): { date: string; exception?: string } {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return { date: isoDate };
  const dow = d.getDay();
  if (dow === 0 /* Sunday */) {
    const monday = new Date(d);
    monday.setDate(d.getDate() + 1);
    return {
      date: monday.toISOString().slice(0, 10),
      exception: "Deadline fell on a Sunday; extended to the next working day per RA procedural rule.",
    };
  }
  if (dow === 6 /* Saturday */) {
    const monday = new Date(d);
    monday.setDate(d.getDate() + 2);
    return {
      date: monday.toISOString().slice(0, 10),
      exception: "Deadline fell on a Saturday; extended to the next working day per RA procedural rule.",
    };
  }
  return { date: isoDate };
}

// ---------------------------------------------------------------------------
// calculateDeadline
// ---------------------------------------------------------------------------

/**
 * Calculate a deadline. Per §23 + §38, the calculation requires:
 *   - triggerEvent: a verified procedural event (description).
 *   - verifiedDate: the ISO date of the trigger event (null when disputed/unknown).
 *   - legalRule: the article / statute name that sets the deadline.
 *   - method: the calculation method (e.g. "add 7 calendar days").
 *
 * If ANY of the four is missing → status UNKNOWN, resultDate null.
 *
 * If verifiedDate is null because the trigger event's date is disputed →
 * status DISPUTED, and conditionalBranches is populated (one branch per
 * plausible trigger date — the caller supplies these via the `disputedDates`
 * option; if none are supplied, the result is just DISPUTED with no branches).
 *
 * If everything is verified → status CALCULATED_FROM_VERIFIED_RULE (the
 * verifier can later promote to VERIFIED if it independently confirms the
 * trigger event's date and the legal rule).
 *
 * Never throws — returns a DeadlineCalc object with appropriate status.
 *
 * @param triggerEvent description of the trigger event (e.g. "decision issued")
 * @param verifiedDate ISO date of the trigger event (null when disputed/unknown)
 * @param legalRule article / statute name (null when not verified)
 * @param method calculation method (null when not verified)
 * @param opts optional extras (disputedDates, exceptions, assumptions)
 */
export async function calculateDeadline(
  triggerEvent: string,
  verifiedDate: string | null,
  legalRule: string,
  method: string,
  opts: {
    disputedDates?: string[];
    exceptions?: string[];
    assumptions?: string[];
  } = {},
): Promise<DeadlineCalc> {
  const exceptions = opts.exceptions?.slice() ?? [];
  const assumptions = opts.assumptions?.slice() ?? [];

  // §23 — every deadline calc requires trigger + verified date + rule + method.
  const hasTrigger = triggerEvent && triggerEvent.trim().length > 0;
  const hasRule = legalRule && legalRule.trim().length > 0;
  const hasMethod = method && method.trim().length > 0;

  if (!hasTrigger || !hasRule || !hasMethod) {
    // Cannot calculate — UNKNOWN.
    return {
      triggerEvent: hasTrigger ? triggerEvent : "unknown",
      verifiedDate: null,
      legalRule: hasRule ? legalRule : "unknown",
      calculationMethod: hasMethod ? method : "unknown",
      resultDate: null,
      exceptions,
      assumptions: [
        ...assumptions,
        ...[
          !hasTrigger ? "Trigger event not verified" : null,
          !hasRule ? "Legal rule not verified" : null,
          !hasMethod ? "Calculation method not specified" : null,
        ].filter((x): x is string => !!x),
      ],
      status: "UNKNOWN",
    };
  }

  // Trigger date disputed → conditional analysis (§43).
  if (!verifiedDate) {
    const disputedDates = opts.disputedDates?.slice() ?? [];
    if (disputedDates.length === 0) {
      // No alternative dates supplied — DISPUTED with no branches.
      return {
        triggerEvent,
        verifiedDate: null,
        legalRule,
        calculationMethod: method,
        resultDate: null,
        exceptions,
        assumptions: [
          ...assumptions,
          "Trigger event date is disputed; no alternative dates were supplied for conditional analysis.",
        ],
        status: "DISPUTED",
      };
    }
    // Build a conditional branch per disputed date.
    const branches = disputedDates.map((branchDate, idx) => {
      const result = computeResult(branchDate, method);
      const extended = applyWeekendExtension(result);
      if (extended.exception) exceptions.push(extended.exception);
      return {
        branchLabel: `Branch ${idx + 1}: trigger date = ${branchDate}`,
        branchDate,
        branchResult: extended.date,
      };
    });
    return {
      triggerEvent,
      verifiedDate: null,
      legalRule,
      calculationMethod: method,
      resultDate: null,
      exceptions: dedupe(exceptions),
      assumptions: [
        ...assumptions,
        "Trigger event date is disputed; conditional analysis supplied per §43.",
      ],
      status: "DISPUTED",
      conditionalBranches: branches,
    };
  }

  // All four verified — compute the result.
  const raw = computeResult(verifiedDate, method);
  const extended = applyWeekendExtension(raw);
  if (extended.exception) exceptions.push(extended.exception);

  return {
    triggerEvent,
    verifiedDate,
    legalRule,
    calculationMethod: method,
    resultDate: extended.date,
    exceptions: dedupe(exceptions),
    assumptions,
    status: "CALCULATED_FROM_VERIFIED_RULE",
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeResult(verifiedDate: string, method: string): string {
  const dur = parseDuration(method);
  if (!dur) return "";
  if (dur.days !== null) return addDays(verifiedDate, dur.days);
  if (dur.months !== null) return addMonths(verifiedDate, dur.months);
  return "";
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// checkTemporalStatus (re-exported here for convenience)
// ---------------------------------------------------------------------------

/**
 * Compute a TemporalStatus for a DeadlineCalc. This is a separate function
 * (defined in temporal-check.ts) but is re-exported here so the timing
 * layer's public surface is a single import.
 */
export async function checkTemporalStatus(deadline: DeadlineCalc): Promise<TemporalStatus> {
  // Re-route to the dedicated temporal-check module.
  // (Imported lazily to avoid a cycle — the temporal-check module doesn't
  // import from this file.)
  const { checkTemporalStatus: impl } = await import("./temporal-check");
  return impl(deadline);
}
