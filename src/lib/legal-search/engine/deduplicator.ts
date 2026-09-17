// src/lib/legal-search/engine/deduplicator.ts
// Cross-source deduplication (spec §19).
//
// The same judicial act can surface on Datalex, the judiciary mirror, a
// secondary database, and web results. We dedup by:
//   caseNumber | actNumber | canonical URL | normalized title | court+date
//   | content hash
// When an official source exists, the canonical result points there.

import { normalizeForHash } from "../security/content-sanitizer";
import type { LegalSearchResult } from "../types";

/** Source priority when merging duplicates (higher wins). */
const SOURCE_CANONICAL_PRIORITY: Record<string, number> = {
  arlis: 100,
  "constitutional-court": 95,
  judiciary: 90,
  hudoc: 85,
  datalex: 75,
  "local-laws": 70,
  web: 20,
};

function titleKey(title: string): string {
  return normalizeForHash(title).slice(0, 120);
}

function dateKey(r: LegalSearchResult): string {
  return (r.date ?? r.adoptionDate ?? "").replace(/[^\d]/g, "").slice(0, 8);
}

/**
 * Deduplicate results across sources. Keeps the most authoritative /
// highest-scoring representative of each duplicate group.
 */
export function deduplicate(results: LegalSearchResult[]): LegalSearchResult[] {
  const groups = new Map<string, LegalSearchResult[]>();

  const keysFor = (r: LegalSearchResult): string[] => {
    const keys: string[] = [];
    if (r.caseNumber) keys.push(`case:${r.caseNumber.toUpperCase().replace(/\s+/g, "")}`);
    if (r.actNumber) keys.push(`act:${r.actNumber}`);
    try {
      const u = new URL(r.url);
      u.hash = "";
      u.search = r.url.includes("case_id=") ? u.search : ""; // keep case_id discriminating
      keys.push(`url:${u.toString()}`);
    } catch {
      // ignore malformed
    }
    if (r.title) keys.push(`title:${titleKey(r.title)}`);
    const dk = dateKey(r);
    if (r.court && dk) keys.push(`courtdate:${normalizeForHash(r.court)}:${dk}`);
    if (r.contentHash) keys.push(`hash:${r.contentHash}`);
    return keys;
  };

  // Union-find style: map every key to the first group it touched.
  const keyToGroup = new Map<string, string>();
  let groupSeq = 0;

  for (const r of results) {
    const keys = keysFor(r);
    const existingGroupId = keys.map((k) => keyToGroup.get(k)).find((g) => g !== undefined);
    const groupId = existingGroupId ?? `g${groupSeq++}`;
    if (!existingGroupId) {
      for (const k of keys) keyToGroup.set(k, groupId);
    } else {
      // Merge keys of this result into the existing group.
      for (const k of keys) if (!keyToGroup.has(k)) keyToGroup.set(k, groupId);
    }
    const list = groups.get(groupId) ?? [];
    list.push(r);
    groups.set(groupId, list);
  }

  const out: LegalSearchResult[] = [];
  for (const group of groups.values()) {
    // Keep the best representative: score then canonical priority.
    let best = group[0];
    let bestRank = rankOf(best);
    for (const r of group.slice(1)) {
      const rank = rankOf(r);
      if (rank > bestRank) {
        best = r;
        bestRank = rank;
      }
    }
    // Merge passages from duplicates into the representative.
    const extraPassages = group
      .filter((r) => r !== best && r.passages?.length)
      .flatMap((r) => r.passages!.slice(0, 1));
    if (extraPassages.length && best.passages) {
      const seen = new Set(best.passages.map((p) => p.slice(0, 80)));
      for (const p of extraPassages) {
        if (!seen.has(p.slice(0, 80))) {
          best.passages.push(p);
          if (best.passages.length >= 4) break;
        }
      }
    }
    out.push(best);
  }

  return out;
}

function rankOf(r: LegalSearchResult): number {
  const canonical = SOURCE_CANONICAL_PRIORITY[r.sourceId] ?? 0;
  return r.relevance * 1000 + canonical;
}
