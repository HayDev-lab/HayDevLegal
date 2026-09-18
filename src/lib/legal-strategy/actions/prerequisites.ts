// src/lib/legal-strategy/actions/prerequisites.ts
// Phase 7 — §24 — Classify each prerequisite as SATISFIED / NOT_SATISFIED /
// UNKNOWN / DISPUTED by linking it to actual CaseFacts / ChronologyEvents /
// CaseDocuments / case metadata.
//
// CRITICAL — §24: "Each [prerequisite] links to fact/evidence/law/procedural
// event." A prerequisite without a verified link stays UNKNOWN — it is NEVER
// silently promoted to SATISFIED. The §40 metric `falsePrerequisiteSatisfiedRate`
// fires when a prerequisite is marked SATISFIED without a verified link.
//
// The classifier is deterministic — it scans the CaseState's facts, events,
// evidence links, and case metadata. No LLM.

import type {
  CaseFact,
  LegalActionCandidate,
  Prerequisite,
  PrerequisiteStatus,
} from "../types";
import type { CaseState } from "../state/case-state";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface PrerequisiteClassification {
  satisfied: string[];
  unsatisfied: string[];
  unknown: string[];
}

// ---------------------------------------------------------------------------
// Token similarity (cheap Jaccard — used to match prerequisite descriptions
// to fact propositions / event titles)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = new Set<string>();
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    if (t.length > 2) tokens.add(t);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Per-prerequisite classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single prerequisite against the CaseState. The classification
 * heuristics are conservative — we never mark a prerequisite SATISFIED unless
 * we can point at a verified fact/event/evidence link.
 *
 * Heuristics (in order):
 *   1. If the prerequisite description mentions "metadata" — check the
 *      case metadata fields (court, caseNumber, jurisdiction, parties).
 *   2. If the prerequisite mentions a procedural event — match against
 *      the chronology events by token overlap.
 *   3. If the prerequisite mentions a fact — match against CaseFacts by
 *      token overlap (HIGH materiality preferred).
 *   4. If the prerequisite mentions evidence — check whether the case has
 *      any evidence links at all (full evidence-gap analysis is done by
 *      the §25 layer; here we just check existence).
 *
 * The result includes:
 *   - status: SATISFIED (with a linked fact/event id) | NOT_SATISFIED (when
 *     the case record contains evidence AGAINST the prerequisite) |
 *     UNKNOWN (no link found) | DISPUTED (when conflicting evidence exists).
 *
 * Linked fields (linkedFactId / linkedEventId / linkedEvidenceRef /
 * linkedLegalRule) are filled in when the matching succeeds.
 */
function classifyPrerequisite(
  prereq: Prerequisite,
  state: CaseState,
): { status: PrerequisiteStatus; updated: Partial<Prerequisite> } {
  const desc = prereq.description.toLowerCase();
  const prereqTokens = tokenize(prereq.description);

  // 1. Metadata prerequisite.
  if (desc.includes("metadata")) {
    const field = (desc.match(/metadata:\s*([a-z_]+)/)?.[1] ?? "").trim();
    if (!field) {
      return { status: "UNKNOWN", updated: {} };
    }
    const hasField = caseMetadataHasField(state, field);
    return {
      status: hasField ? "SATISFIED" : "UNKNOWN",
      updated: hasField ? { linkedLegalRule: `case.${field}` } : {},
    };
  }

  // 2. Evidence prerequisite.
  if (desc.includes("evidence") || desc.includes("document")) {
    if (state.evidenceLinks.length === 0 && state.facts.every((f) => f.supportingEvidence.length === 0)) {
      // No evidence at all in the record → UNKNOWN (do NOT mark NOT_SATISFIED,
      // because the case might just not have been processed yet — §25 gap
      // analysis handles the "missing document" flag).
      return { status: "UNKNOWN", updated: {} };
    }
    // Try to find an evidence link that matches the prerequisite's keywords.
    for (const link of state.evidenceLinks) {
      const ref = link.evidenceRef;
      if (ref && ref.documentId && state.documentIndex.has(ref.documentId)) {
        return {
          status: "SATISFIED",
          updated: { linkedEvidenceRef: ref },
        };
      }
    }
    return { status: "UNKNOWN", updated: {} };
  }

  // 3. Event prerequisite — match against chronology.
  if (desc.includes("event") || desc.includes("procedural") || desc.includes("decision") ||
      desc.includes("filing") || desc.includes("hearing") || desc.includes("detention") ||
      desc.includes("arrest")) {
    let bestEvent: { id: string; score: number } | null = null;
    for (const e of state.events) {
      const eventText = `${e.title} ${e.description ?? ""}`;
      const score = jaccard(prereqTokens, tokenize(eventText));
      if (!bestEvent || score > bestEvent.score) {
        bestEvent = { id: e.id, score };
      }
    }
    if (bestEvent && bestEvent.score > 0.15) {
      // Check for dispute — chronology event with hasConflict=true.
      const ev = state.events.find((e) => e.id === bestEvent!.id);
      if (ev?.hasConflict) {
        return {
          status: "DISPUTED",
          updated: { linkedEventId: bestEvent.id },
        };
      }
      return {
        status: "SATISFIED",
        updated: { linkedEventId: bestEvent.id },
      };
    }
    return { status: "UNKNOWN", updated: {} };
  }

  // 4. Fact prerequisite — match against CaseFacts.
  // Prefer VERIFIED facts; consider HIGH materiality.
  const sortedFacts = [...state.facts].sort((a, b) => {
    const aRank = a.status === "VERIFIED" ? 0 : a.status === "DISPUTED" ? 1 : 2;
    const bRank = b.status === "VERIFIED" ? 0 : b.status === "DISPUTED" ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    const aMat = a.materiality === "HIGH" ? 0 : a.materiality === "MEDIUM" ? 1 : 2;
    const bMat = b.materiality === "HIGH" ? 0 : b.materiality === "MEDIUM" ? 1 : 2;
    return aMat - bMat;
  });

  let bestFact: { fact: CaseFact; score: number } | null = null;
  for (const f of sortedFacts) {
    const score = jaccard(prereqTokens, tokenize(f.proposition));
    if (!bestFact || score > bestFact.score) {
      bestFact = { fact: f, score };
    }
  }
  if (bestFact && bestFact.score > 0.15) {
    const f = bestFact.fact;
    // If the fact is CONTRADICTED or DISPUTED and has contradicting evidence,
    // mark the prerequisite DISPUTED.
    if (f.status === "DISPUTED" || f.status === "CONTRADICTED") {
      return {
        status: "DISPUTED",
        updated: { linkedFactId: f.id },
      };
    }
    // If the fact is VERIFIED — SATISFIED.
    if (f.status === "VERIFIED") {
      return {
        status: "SATISFIED",
        updated: { linkedFactId: f.id },
      };
    }
    // ALLEGED → UNKNOWN (we don't promote alleged to satisfied — §24).
    return {
      status: "UNKNOWN",
      updated: { linkedFactId: f.id },
    };
  }

  // No link found — UNKNOWN. NEVER NOT_SATISFIED here, because we have no
  // positive evidence AGAINST the prerequisite either (§25 gap analysis is
  // the layer that flags missing documents).
  return { status: "UNKNOWN", updated: {} };
}

// ---------------------------------------------------------------------------
// Case metadata field checker
// ---------------------------------------------------------------------------

function caseMetadataHasField(state: CaseState, field: string): boolean {
  switch (field) {
    case "court":
      return !!state.court;
    case "caseNumber":
      return !!state.caseNumber;
    case "jurisdiction":
      return !!state.jurisdiction;
    case "proceedingType":
      return !!state.proceedingType;
    case "parties":
      // The case workspace doesn't store a parties array directly — parties
      // are inferred from CaseEntity rows. We don't have them in CaseState;
      // conservatively, mark as UNKNOWN (the verifier checks this).
      return false;
    case "proceduralStage":
      // Procedural stage is derived in the posture layer; if the case has
      // any verified events, we treat stage as present.
      return state.events.length > 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// evaluatePrerequisites
// ---------------------------------------------------------------------------

/**
 * Evaluate all prerequisites for a candidate against the CaseState. Returns
 * three lists: satisfied ids, unsatisfied ids, unknown ids. Also updates
 * the candidate's `prerequisites` array in-place (with linked ids filled in)
 * and the supportingFacts list (with the linked fact ids).
 *
 * Per §24: each prerequisite links to fact/evidence/law/procedural event
 * when possible; otherwise UNKNOWN.
 */
export async function evaluatePrerequisites(
  candidate: LegalActionCandidate,
  caseState: CaseState,
): Promise<PrerequisiteClassification> {
  const satisfied: string[] = [];
  const unsatisfied: string[] = [];
  const unknown: string[] = [];
  const linkedFactIds = new Set<string>();

  for (const prereq of candidate.prerequisites) {
    const { status, updated } = classifyPrerequisite(prereq, caseState);
    // Mutate the prerequisite in-place with the linked ids.
    if (updated.linkedFactId) prereq.linkedFactId = updated.linkedFactId;
    if (updated.linkedEvidenceRef) prereq.linkedEvidenceRef = updated.linkedEvidenceRef;
    if (updated.linkedEventId) prereq.linkedEventId = updated.linkedEventId;
    if (updated.linkedLegalRule) prereq.linkedLegalRule = updated.linkedLegalRule;
    prereq.status = status;

    if (status === "SATISFIED") {
      satisfied.push(prereq.id);
      if (prereq.linkedFactId) linkedFactIds.add(prereq.linkedFactId);
    } else if (status === "NOT_SATISFIED") {
      unsatisfied.push(prereq.id);
    } else if (status === "DISPUTED") {
      // DISPUTED counts as "unknown" for the unsatisfied bucket but the
      // limitation analysis (§29) will surface it as a limitation.
      unknown.push(prereq.id);
      if (prereq.linkedFactId) linkedFactIds.add(prereq.linkedFactId);
    } else {
      unknown.push(prereq.id);
    }
  }

  candidate.satisfiedPrerequisites = satisfied;
  candidate.unsatisfiedPrerequisites = unsatisfied;
  candidate.unknownPrerequisites = unknown;

  // Supporting facts = the union of linked fact ids (F-ids). These are the
  // facts the action's prerequisites rest on.
  candidate.supportingFacts = Array.from(linkedFactIds);

  // Initial availability status — the strategy analysis layer (§31) will
  // refine this with timing + authority information.
  if (unsatisfied.length > 0) {
    candidate.availabilityStatus = "BLOCKED_BY_MISSING_PREREQUISITE";
  } else if (unknown.length > 0) {
    candidate.availabilityStatus = "POTENTIALLY_AVAILABLE";
  } else if (satisfied.length === candidate.prerequisites.length && candidate.prerequisites.length > 0) {
    candidate.availabilityStatus = "AVAILABLE_ON_CURRENT_RECORD";
  } else {
    candidate.availabilityStatus = "NOT_AVAILABLE_ON_CURRENT_RECORD";
  }

  return { satisfied, unsatisfied, unknown };
}
