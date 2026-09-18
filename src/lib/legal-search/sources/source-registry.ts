// src/lib/legal-search/sources/source-registry.ts
// Registry of all live source adapters. The engine talks ONLY to this registry.

import type { LegalSourceAdapter, LegalSearchQuery, SearchMode } from "../types";
import { arlisAdapter } from "./arlis/adapter";
import { datalexAdapter } from "./datalex/adapter";
import { constitutionalCourtAdapter } from "./constitutional-court/adapter";
import { judiciaryAdapter } from "./judiciary/adapter";
import { hudocAdapter } from "./hudoc/adapter";
import { webAdapter } from "./web/adapter";
import { localLawsAdapter } from "../local-laws/adapter";

const ALL_ADAPTERS: LegalSourceAdapter[] = [
  arlisAdapter,
  localLawsAdapter,
  constitutionalCourtAdapter,
  judiciaryAdapter,
  datalexAdapter,
  hudocAdapter,
  webAdapter,
];

/**
 * Source sets per mode (spec §23):
 *  QUICK — local laws + ARLIS + main official sources, fast answer.
 *  DEEP RESEARCH — decomposition + multi-source + court practice +
 *                  Constitutional Court + HUDOC + cross-check.
 */
const QUICK_SOURCES = new Set(["arlis", "local-laws", "constitutional-court", "datalex"]);
const DEEP_SOURCES = new Set([
  "arlis",
  "local-laws",
  "constitutional-court",
  "judiciary",
  "datalex",
  "hudoc",
  "web",
]);

/** Get adapters applicable to a query+mode, sorted by authority (desc). */
export function adaptersFor(query: LegalSearchQuery, mode: SearchMode): LegalSourceAdapter[] {
  const allowed = mode === "deep" ? DEEP_SOURCES : QUICK_SOURCES;
  return ALL_ADAPTERS
    .filter((a) => allowed.has(a.id) && a.supports(query))
    .sort((a, b) => b.authority - a.authority);
}

/** All registered adapters (for diagnostics). */
export function allAdapters(): readonly LegalSourceAdapter[] {
  return ALL_ADAPTERS;
}

export function findAdapter(id: string): LegalSourceAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.id === id);
}
