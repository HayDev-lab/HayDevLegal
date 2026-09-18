// src/lib/legal-strategy/verification/deadline-verifier.ts
// Phase 7 — §38 — Verify a DeadlineCalc.
//
// CRITICAL — §38: "No calculated deadline without verified trigger + rule +
// calculation." When the deadline's status is VERIFIED or
// CALCULATED_FROM_VERIFIED_RULE, the verifier checks that ALL FOUR inputs
// are present (trigger event, verified date, legal rule, calculation method)
// and rejects the deadline otherwise.
//
// When the deadline's status is UNKNOWN or DISPUTED, the verifier passes
// (these statuses are honest — the deadline could not be calculated).

import type { DeadlineCalc } from "../types";

// ---------------------------------------------------------------------------
// verifyDeadline
// ---------------------------------------------------------------------------

/**
 * Verify a DeadlineCalc.
 *
 * Rules (per §38):
 *   - If status is VERIFIED:
 *       passed = (triggerEvent && verifiedDate && legalRule && calculationMethod && resultDate)
 *   - If status is CALCULATED_FROM_VERIFIED_RULE:
 *       passed = (triggerEvent && verifiedDate && legalRule && calculationMethod && resultDate)
 *   - If status is UNKNOWN:
 *       passed = true (honest — no calc was possible)
 *       BUT detail must say which input was missing.
 *   - If status is DISPUTED:
 *       passed = true when conditionalBranches is non-empty; otherwise
 *       passed = false (a DISPUTED deadline with no branches is incomplete).
 *   - If status is EXPIRED or POTENTIALLY_EXPIRED:
 *       passed = (status was derived from a VERIFIED or CALCULATED deadline
 *       with a result date). We accept this only when resultDate is present.
 *
 * @param deadline the DeadlineCalc to verify
 */
export async function verifyDeadline(
  deadline: DeadlineCalc,
): Promise<{ passed: boolean; detail?: string }> {
  if (!deadline) {
    return { passed: false, detail: "Deadline object is missing." };
  }

  const hasTrigger = !!deadline.triggerEvent && deadline.triggerEvent !== "unknown";
  const hasDate = !!deadline.verifiedDate;
  const hasRule = !!deadline.legalRule && deadline.legalRule !== "unknown";
  const hasMethod =
    !!deadline.calculationMethod && deadline.calculationMethod !== "unknown";
  const hasResult = !!deadline.resultDate;

  switch (deadline.status) {
    case "VERIFIED":
    case "CALCULATED_FROM_VERIFIED_RULE": {
      // §38 — all four inputs must be present + result date must be computed.
      if (hasTrigger && hasDate && hasRule && hasMethod && hasResult) {
        return {
          passed: true,
          detail: `Deadline (${deadline.status}) verified — trigger "${deadline.triggerEvent}" on ${deadline.verifiedDate}, rule "${deadline.legalRule}", method "${deadline.calculationMethod}", result ${deadline.resultDate}.`,
        };
      }
      const missing: string[] = [];
      if (!hasTrigger) missing.push("triggerEvent");
      if (!hasDate) missing.push("verifiedDate");
      if (!hasRule) missing.push("legalRule");
      if (!hasMethod) missing.push("calculationMethod");
      if (!hasResult) missing.push("resultDate");
      return {
        passed: false,
        detail: `§38 violation: deadline marked ${deadline.status} but missing: ${missing.join(", ")}.`,
      };
    }
    case "UNKNOWN": {
      // Honest — the calc could not run. We PASS, but detail which input
      // was missing.
      const missing: string[] = [];
      if (!hasTrigger) missing.push("triggerEvent");
      if (!hasDate) missing.push("verifiedDate");
      if (!hasRule) missing.push("legalRule");
      if (!hasMethod) missing.push("calculationMethod");
      return {
        passed: true,
        detail: `Deadline UNKNOWN (honest). Missing: ${missing.join(", ") || "(none — calc ran but produced no result)"}.`,
      };
    }
    case "DISPUTED": {
      if ((deadline.conditionalBranches ?? []).length > 0) {
        return {
          passed: true,
          detail: `Deadline DISPUTED — ${(deadline.conditionalBranches ?? []).length} conditional branch(es) supplied per §43.`,
        };
      }
      return {
        passed: false,
        detail:
          "§38/§43 violation: deadline marked DISPUTED but no conditionalBranches supplied.",
      };
    }
    case "EXPIRED":
    case "POTENTIALLY_EXPIRED": {
      if (hasResult) {
        return {
          passed: true,
          detail: `Deadline ${deadline.status} — result date ${deadline.resultDate} is in the past${deadline.status === "POTENTIALLY_EXPIRED" ? " or close to today" : ""}.`,
        };
      }
      return {
        passed: false,
        detail: `Deadline marked ${deadline.status} but no resultDate present — cannot confirm expiration.`,
      };
    }
    default:
      return {
        passed: false,
        detail: `Unknown TemporalStatus: ${deadline.status}.`,
      };
  }
}
