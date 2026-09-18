// src/lib/legal-strategy/timing/temporal-check.ts
// Phase 7 — §23 — Compute the TemporalStatus of a DeadlineCalc.
//
// Possible statuses (verbatim from the spec):
//   VERIFIED                       — every input verified (trigger, date,
//                                    rule, calc method) AND the verifier
//                                    confirmed the trigger event independently.
//   CALCULATED_FROM_VERIFIED_RULE  — every input verified, but the result is
//                                    a calculation (not an explicit court
//                                    statement of the deadline date).
//   DISPUTED                       — the trigger event's date is disputed
//                                    (conditional analysis was supplied).
//   UNKNOWN                        — one or more of the four inputs is
//                                    missing; no calculation was possible.
//   EXPIRED                        — the deadline date is in the past.
//   POTENTIALLY_EXPIRED            — the deadline date is close to today
//                                    (within 7 days) or one of the
//                                    conditional branches is in the past
//                                    while another is in the future.
//
// CRITICAL — §23: "Never invent deadline." When the calc could not be
// performed (UNKNOWN), the engine MUST NOT silently pick a date. The
// candidate's `temporalStatus` then drives `availabilityStatus =
// TEMPORALLY_UNCERTAIN` (handled by the action-analysis layer).

import type { DeadlineCalc, TemporalStatus } from "../types";

// ---------------------------------------------------------------------------
// checkTemporalStatus
// ---------------------------------------------------------------------------

/**
 * Compute the TemporalStatus for a DeadlineCalc.
 *
 * Algorithm (conservative — never invents):
 *   1. If status === "UNKNOWN" → return UNKNOWN (no further inference).
 *   2. If status === "DISPUTED" → check conditional branches:
 *        a. If all branches' result dates are in the past → EXPIRED.
 *        b. If some are in the past and some in the future → POTENTIALLY_EXPIRED.
 *        c. Otherwise → DISPUTED (still disputing; the user must resolve the
 *           trigger date before any other status can apply).
 *   3. If status === "VERIFIED" → check the result date:
 *        a. If past → EXPIRED.
 *        b. If within 7 days of today → POTENTIALLY_EXPIRED.
 *        c. Otherwise → VERIFIED.
 *   4. If status === "CALCULATED_FROM_VERIFIED_RULE" → same as VERIFIED but
 *      the result is CALCULATED_FROM_VERIFIED_RULE (not VERIFIED — the
 *      difference matters for the §37 deadline verifier).
 *
 * Never throws — returns UNKNOWN on any unexpected input.
 */
export async function checkTemporalStatus(
  deadline: DeadlineCalc,
): Promise<TemporalStatus> {
  if (!deadline) return "UNKNOWN";

  // Step 1: UNKNOWN.
  if (deadline.status === "UNKNOWN") {
    return "UNKNOWN";
  }

  // Step 2: DISPUTED — check the conditional branches.
  if (deadline.status === "DISPUTED") {
    const branches = deadline.conditionalBranches ?? [];
    if (branches.length === 0) {
      // Disputed with no branches — leave as DISPUTED.
      return "DISPUTED";
    }
    const now = new Date();
    let pastCount = 0;
    let futureCount = 0;
    for (const b of branches) {
      const d = new Date(b.branchResult);
      if (isNaN(d.getTime())) continue;
      if (d.getTime() < now.getTime()) pastCount++;
      else futureCount++;
    }
    if (pastCount > 0 && futureCount === 0) return "EXPIRED";
    if (pastCount > 0 && futureCount > 0) return "POTENTIALLY_EXPIRED";
    return "DISPUTED";
  }

  // Step 3/4: VERIFIED or CALCULATED_FROM_VERIFIED_RULE.
  if (
    deadline.status === "VERIFIED" ||
    deadline.status === "CALCULATED_FROM_VERIFIED_RULE"
  ) {
    const result = deadline.resultDate;
    if (!result) {
      // No result date computed — fall back to UNKNOWN (the calc didn't
      // complete; we never invent a date).
      return "UNKNOWN";
    }
    const d = new Date(result);
    if (isNaN(d.getTime())) return "UNKNOWN";
    const now = new Date();
    const diffDays = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) return "EXPIRED";
    if (diffDays <= 7) return "POTENTIALLY_EXPIRED";
    return deadline.status; // VERIFIED or CALCULATED_FROM_VERIFIED_RULE
  }

  // Unknown status field — fall back to UNKNOWN.
  return "UNKNOWN";
}
