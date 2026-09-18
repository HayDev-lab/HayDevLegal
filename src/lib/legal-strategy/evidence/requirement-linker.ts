// src/lib/legal-strategy/evidence/requirement-linker.ts
// Phase 7 — Link case-internal evidence (CaseEvidenceLink / CaseFact
// supporting+contradicting evidence refs) to the prerequisites of an action
// candidate.
//
// Output: { supporting: EvidenceRef[], contradicting: EvidenceRef[] }
//   - supporting  = case evidence that supports at least one prerequisite
//   - contradicting = case evidence that contradicts at least one
//     prerequisite (or that supports the opposing party's position)
//
// Deterministic — no LLM. Used by the strategy analysis layer to populate
// candidate.supportingEvidence and to flag counter-evidence (which feeds the
// §28 counter-authority layer when paired with adverse precedent).

import type { EvidenceRef, LegalActionCandidate } from "../types";
import type { CaseState } from "../state/case-state";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface RequirementLinkResult {
  supporting: EvidenceRef[];
  contradicting: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refKey(r: EvidenceRef): string {
  return `${r.documentId ?? ""}|${r.page ?? ""}|${r.section ?? ""}|${r.quote ?? ""}`;
}

function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// linkEvidenceToRequirements
// ---------------------------------------------------------------------------

/**
 * Walk the candidate's prerequisites (each carrying a linkedFactId /
 * linkedEventId / linkedEvidenceRef after the §24 classification) and collect
 * the case-internal evidence refs that support or contradict them.
 *
 * Algorithm:
 *   - For each prerequisite with a linkedFactId → fetch the CaseFact; collect
 *     its supportingEvidence as "supporting" refs and its
 *     contradictingEvidence as "contradicting" refs.
 *   - For each prerequisite with a linkedEvidenceRef (already directly
 *     linked) → add it to "supporting".
 *   - For each prerequisite with a linkedEventId → fetch the chronology
 *     event's evidenceRefs (which are by definition supporting — they
 *     document the event).
 *
 * Mutates the candidate:
 *   - candidate.supportingEvidence = supporting refs (deduped)
 *   - (contradicting refs are returned but not stored on a dedicated field —
 *     they feed the §28 counter-authority analysis through the limitation
 *     analysis layer)
 *
 * @param candidate the action candidate (with prerequisites classified)
 * @param caseState the bounded CaseState
 */
export async function linkEvidenceToRequirements(
  candidate: LegalActionCandidate,
  caseState: CaseState,
): Promise<RequirementLinkResult> {
  const supporting: EvidenceRef[] = [];
  const contradicting: EvidenceRef[] = [];

  const factMap = new Map(caseState.facts.map((f) => [f.id, f]));
  const eventMap = new Map(caseState.events.map((e) => [e.id, e]));

  for (const prereq of candidate.prerequisites) {
    // Linked fact.
    if (prereq.linkedFactId) {
      const fact = factMap.get(prereq.linkedFactId);
      if (fact) {
        supporting.push(...fact.supportingEvidence);
        contradicting.push(...fact.contradictingEvidence);
      }
    }
    // Linked evidence ref (direct).
    if (prereq.linkedEvidenceRef) {
      supporting.push(prereq.linkedEvidenceRef);
    }
    // Linked event.
    if (prereq.linkedEventId) {
      const event = eventMap.get(prereq.linkedEventId);
      if (event) {
        supporting.push(...event.evidenceRefs);
      }
    }
  }

  // Validate refs against the documentIndex — drop any that point at a
  // document that is NOT in the case (§37 — case evidence IDs valid).
  const validatedSupporting = supporting.filter(
    (r) => r.documentId && caseState.documentIndex.has(r.documentId),
  );
  const validatedContradicting = contradicting.filter(
    (r) => r.documentId && caseState.documentIndex.has(r.documentId),
  );

  // Mutate the candidate.
  candidate.supportingEvidence = dedupeRefs(validatedSupporting);

  return {
    supporting: candidate.supportingEvidence,
    contradicting: dedupeRefs(validatedContradicting),
  };
}
