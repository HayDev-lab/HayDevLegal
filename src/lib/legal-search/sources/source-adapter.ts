// src/lib/legal-search/sources/source-adapter.ts
// Re-exports the adapter contract + small helpers shared by all adapters.

export type {
  LegalSourceAdapter,
  LegalSearchQuery,
  SourceSearchOutcome,
  SourceStatus,
  SearchContext,
  LegalSearchResult,
  FetchedDocument,
} from "../types";

import type { SourceStatus } from "../types";

/** Map fetch/HTTP failures to a SourceStatus without throwing. */
export function classifyError(err: unknown): { status: SourceStatus; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "AbortError") {
    return { status: "TIMEOUT", detail: "աղբյուրը չպատասխանեց ժամանակին" };
  }
  if (/HTTP 429|rate.?limit/i.test(msg)) {
    return { status: "RATE_LIMITED", detail: "աղբյուրը սահմանափակել է հարցումները" };
  }
  if (/HTTP 40[13]/i.test(msg)) {
    return { status: "RESTRICTED", detail: "աղբյուրը պահանջում է թույլտվություն" };
  }
  if (/policy|blocked|private/i.test(msg)) {
    return { status: "ERROR", detail: "URL-ը մերժվել է անվտանգության քաղաքականությամբ" };
  }
  return { status: "ERROR", detail: `աղբյուրի սխալ՝ ${msg.slice(0, 120)}` };
}

/** Clamp a value into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
