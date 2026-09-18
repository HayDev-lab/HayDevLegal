// src/lib/legal-strategy/analysis/action-analysis.ts
// Phase 7 — Orchestrate the full analysis of a single LegalActionCandidate.
//
// Pipeline (deterministic — no LLM):
//   1. §24 — evaluatePrerequisites (classify each prerequisite)
//   2. §25 — analyzeEvidenceGaps (only when prerequisites require)
//   3. §25 — linkEvidenceToRequirements (case-internal evidence)
//   4. §23 — calculateDeadline + checkTemporalStatus
//   5. §26 — findSupportingAuthorities (reuses CaseState.authorityIdMap)
//   6. §28 — findCounterAuthorities (case-internal + adverse)
//   7. §29 — analyzeLimitations (structured; NOT outcome prediction)
//   8. §30 — describeProceduralEffect (from registry)
//   9. Refine availabilityStatus based on all the above.
//
// CRITICAL — §17: NO ranking, NO "best option", NO outcome prediction. The
// analyzer only fills in the candidate's structured fields. The user chooses.

import type { LegalActionCandidate } from "../types";
import type { CaseState } from "../state/case-state";
import type { ProceduralPosture } from "../types";
import { evaluatePrerequisites } from "../actions/prerequisites";
import { analyzeEvidenceGaps } from "../evidence/gap-analysis";
import { linkEvidenceToRequirements } from "../evidence/requirement-linker";
import { calculateDeadline } from "../timing/deadline-model";
import { checkTemporalStatus } from "../timing/temporal-check";
import { findSupportingAuthorities } from "../authority/strategy-authority";
import { findCounterAuthorities } from "../authority/counter-authorities";
import { analyzeLimitations } from "./limitation-analysis";
import { describeProceduralEffect } from "./procedural-effect";
import { getActionSpec } from "../actions/registry";

// ---------------------------------------------------------------------------
// analyzeAction
// ---------------------------------------------------------------------------

/**
 * Run the full deterministic analysis pipeline on a single candidate.
 *
 * The candidate is mutated in-place with:
 *   - classified prerequisites + linked ids (§24)
 *   - evidence gaps (§25)
 *   - supporting + contradicting case evidence (§25)
 *   - deadline calculation + temporal status (§23)
 *   - supporting + counter authorities (§26 / §28)
 *   - limitations (§29)
 *   - procedural effect (§30)
 *   - refined availabilityStatus
 *   - verificationStatus = "PARTIAL" (the §37 verifier will promote to
 *     VERIFIED when all its checks pass; UNRESOLVED is left untouched when
 *     the analysis couldn't run at all)
 *
 * @param candidate the in-memory candidate (mutated)
 * @param caseState the bounded CaseState
 * @param posture the procedural posture (used for deadline trigger + challenged act)
 */
export async function analyzeAction(
  candidate: LegalActionCandidate,
  caseState: CaseState,
  posture?: ProceduralPosture,
): Promise<LegalActionCandidate> {
  // 1. §24 — prerequisites.
  await evaluatePrerequisites(candidate, caseState);

  // 2. §25 — evidence gaps.
  await analyzeEvidenceGaps(candidate, caseState);

  // 3. §25 — link evidence to requirements (also fills supportingEvidence).
  await linkEvidenceToRequirements(candidate, caseState);

  // 4. §23 — deadline calculation.
  // The deadline calculation requires a trigger event + verified date +
  // legal rule + calculation method. The spec's timingRequirements gives us
  // a description; we attempt to extract a method and a trigger from the
  // posture + the spec.
  const spec = getActionSpec(candidate.actionType);
  const triggerEvent = posture?.lastVerifiedEvent?.title ?? "";
  const verifiedDate = posture?.lastVerifiedEvent?.date ?? null;
  // Pick the legal rule: the first legalBasis entry (when present) plus the
  // spec's category — the actual rule citation is in the CaseState's
  // authorityIdMap; we surface the category as the rule's "family" so the
  // verifier can confirm it later.
  const legalRule = spec.legalBasisCategories[0] ?? "";
  const method = spec.timingRequirements[0] ?? "";
  const deadline = await calculateDeadline(triggerEvent, verifiedDate, legalRule, method);
  candidate.deadline = deadline;
  candidate.temporalStatus = await checkTemporalStatus(deadline);

  // 5. §26 — supporting authorities.
  await findSupportingAuthorities(candidate, caseState);

  // 6. §28 — counter authorities.
  await findCounterAuthorities(candidate, caseState);

  // 7. §29 — limitations.
  candidate.limitations = analyzeLimitations(candidate);

  // 8. §30 — procedural effect (from registry, already set by the generator;
  //    re-affirm in case it was overwritten).
  candidate.proceduralEffect = describeProceduralEffect(candidate.actionType);

  // 9. Refine availabilityStatus — combine the prerequisite, timing, and
  //    limitation signals.
  candidate.availabilityStatus = refineAvailability(candidate);

  // 10. Set verificationStatus to PARTIAL — the §37 verifier will promote
  //     to VERIFIED when all its checks pass.
  candidate.verificationStatus = "PARTIAL";
  candidate.updatedAt = new Date();

  return candidate;
}

// ---------------------------------------------------------------------------
// refineAvailability
// ---------------------------------------------------------------------------

/**
 * Refine the candidate's availabilityStatus based on all the analysis
 * signals. Rules (in order — first match wins):
 *
 *   - If any prerequisite is NOT_SATISFIED → BLOCKED_BY_MISSING_PREREQUISITE.
 *   - If the temporal status is EXPIRED → NOT_AVAILABLE_ON_CURRENT_RECORD
 *     (the action may be time-barred; we surface this; user can file a
 *     restoration request — a separate candidate).
 *   - If the temporal status is DISPUTED / POTENTIALLY_EXPIRED / UNKNOWN
 *     → TEMPORALLY_UNCERTAIN.
 *   - If the temporal status is VERIFIED or CALCULATED_FROM_VERIFIED_RULE
 *     AND no unsatisfied prerequisite AND supporting facts exist
 *     → AVAILABLE_ON_CURRENT_RECORD.
 *   - If the temporal status is VERIFIED or CALCULATED_FROM_VERIFIED_RULE
 *     AND unknown prerequisites exist (but no unsatisfied) → POTENTIALLY_AVAILABLE.
 *   - Otherwise → NOT_AVAILABLE_ON_CURRENT_RECORD.
 */
function refineAvailability(candidate: LegalActionCandidate): LegalActionCandidate["availabilityStatus"] {
  if (candidate.unsatisfiedPrerequisites.length > 0) {
    return "BLOCKED_BY_MISSING_PREREQUISITE";
  }
  const t = candidate.temporalStatus;
  if (t === "EXPIRED") return "NOT_AVAILABLE_ON_CURRENT_RECORD";
  if (t === "DISPUTED" || t === "POTENTIALLY_EXPIRED" || t === "UNKNOWN") {
    return "TEMPORALLY_UNCERTAIN";
  }
  // VERIFIED or CALCULATED_FROM_VERIFIED_RULE
  if (candidate.unknownPrerequisites.length === 0 && candidate.supportingFacts.length > 0) {
    return "AVAILABLE_ON_CURRENT_RECORD";
  }
  if (candidate.unknownPrerequisites.length > 0) {
    return "POTENTIALLY_AVAILABLE";
  }
  return "NOT_AVAILABLE_ON_CURRENT_RECORD";
}
