// src/lib/legal-strategy/verification/authority-verifier.ts
// Phase 7 — Verify that the supporting + counter authority IDs on a
// candidate are valid (present in the supplied sourceIdMap or the CaseState
// authorityIdMap).
//
// This implements §37 check #6 ("authority IDs valid"). The sourceIdMap is
// supplied by the caller — when the candidate was produced by the deterministic
// pipeline, it's the CaseState.authorityIdMap; when produced by a Codex
// synthesis pass, it's the sourceIdMap the API route built.

import type { LegalActionCandidate } from "../types";

// ---------------------------------------------------------------------------
// verifyAuthorities
// ---------------------------------------------------------------------------

/**
 * Verify that every supporting + counter authority ID on the candidate is
 * present in the supplied sourceIdMap.
 *
 * Returns { passed, invalid } where `invalid` is the list of authority IDs
 * that are NOT in the map.
 *
 * @param candidate the candidate to verify
 * @param sourceIdMap a Record<string, unknown> mapping authority IDs (L1,
 *   C1, CC1, E1, ...) to their citation entries. The map's KEYS are what
 *   we check against — values are not inspected here.
 */
export async function verifyAuthorities(
  candidate: LegalActionCandidate,
  sourceIdMap: Record<string, unknown>,
): Promise<{ passed: boolean; invalid: string[] }> {
  const validIds = new Set<string>(Object.keys(sourceIdMap));
  const invalid: string[] = [];

  for (const id of candidate.supportingAuthorities) {
    if (!validIds.has(id)) {
      invalid.push(id);
    }
  }
  for (const id of candidate.counterAuthorities) {
    if (!validIds.has(id)) {
      invalid.push(id);
    }
  }

  return {
    passed: invalid.length === 0,
    invalid,
  };
}
