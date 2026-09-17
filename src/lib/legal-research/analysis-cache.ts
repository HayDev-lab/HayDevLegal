// src/lib/legal-research/analysis-cache.ts
// Bounded LRU cache for per-document analysis (master prompt §73-§74).
//
// Cacheable: holding extraction, material facts, structural parse.
// Key: document contentHash + ANALYSIS.cacheVersion. A changed document
// invalidates its analysis automatically (the hash differs). This is NOT
// a RAG store — no cross-request retrieval semantics.

import { ANALYSIS } from "@/lib/legal-search/config";

interface CacheEntry<T> {
  value: T;
  /** Insertion order for LRU eviction. */
  stamp: number;
}

const store = new Map<string, CacheEntry<unknown>>();
let clock = 0;

export function cacheGet<T>(contentHash: string | undefined, kind: string): T | undefined {
  if (!contentHash) return undefined;
  const key = `${ANALYSIS.cacheVersion}:${kind}:${contentHash}`;
  const hit = store.get(key);
  if (!hit) return undefined;
  hit.stamp = ++clock; // refresh LRU
  return hit.value as T;
}

export function cacheSet<T>(contentHash: string | undefined, kind: string, value: T): void {
  if (!contentHash) return;
  const key = `${ANALYSIS.cacheVersion}:${kind}:${contentHash}`;
  store.set(key, { value, stamp: ++clock });
  if (store.size > ANALYSIS.cacheSize) {
    // Evict the least-recently-used entry.
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of store) {
      if (v.stamp < oldest) {
        oldest = v.stamp;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }
}

export function cacheStats(): { size: number; version: string } {
  return { size: store.size, version: ANALYSIS.cacheVersion };
}

export function cacheClear(): void {
  store.clear();
}
