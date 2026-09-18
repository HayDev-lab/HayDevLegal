// src/lib/legal-strategy/actions/candidate-generator.ts
// Phase 7 — §21 — Generate LegalActionCandidate entries from the action
// registry based on procedural posture + issues.
//
// CRITICAL — §21: "No LLM-invented action type." The generator only emits
// candidates whose actionType is in the ACTION_REGISTRY. Each candidate's
// initial prerequisites / legal basis / procedural effect / draft document
// type come straight from the registry spec — NOT from any LLM call.
//
// NO ranking. NO "best option." The candidates are returned in registry
// order (the same order as ACTION_TYPES); the strategy map (§31) preserves
// that order. The user chooses.

import type {
  ActionSpec,
  ActionType,
  LegalActionCandidate,
  ProceduralPosture,
} from "../types";
import { ACTION_REGISTRY, getActionsForStage, getActionSpec, mapActionToDraftType } from "./registry";
import { STRATEGY_MAX_ACTIONS_PER_ISSUE } from "../config";

// ---------------------------------------------------------------------------
// Prerequisite skeleton builder
// ---------------------------------------------------------------------------

/**
 * Build the initial prerequisite list for an action. Each prerequisite is
 * described in the registry spec (requiredFacts / requiredEvents /
 * requiredMetadata / requiredEvidence). The prerequisites engine (§24) will
 * classify each as SATISFIED / NOT_SATISFIED / UNKNOWN / DISPUTED by linking
 * it to actual CaseFacts / ChronologyEvents / CaseDocuments.
 *
 * Per §21: this is deterministic — no LLM. The descriptions are the spec's
 * own; the prerequisites engine does the matching.
 */
function buildInitialPrerequisites(spec: ActionSpec) {
  const prerequisites: LegalActionCandidate["prerequisites"] = [];
  let idx = 1;
  for (const fact of spec.requiredFacts) {
    prerequisites.push({
      id: `PR-${idx++}`,
      description: fact,
      status: "UNKNOWN",
    });
  }
  for (const ev of spec.requiredEvents) {
    prerequisites.push({
      id: `PR-${idx++}`,
      description: ev,
      status: "UNKNOWN",
    });
  }
  for (const meta of spec.requiredMetadata) {
    prerequisites.push({
      id: `PR-${idx++}`,
      description: `Required metadata: ${meta}`,
      status: "UNKNOWN",
    });
  }
  for (const ev of spec.requiredEvidence) {
    prerequisites.push({
      id: `PR-${idx++}`,
      description: `Required evidence: ${ev}`,
      status: "UNKNOWN",
    });
  }
  return prerequisites;
}

// ---------------------------------------------------------------------------
// Title + description builder (deterministic, no LLM)
// ---------------------------------------------------------------------------

function buildTitle(spec: ActionSpec): string {
  // Map action type to a readable title. No outcome prediction.
  const titleMap: Record<ActionType, string> = {
    MOTION: "Procedural Motion",
    OBJECTION: "Objection to Procedural Act",
    APPEAL: "Appeal of First-Instance Decision",
    CASSATION_APPEAL: "Cassation Appeal",
    CONSTITUTIONAL_COMPLAINT: "Constitutional Complaint",
    ECHR_STEP: "ECHR Procedural Step",
    EVIDENCE_MOTION: "Motion to Admit Evidence",
    EXCLUSION_ARGUMENT: "Motion to Exclude Evidence",
    RELEASE_MOTION: "Motion for Release",
    DEADLINE_RESTORATION_REQUEST: "Deadline Restoration Request",
    DAMAGES_CLAIM: "Claim for Damages",
    ADMINISTRATIVE_CHALLENGE: "Challenge to Administrative Act",
    OTHER: "Other Procedural Action",
  };
  return titleMap[spec.type] ?? "Procedural Action";
}

function buildDescription(spec: ActionSpec): string {
  // The description is the procedural effect — what the action seeks
  // procedurally (NOT whether it will win, per §30).
  return spec.proceduralEffect;
}

// ---------------------------------------------------------------------------
// generateActionCandidates
// ---------------------------------------------------------------------------

/**
 * Generate action candidates for a case based on procedural posture + the
 * list of issue ids the candidates should address.
 *
 * Algorithm:
 *   1. Filter the registry by stage + caseType → list of relevant ActionTypes.
 *   2. For each ActionType (up to STRATEGY_MAX_ACTIONS_PER_ISSUE), build an
 *      initial LegalActionCandidate with:
 *        - title + description (deterministic — from the spec)
 *        - proceduralStage (from the posture)
 *        - legalBasis (from the spec's legalBasisCategories)
 *        - prerequisites (skeleton from the spec's required* fields)
 *        - proceduralEffect (from the spec)
 *        - draftDocumentType (from the spec)
 *        - relatedIssues (the input issue ids — every candidate is
 *          associated with every issue in the input list; the strategy map
 *          builder can later split)
 *        - temporalStatus: UNKNOWN (the timing layer fills this in)
 *        - availabilityStatus: NOT_AVAILABLE_ON_CURRENT_RECORD (the
 *          prerequisites engine fills this in)
 *        - verificationStatus: UNRESOLVED (the verifier fills this in)
 *
 * NO LLM. NO ranking.
 *
 * @param caseId the CaseWorkspace id
 * @param posture the procedural posture (stage, caseType, etc.)
 * @param issues the issue ids the candidates should address ( LegalIssueLink.issueId )
 */
export async function generateActionCandidates(
  caseId: string,
  posture: ProceduralPosture,
  issues: string[],
): Promise<LegalActionCandidate[]> {
  if (!caseId) return [];

  const relevantTypes = getActionsForStage(posture.stage, posture.caseType);
  const now = new Date();
  const relatedIssues = issues.slice();

  const candidates: LegalActionCandidate[] = [];
  for (const type of relevantTypes) {
    if (candidates.length >= STRATEGY_MAX_ACTIONS_PER_ISSUE) break;
    const spec: ActionSpec = getActionSpec(type);
    const prerequisites = buildInitialPrerequisites(spec);
    const candidate: LegalActionCandidate = {
      id: "", // assigned by the persistence layer
      caseId,
      actionType: type,
      title: buildTitle(spec),
      description: buildDescription(spec),
      proceduralStage: posture.stage,
      legalBasis: spec.legalBasisCategories.slice(),
      prerequisites,
      satisfiedPrerequisites: [],
      unsatisfiedPrerequisites: [],
      unknownPrerequisites: prerequisites.map((p) => p.id),
      supportingFacts: [],
      supportingEvidence: [],
      evidenceGaps: [],
      supportingAuthorities: [],
      counterAuthorities: [],
      distinguishingFactors: [],
      temporalStatus: "UNKNOWN",
      limitations: [],
      proceduralEffect: spec.proceduralEffect,
      availabilityStatus: "NOT_AVAILABLE_ON_CURRENT_RECORD",
      verificationStatus: "UNRESOLVED",
      draftDocumentType: mapActionToDraftType(type),
      relatedIssues,
      deadline: null,
      createdAt: now,
      updatedAt: now,
    };
    candidates.push(candidate);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Helper — stable id generator (for in-memory candidates before persistence)
// ---------------------------------------------------------------------------

let _idCounter = 0;
/**
 * Generate a stable in-memory id for a candidate (used when the candidate
 * hasn't been persisted yet). The persistence layer (API route) replaces
 * this with a CUID from Prisma on insert.
 */
export function generateStableCandidateId(caseId: string, actionType: ActionType): string {
  _idCounter = (_idCounter + 1) % 1_000_000;
  return `candidate-${caseId.slice(0, 8)}-${actionType}-${_idCounter}`;
}

// Re-export the registry helpers for convenience.
export { ACTION_REGISTRY, getActionSpec, mapActionToDraftType };
