// src/lib/legal-strategy/analysis/limitation-analysis.ts
// Phase 7 — §29 — Analyze the limitations of a candidate action.
//
// CRITICAL — §29: "Do not convert limitation into outcome prediction." A
// limitation is a structured descriptor of WHY the action is uncertain
// (missing prerequisite, disputed fact, weak support, stale law,
// distinguishable precedent, counter-authority, uncertain deadline, stage
// mismatch, missing challenged act, metadata-only authority). It MUST NOT
// become "you will probably lose" / "low chance of success" language.
//
// The limitation analyzer is deterministic — it walks the candidate's
// classification outputs (prerequisites, evidence gaps, deadline, supporting
// vs counter authorities) and emits structured limitation strings.
//
// The 9 limitation types per §29:
//   1. missing prerequisite
//   2. disputed fact
//   3. weak documentary support
//   4. stale law
//   5. distinguishable precedent
//   6. counter-authority
//   7. uncertain deadline
//   8. stage mismatch
//   9. missing challenged act
//  10. metadata-only authority
//
// Returns the limitation strings — does NOT mutate the candidate (the
// action-analysis layer writes them to candidate.limitations).

import type { LegalActionCandidate } from "../types";
import { getActionSpec } from "../actions/registry";

// ---------------------------------------------------------------------------
// analyzeLimitations
// ---------------------------------------------------------------------------

/**
 * Analyze the limitations of a candidate action. Returns an array of
 * structured limitation strings (each starts with a tag like
 * "missing_prerequisite:" / "disputed_fact:" / "weak_documentary_support:" /
 * ...).
 *
 * The 9 limitation types per §29 are checked. When none apply, returns an
 * empty array (the action has no surfaced limitations).
 *
 * Per §29: the limitations do NOT contain outcome-prediction language. Each
 * is a structured descriptor of why the action is uncertain.
 */
export function analyzeLimitations(
  candidate: LegalActionCandidate,
): string[] {
  const limitations: string[] = [];

  // 1. missing prerequisite.
  if (candidate.unsatisfiedPrerequisites.length > 0) {
    limitations.push(
      `missing_prerequisite: ${candidate.unsatisfiedPrerequisites.length} prerequisite(s) not satisfied on the current record.`,
    );
  }
  if (candidate.unknownPrerequisites.length > 0) {
    limitations.push(
      `missing_prerequisite: ${candidate.unknownPrerequisites.length} prerequisite(s) could not be traced on the current record (marked UNKNOWN).`,
    );
  }

  // 2. disputed fact — walk the candidate's prerequisites for any with
  //    status DISPUTED.
  const disputed = candidate.prerequisites.filter(
    (p) => p.status === "DISPUTED",
  );
  if (disputed.length > 0) {
    limitations.push(
      `disputed_fact: ${disputed.length} prerequisite(s) rest on a disputed fact or event — the action's availability may change when the dispute resolves.`,
    );
  }

  // 3. weak documentary support — the candidate has very few supporting
  //    evidence refs (≤ 1) OR has evidence gaps flagged CRITICAL.
  const criticalGaps = candidate.evidenceGaps.filter((g) => g.severity === "CRITICAL");
  const importantGaps = candidate.evidenceGaps.filter((g) => g.severity === "IMPORTANT");
  if (candidate.supportingEvidence.length === 0) {
    limitations.push(
      "weak_documentary_support: no case-internal evidence is currently linked to the action's prerequisites.",
    );
  } else if (candidate.supportingEvidence.length <= 1) {
    limitations.push(
      "weak_documentary_support: only one piece of case-internal evidence currently supports the action's prerequisites.",
    );
  }
  if (criticalGaps.length > 0) {
    limitations.push(
      `weak_documentary_support: ${criticalGaps.length} critical evidence gap(s) identified — required documents are not in the case record.`,
    );
  }
  if (importantGaps.length > 0) {
    limitations.push(
      `weak_documentary_support: ${importantGaps.length} important evidence gap(s) identified — see evidenceGaps for detail.`,
    );
  }

  // 4. stale law — placeholder: the strategy authority layer doesn't have
  //    the temporal validator's output here (it's in the legal-research
  //    layer). When the supportingAuthorities entries include "historical"
  //    in their temporalStatus, surface a stale-law limitation. We can
  //    detect this heuristically when the citation text mentions a
  //    superseded version (rare — typically the authority layer strips
  //    these out). Left as a hook for the action-analysis layer to fill in.
  // (No detection here — the limitation is only added when the action-
  //  analysis layer has evidence the authority is stale.)

  // 5. distinguishable precedent — when the candidate's distinguishingFactors
  //    list is non-empty.
  if (candidate.distinguishingFactors.length > 0) {
    limitations.push(
      `distinguishable_precedent: ${candidate.distinguishingFactors.length} distinguishing factor(s) identified between the case and the supporting authority.`,
    );
  }

  // 6. counter-authority — always surface when present (§28).
  if (candidate.counterAuthorities.length > 0) {
    limitations.push(
      `counter_authority: ${candidate.counterAuthorities.length} counter-authority/authorities available — these should be addressed before the action is filed.`,
    );
  }

  // 7. uncertain deadline — when temporalStatus is UNKNOWN, DISPUTED,
  //    EXPIRED, or POTENTIALLY_EXPIRED.
  if (candidate.temporalStatus === "UNKNOWN") {
    limitations.push(
      "uncertain_deadline: the deadline could not be calculated — trigger event, rule, or calculation method is unverified.",
    );
  } else if (candidate.temporalStatus === "DISPUTED") {
    limitations.push(
      "uncertain_deadline: the trigger event's date is disputed — conditional analysis supplied; the deadline cannot be confirmed until the dispute resolves.",
    );
  } else if (candidate.temporalStatus === "EXPIRED") {
    limitations.push(
      "uncertain_deadline: the calculated deadline is in the past — the action may be time-barred unless a restoration ground applies.",
    );
  } else if (candidate.temporalStatus === "POTENTIALLY_EXPIRED") {
    limitations.push(
      "uncertain_deadline: the calculated deadline is within 7 days (or one conditional branch is past) — the action's availability is temporally uncertain.",
    );
  }

  // 8. stage mismatch — when the candidate's proceduralStage is not in the
  //    spec's allowedStages (this should never happen — the generator
  //    filters by stage — but the verifier surfaces it). We check
  //    defensively.
  const spec = getActionSpec(candidate.actionType);
  if (candidate.proceduralStage && !spec.allowedStages.includes(candidate.proceduralStage)) {
    limitations.push(
      `stage_mismatch: the action's procedural stage "${candidate.proceduralStage}" is not in the registry's allowedStages for ${candidate.actionType}.`,
    );
  }

  // 9. missing challenged act — when the action type requires a challenged
  //    act (APPEAL / CASSATION_APPEAL / CONSTITUTIONAL_COMPLAINT /
  //    ADMINISTRATIVE_CHALLENGE) and the candidate has no supporting facts
  //    or evidence pointing at the challenged act.
  const requiresChallengedAct = [
    "APPEAL",
    "CASSATION_APPEAL",
    "CONSTITUTIONAL_COMPLAINT",
    "ADMINISTRATIVE_CHALLENGE",
  ].includes(candidate.actionType);
  if (requiresChallengedAct && candidate.supportingFacts.length === 0) {
    limitations.push(
      "missing_challenged_act: the action requires an identifiable challenged act (decision / administrative act) but no supporting fact currently links to one.",
    );
  }

  // 10. metadata-only authority — when ALL of the candidate's supporting
  //     authorities are metadata-only (no fullTextVerified). We can detect
  //     this only when the supporting authorities include the verbatim
  //     "(metadata only)" marker. Since the authorityIdMap entries don't
  //     carry the fullTextVerified flag in the strategy engine's view, we
  //     skip this limitation here. The action-analysis layer can add it
  //     when it inspects the legal-research report (out of scope for this
  //     deterministic pass).
  // (No detection here.)

  return limitations;
}
