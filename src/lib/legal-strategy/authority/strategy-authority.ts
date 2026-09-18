// src/lib/legal-strategy/authority/strategy-authority.ts
// Phase 7 — §26 — Find supporting authorities for a candidate action.
//
// CRITICAL — §26: "Reuse existing ARLIS / Cassation / ConCourt / HUDOC
// federated search + Phase 4 applicability. Do NOT create a second legal
// research engine."
//
// The authority layer does NOT re-run the federated search (that would be a
// second research engine). Instead it consumes the authorities already
// persisted in the CaseState.authorityIdMap — populated by buildCaseState
// from LegalIssueLink.relatedLaw + .relatedPrecedents (which were persisted
// by the Phase 5 §13 research layer that called the Phase 3 federated search
// and Phase 4 applicability engines).
//
// For each candidate action:
//   - Filter the authorityIdMap to entries whose citation/source mentions a
//     legal-basis category in the candidate's spec (e.g.
//     "criminal_procedure_code").
//   - Map each surviving entry to its stable authority id (L1, C1, CC1, E1).
//   - Return the list of supporting authority ids.
//
// Deterministic — no LLM, no federated search call. When the CaseState has
// no persisted authorities, returns an empty list (the limitation analysis
// layer flags the missing-authority gap).

import type { LegalActionCandidate } from "../types";
import { getActionSpec } from "../actions/registry";
import type { CaseState } from "../state/case-state";
import { STRATEGY_MAX_AUTHORITIES_PER_ISSUE } from "../config";

// ---------------------------------------------------------------------------
// Source/category keyword matching
// ---------------------------------------------------------------------------

/**
 * Match a LegalReferenceEntry (a persisted authority) to a legal-basis
 * category from the action spec. The match is on the entry's source string +
 * citation text — e.g. a `source: "arlis"` + citation mentioning "Criminal
 * Procedure Code" matches the `criminal_procedure_code` category.
 *
 * Conservative — when no category matches, returns false (the entry is not
 * supporting this action).
 */
function matchesCategory(
  entry: { source: string; citation: string },
  category: string,
): boolean {
  const text = `${entry.source} ${entry.citation}`.toLowerCase();
  const cat = category.toLowerCase();
  // Map category names to common citation phrases.
  const categoryPhrases: Record<string, string[]> = {
    criminal_procedure_code: ["criminal procedure", "քրեական վարույթ", "уголовного процесса"],
    civil_procedure_code: ["civil procedure", "քաղաքացիական վարույթ", "гражданского процесса"],
    administrative_procedure_code: [
      "administrative procedure",
      "վարչական վարույթ",
      "административного процесса",
    ],
    administrative_offences_code: [
      "administrative offences",
      "վարչական խախտումներ",
      "об административных проступках",
    ],
    civil_code: ["civil code", "քաղաքացիական օրենսգիրք", "гражданского кодекса"],
    criminal_code: ["criminal code", "քրեական օրենսգիրք", "уголовного кодекса"],
    constitution: ["constitution", "սահմանադրություն", "конституции"],
    constitutional_court_law: [
      "constitutional court",
      "սահմանադրական դատարան",
      "конституционного суда",
    ],
    echr_convention: ["echr", "convention", "european court", "մարդու իրավունքներ", "европейского суда"],
    judicial_code: ["judicial code", "դատական օրենսգիրք"],
    bankruptcy: ["bankruptcy", "սնանկություն", "банкротства"],
    other: [],
  };
  const phrases = categoryPhrases[cat] ?? [];
  if (phrases.length === 0) {
    // "other" — accept any entry.
    return true;
  }
  return phrases.some((p) => text.includes(p));
}

// ---------------------------------------------------------------------------
// findSupportingAuthorities
// ---------------------------------------------------------------------------

/**
 * Find supporting authorities for a candidate action. Returns a list of
 * stable authority ids (L1, C1, CC1, E1, ...) that the candidate's legal-basis
 * categories match.
 *
 * The candidate's `supportingAuthorities` field is mutated in-place with the
 * result.
 *
 * Per §26: reuses the CaseState.authorityIdMap populated by buildCaseState
 * — does NOT re-run the federated search.
 *
 * @param candidate the action candidate (legalBasis is the spec's categories)
 * @param caseState the bounded CaseState (with authorityIdMap populated)
 */
export async function findSupportingAuthorities(
  candidate: LegalActionCandidate,
  caseState: CaseState,
): Promise<string[]> {
  const spec = getActionSpec(candidate.actionType);
  const matchingIds: string[] = [];
  const seenCitations = new Set<string>();

  for (const [authorityId, entry] of caseState.authorityIdMap.entries()) {
    // Skip entries whose citation we've already seen (dedupe).
    const citeKey = `${entry.source}|${entry.citation}`;
    if (seenCitations.has(citeKey)) continue;
    // Match against any of the spec's legal-basis categories.
    const matches = spec.legalBasisCategories.some((cat) =>
      matchesCategory(entry, cat),
    );
    if (matches) {
      matchingIds.push(authorityId);
      seenCitations.add(citeKey);
    }
    if (matchingIds.length >= STRATEGY_MAX_AUTHORITIES_PER_ISSUE) break;
  }

  candidate.supportingAuthorities = matchingIds;
  return matchingIds;
}
