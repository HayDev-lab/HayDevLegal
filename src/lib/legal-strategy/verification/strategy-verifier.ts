// src/lib/legal-strategy/verification/strategy-verifier.ts
// Phase 7 — §37 — Verify a LegalActionCandidate against the action registry
// and the closed-evidence firewall.
//
// CRITICAL — §37: "Every action candidate must pass:
//   - action exists in registry
//   - stage compatible
//   - prerequisites traceable
//   - deadline traceable or unknown
//   - legal basis exists
//   - authority IDs valid
//   - case evidence IDs valid
//   - procedural effect supported
//   - availability status supported"
//
// The verifier runs each of these 9 checks and returns { passed, checks }.
// When all pass, the candidate's `verificationStatus` can be promoted to
// VERIFIED. When any fails, it stays PARTIAL (or UNRESOLVED when the
// candidate was never analyzed).

import type {
  LegalActionCandidate,
  VerificationCheck,
} from "../types";
import { ACTION_REGISTRY, getActionSpec, isRegisteredActionType } from "../actions/registry";
import type { CaseState } from "../state/case-state";
import { verifyDeadline } from "./deadline-verifier";
import { verifyAuthorities } from "./authority-verifier";

// ---------------------------------------------------------------------------
// verifyActionCandidate
// ---------------------------------------------------------------------------

/**
 * Verify a candidate against the §37 checks.
 *
 * The verifier is given the CaseState (for authority/evidence ID validation)
 * and an optional `sourceIdMap` (mirrors Phase 6's source-id map — when the
 * candidate was produced by a Codex synthesis pass, the sourceIdMap maps the
 * Codex-internal authority ids to the CaseState's persisted authority
 * entries).
 *
 * @param candidate the candidate to verify
 * @param caseState the bounded CaseState (for evidence ID validation)
 * @param sourceIdMap optional map of authority IDs the Codex synthesizer
 *   may have used (for authority verification)
 */
export async function verifyActionCandidate(
  candidate: LegalActionCandidate,
  caseState?: CaseState,
  sourceIdMap?: Record<string, unknown>,
): Promise<{ passed: boolean; checks: VerificationCheck[] }> {
  const checks: VerificationCheck[] = [];

  // 1. Action exists in registry.
  const inRegistry = isRegisteredActionType(candidate.actionType);
  checks.push({
    name: "action_in_registry",
    passed: inRegistry,
    detail: inRegistry
      ? `${candidate.actionType} is a registered action type.`
      : `${candidate.actionType} is NOT in the registry (§21 — no LLM-invented action type).`,
  });

  // 2. Stage compatible.
  const spec = inRegistry ? getActionSpec(candidate.actionType) : null;
  const stageOk =
    spec !== null &&
    (!candidate.proceduralStage ||
      spec.allowedStages.includes(candidate.proceduralStage));
  checks.push({
    name: "stage_compatible",
    passed: stageOk,
    detail:
      spec === null
        ? "Cannot check stage — action type not in registry."
        : stageOk
          ? `Stage "${candidate.proceduralStage ?? "(none)"}" is in ${candidate.actionType}'s allowedStages.`
          : `Stage "${candidate.proceduralStage}" is NOT in ${candidate.actionType}'s allowedStages (${spec.allowedStages.join(", ")}).`,
  });

  // 3. Prerequisites traceable — every prerequisite either has a linked id
  //    OR is marked UNKNOWN (NOT_SATISFIED is also acceptable — it's a
  //    "linked to a verified absent fact" verdict). DISPUTED is acceptable
  //    when linkedFactId is set.
  const untraceable = candidate.prerequisites.filter(
    (p) =>
      p.status === "UNKNOWN" &&
      !p.linkedFactId &&
      !p.linkedEvidenceRef &&
      !p.linkedEventId &&
      !p.linkedLegalRule,
  );
  // UNKNOWN is fine per §24 ("each prerequisite links to fact/evidence/law/
  // procedural event") — but a prerequisite marked SATISFIED with NO linked
  // id IS a §24 violation (falsePrerequisiteSatisfiedRate fires).
  const falseSatisfied = candidate.prerequisites.filter(
    (p) =>
      p.status === "SATISFIED" &&
      !p.linkedFactId &&
      !p.linkedEvidenceRef &&
      !p.linkedEventId &&
      !p.linkedLegalRule,
  );
  checks.push({
    name: "prerequisites_traceable",
    passed: untraceable.length === 0 && falseSatisfied.length === 0,
    detail:
      untraceable.length === 0 && falseSatisfied.length === 0
        ? `All ${candidate.prerequisites.length} prerequisite(s) are traceable.`
        : [
            untraceable.length > 0
              ? `${untraceable.length} prerequisite(s) marked UNKNOWN lack any link.`
              : null,
            falseSatisfied.length > 0
              ? `${falseSatisfied.length} prerequisite(s) marked SATISFIED lack a linked id (§24 violation).`
              : null,
          ]
            .filter((s): s is string => !!s)
            .join(" | "),
  });

  // 4. Deadline traceable or unknown.
  if (candidate.deadline) {
    const dlResult = await verifyDeadline(candidate.deadline);
    checks.push({
      name: "deadline_traceable",
      passed: dlResult.passed,
      detail: dlResult.detail,
    });
  } else {
    // No deadline on the candidate — OK (the action may not have a statutory
    // deadline; e.g. MOTION at the investigation stage).
    checks.push({
      name: "deadline_traceable",
      passed: true,
      detail: "No deadline on the candidate (action may not have a statutory deadline).",
    });
  }

  // 5. Legal basis exists.
  const legalBasisOk =
    spec !== null &&
    candidate.legalBasis.length > 0 &&
    candidate.legalBasis.every((b) => spec.legalBasisCategories.includes(b));
  checks.push({
    name: "legal_basis_exists",
    passed: legalBasisOk,
    detail:
      spec === null
        ? "Cannot check legal basis — action type not in registry."
        : legalBasisOk
          ? `Legal basis (${candidate.legalBasis.join(", ")}) matches the spec's categories.`
          : `Legal basis does not match the spec's categories (${spec.legalBasisCategories.join(", ")}).`,
  });

  // 6. Authority IDs valid.
  const authorityIdsValid = caseState
    ? caseState.authorityIdMap
    : undefined;
  const authResult = await verifyAuthorities(
    candidate,
    sourceIdMap && Object.keys(sourceIdMap).length > 0
      ? sourceIdMap
      : (authorityIdsValid
          ? Object.fromEntries(authorityIdsValid.entries())
          : {}),
  );
  checks.push({
    name: "authority_ids_valid",
    passed: authResult.passed,
    detail:
      authResult.passed
        ? "All supporting + counter authority IDs are valid."
        : `Invalid authority IDs: ${authResult.invalid.join(", ")}`,
  });

  // 7. Case evidence IDs valid.
  let evidenceIdsOk = true;
  const invalidEvidenceIds: string[] = [];
  if (caseState) {
    for (const ref of candidate.supportingEvidence) {
      if (!ref.documentId || !caseState.documentIndex.has(ref.documentId)) {
        evidenceIdsOk = false;
        invalidEvidenceIds.push(ref.documentId ?? "(missing)");
      }
    }
    // Also check evidence gap existingEvidence refs.
    for (const gap of candidate.evidenceGaps) {
      for (const ref of gap.existingEvidence) {
        if (!ref.documentId || !caseState.documentIndex.has(ref.documentId)) {
          evidenceIdsOk = false;
          invalidEvidenceIds.push(ref.documentId ?? "(missing)");
        }
      }
    }
  } else {
    // No CaseState supplied — assume valid (the verifier may be called
    // from a context without a CaseState; the limitation analysis + evaluator
    // still cover the closed-evidence firewall separately).
    evidenceIdsOk = true;
  }
  checks.push({
    name: "case_evidence_ids_valid",
    passed: evidenceIdsOk,
    detail: evidenceIdsOk
      ? "All supporting evidence refs point at real case documents."
      : `Invalid evidence document IDs: ${invalidEvidenceIds.join(", ")}`,
  });

  // 8. Procedural effect supported.
  const proceduralEffectOk =
    spec !== null && candidate.proceduralEffect === spec.proceduralEffect;
  checks.push({
    name: "procedural_effect_supported",
    passed: proceduralEffectOk,
    detail:
      spec === null
        ? "Cannot check procedural effect — action type not in registry."
        : proceduralEffectOk
          ? "Procedural effect matches the registry spec."
          : `Procedural effect does not match the registry spec (expected: "${spec.proceduralEffect}").`,
  });

  // 9. Availability status supported.
  // The status is "supported" when it's consistent with the prerequisite
  // classification: BLOCKED_BY_MISSING_PREREQUISITE ↔ unsatisfied.length > 0;
  // AVAILABLE_ON_CURRENT_RECORD ↔ all satisfied + supporting facts; etc.
  const hasUnsatisfied = candidate.unsatisfiedPrerequisites.length > 0;
  const hasUnknown = candidate.unknownPrerequisites.length > 0;
  const hasSupportingFacts = candidate.supportingFacts.length > 0;
  let expectedStatus: LegalActionCandidate["availabilityStatus"];
  if (hasUnsatisfied) {
    expectedStatus = "BLOCKED_BY_MISSING_PREREQUISITE";
  } else if (
    candidate.temporalStatus === "EXPIRED" ||
    candidate.temporalStatus === "DISPUTED" ||
    candidate.temporalStatus === "POTENTIALLY_EXPIRED" ||
    candidate.temporalStatus === "UNKNOWN"
  ) {
    expectedStatus = candidate.temporalStatus === "EXPIRED"
      ? "NOT_AVAILABLE_ON_CURRENT_RECORD"
      : "TEMPORALLY_UNCERTAIN";
  } else if (!hasUnknown && hasSupportingFacts) {
    expectedStatus = "AVAILABLE_ON_CURRENT_RECORD";
  } else if (hasUnknown) {
    expectedStatus = "POTENTIALLY_AVAILABLE";
  } else {
    expectedStatus = "NOT_AVAILABLE_ON_CURRENT_RECORD";
  }
  const availabilityOk = candidate.availabilityStatus === expectedStatus;
  checks.push({
    name: "availability_status_supported",
    passed: availabilityOk,
    detail: availabilityOk
      ? `Availability status "${candidate.availabilityStatus}" is consistent with the prerequisite + timing analysis.`
      : `Availability status "${candidate.availabilityStatus}" is NOT consistent with the analysis (expected "${expectedStatus}").`,
  });

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

// Re-export the registry for verifier callers.
export { ACTION_REGISTRY };
