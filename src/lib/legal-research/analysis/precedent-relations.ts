// src/lib/legal-research/analysis/precedent-relations.ts
// Precedent relation analysis (master prompt §29-§32).
//
// DETERMINISTIC. For every pair (A cites identifier of B) inside the
// evidence pack we detect the relation:
//
//   REFERENCES  — the SAFE DEFAULT when only a citation exists (§30);
//   APPLIES     — textual confirmation ("կիրառելով ... իրավական դիրքը");
//   FOLLOWS     — textual confirmation ("հետևելով ... միասնական պրակտիկային");
//   DISTINGUISHES — textual confirmation ("տարբերակելով");
//   LIMITS      — textual confirmation ("սահմանափակելով" / "վերացնելով").
//
// Strong labels are ONLY assigned on textual confirmation near the citation.
// Relations live within the research session — no persistent graph DB (§32).

import type { LegalEvidence } from "@/lib/legal-search/types";
import type { PrecedentRelation, PrecedentRelationKind } from "../types";
import { extractLegalReferences } from "@/lib/legal-search/engine/reference-extractor";
import { ANALYSIS } from "@/lib/legal-search/config";

/** Textual confirmation markers near a citation (window ±160 chars). */
const CONFIRMATION_MARKERS: Array<{ re: RegExp; kind: PrecedentRelationKind }> = [
  { re: /կիրառելով|կիրառել\s+է|applied?\s+the|applying\s+the/i, kind: "APPLIES" },
  { re: /հետևելով|հետևել\s+է|followed?\s+the|following\s+the/i, kind: "FOLLOWS" },
  { re: /տարբերակելով|տարբերակել\s+է|distinguish/i, kind: "DISTINGUISHES" },
  { re: /սահմանափակելով|սահմանափակել\s+է|վերացնելով|չեղարկելով|limit(?:s|ed|ing)?\s+the|overrul/i, kind: "LIMITS" },
  { re: /զարգացնելով|զարգացրել\s+է|develop/i, kind: "DEVELOPS" },
];

/** Identifiers of an evidence item, normalized for matching. */
function identifiersOf(e: LegalEvidence): string[] {
  const ids: string[] = [];
  if (e.caseNumber) ids.push(e.caseNumber.replace(/\s+/g, "").toUpperCase());
  if (e.sourceType === "echr" && e.caseNumber) ids.push(e.caseNumber.replace(/\s+/g, ""));
  return ids;
}

/**
 * Detect relations among the documents of the evidence pack.
 * Bounded by ANALYSIS.maxRelationsFollowed (§71).
 */
export function analyzePrecedentRelations(pack: LegalEvidence[]): PrecedentRelation[] {
  const relations: PrecedentRelation[] = [];
  const seen = new Set<string>();

  const byIdentifier = new Map<string, LegalEvidence>();
  for (const e of pack) {
    for (const id of identifiersOf(e)) byIdentifier.set(id, e);
  }

  for (const from of pack) {
    if (relations.length >= ANALYSIS.maxRelationsFollowed) break;
    const text = from.passage ?? "";
    if (!text) continue;

    const refs = extractLegalReferences(text);
    for (const ref of refs) {
      if (relations.length >= ANALYSIS.maxRelationsFollowed) break;

      const key = ref.value.replace(/\s+/g, "").toUpperCase();
      const to = byIdentifier.get(key);
      if (!to || to.id === from.id) continue;

      const pairKey = `${from.id}->${to.id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      // §30 — safe default is REFERENCES; stronger needs textual proof.
      let kind: PrecedentRelationKind = "REFERENCES";
      const window = contextWindow(text, ref.raw, 160);
      for (const marker of CONFIRMATION_MARKERS) {
        if (marker.re.test(window)) {
          kind = marker.kind;
          break;
        }
      }

      relations.push({
        fromId: from.id,
        toId: to.id,
        kind,
        evidence: { evidenceId: from.id, quote: window.trim().slice(0, 400) },
      });
    }
  }

  return relations;
}

/** ±window characters around the first occurrence of needle in hay. */
export function contextWindow(hay: string, needle: string, window: number): string {
  const idx = hay.indexOf(needle);
  if (idx === -1) return hay.slice(0, window * 2);
  const start = Math.max(0, idx - window);
  const end = Math.min(hay.length, idx + needle.length + window);
  return hay.slice(start, end);
}
