// src/lib/legal-strategy/authority/counter-authorities.ts
// Phase 7 — §28 — Find counter-authorities (available adverse / opposing
// authority) for a candidate action.
//
// CRITICAL — §28: "Serious action analysis must include available adverse /
// counter authority. Do not show only favorable material."
//
// The counter-authority layer pulls from two sources:
//   1. The CaseState's contradictingEvidence (case-internal evidence that
//      contradicts a fact the candidate relies on — surfaced via the §25
//      requirement-linker).
//   2. The CaseState.authorityIdMap entries whose citation/source indicates
//      they are adverse — i.e. their applicability field is "NOT_APPLICABLE"
//      or whose citation text contains "distinguished" / "overruled" /
//      "limited" / "not applicable" signals.
//
// Per §28: counter-authority is ALWAYS surfaced when available — never
// hidden to make the action look stronger. The §40 metric
// `counterAuthorityOmissionRate` fires when an action analysis omits
// available counter-authority.
//
// Deterministic — no LLM, no federated search call (reuses CaseState).

import type { LegalActionCandidate } from "../types";
import type { CaseState } from "../state/case-state";
import { linkEvidenceToRequirements } from "../evidence/requirement-linker";
import { STRATEGY_MAX_COUNTER_AUTHORITIES } from "../config";

// ---------------------------------------------------------------------------
// Adverse-applicability detector
// ---------------------------------------------------------------------------

/**
 * Detect whether a persisted LegalReferenceEntry is adverse (counter-
 * authority) based on its `applicability` field + citation text.
 *
 * Conservative — when the entry carries no applicability signal, it is NOT
 * classified as counter-authority (the §28 rule says "available adverse
 * authority" — silently classifying neutral authority as counter would
 * over-inflate the counter list).
 */
function isAdverse(entry: {
  applicability?: string;
  citation: string;
}): boolean {
  // Applicability field — populated by the Phase 4 applicability engine via
  // the precedent-linker. Values like "NOT_APPLICABLE" / "WITH_DISTINCTIONS"
  // indicate adverse / distinguishable authority.
  const a = (entry.applicability ?? "").toLowerCase();
  if (a.includes("not_applicable") || a.includes("not applicable")) return true;
  if (a.includes("with_distinctions") || a.includes("with distinctions")) {
    return true;
  }
  // Citation text — surface signals of adverse treatment.
  const c = entry.citation.toLowerCase();
  if (c.includes("distinguished")) return true;
  if (c.includes("overruled")) return true;
  if (c.includes("limited")) return true;
  if (c.includes("not applicable")) return true;
  if (c.includes("limited application")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// findCounterAuthorities
// ---------------------------------------------------------------------------

/**
 * Find counter-authorities for a candidate action.
 *
 * Algorithm:
 *   1. Re-run the §25 requirement linker to collect contradicting case
 *      evidence (CaseFact.contradictingEvidence of linked facts).
 *   2. Walk the CaseState.authorityIdMap; for each entry that signals
 *      adverse applicability, surface its authority id.
 *   3. Combine: the contradicting evidence refs (synthesized D-id form — we
 *      reuse the linker's output) + the adverse authority ids.
 *
 * The candidate's `counterAuthorities` field is mutated in-place with the
 * combined list (capped at STRATEGY_MAX_COUNTER_AUTHORITIES).
 *
 * Per §28: when no counter-authority is available, returns an empty list.
 * The limitation analysis layer (§29) flags the absence of counter-authority
 * as a limitation only when the action type is "serious" (e.g. APPEAL /
 * CASSATION_APPEAL / CONSTITUTIONAL_COMPLAINT).
 */
export async function findCounterAuthorities(
  candidate: LegalActionCandidate,
  caseState: CaseState,
): Promise<string[]> {
  const counterIds: string[] = [];
  const seen = new Set<string>();

  // 1. Case-internal contradicting evidence (from the requirement linker).
  const { contradicting } = await linkEvidenceToRequirements(candidate, caseState);
  // Synthesize D-ids for the contradicting refs (mirrors Phase 5's
  // precedent-linker convention).
  let dIdx = 0;
  for (const ref of contradicting) {
    if (!ref.documentId) continue;
    dIdx++;
    const id = `D${dIdx}`;
    counterIds.push(id);
    seen.add(id);
    if (counterIds.length >= STRATEGY_MAX_COUNTER_AUTHORITIES) break;
  }

  // 2. Adverse authority entries from the authorityIdMap.
  for (const [authorityId, entry] of caseState.authorityIdMap.entries()) {
    if (counterIds.length >= STRATEGY_MAX_COUNTER_AUTHORITIES) break;
    if (seen.has(authorityId)) continue;
    if (isAdverse(entry)) {
      counterIds.push(authorityId);
      seen.add(authorityId);
    }
  }

  candidate.counterAuthorities = counterIds;
  return counterIds;
}
