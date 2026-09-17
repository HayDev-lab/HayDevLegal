// src/lib/legal-search/config.ts
// Centralized, environment-tunable configuration for the federated search engine.
// NO magic weights scattered across the codebase — everything lives here.

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// ---------------------------------------------------------------------------
// Timeouts (spec §13)
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  /** Per-source search timeout. */
  sourceMs: envInt("SEARCH_SOURCE_TIMEOUT_MS", 9_000),
  /** Per-document fetch timeout. */
  documentMs: envInt("DOCUMENT_FETCH_TIMEOUT_MS", 12_000),
  /** Whole-search budget for quick mode. */
  quickTotalMs: envInt("TOTAL_SEARCH_TIMEOUT_MS", 20_000),
  /** Whole-search budget for deep mode. */
  deepTotalMs: envInt("TOTAL_DEEP_SEARCH_TIMEOUT_MS", 55_000),
  /** LLM query-understanding budget (deep mode). */
  llmUnderstandingMs: envInt("LLM_UNDERSTANDING_TIMEOUT_MS", 20_000),
} as const;

// ---------------------------------------------------------------------------
// Staged retrieval sizes (spec §14)
// ---------------------------------------------------------------------------

export const STAGES = {
  /** Stage 1: max lightweight candidates kept per source. */
  candidatesPerSource: envInt("STAGE_CANDIDATES_PER_SOURCE", 12),
  /** Stage 1: max total candidates entering reranking. */
  maxCandidates: envInt("STAGE_MAX_CANDIDATES", 60),
  /** Stage 2: candidates kept after reranking. */
  rerankKeep: envInt("STAGE_RERANK_KEEP", 15),
  /** Stage 3: documents fetched for passage extraction (quick mode). */
  quickFetchDocs: envInt("STAGE_QUICK_FETCH_DOCS", 5),
  /** Stage 3: documents fetched for passage extraction (deep mode). */
  deepFetchDocs: envInt("STAGE_DEEP_FETCH_DOCS", 10),
  /** Stage 4: evidence pack size. */
  evidencePackSize: envInt("EVIDENCE_PACK_SIZE", 8),
  /** Max characters per evidence passage. */
  passageMaxChars: 1600,
  /** Max characters of an evidence passage sent to the AI. */
  evidenceTextBudget: 26_000,
} as const;

// ---------------------------------------------------------------------------
// Legal reranking weights (spec §16)
//   finalScore = exactReference + lexicalRelevance + semanticConceptRelevance
//              + authority + temporalRelevance + citationQuality
// ---------------------------------------------------------------------------

export const RANK_WEIGHTS = {
  exactReference: 100,
  lexicalRelevance: 60,
  semanticConceptRelevance: 50,
  authority: 40,
  temporalRelevance: 25,
  citationQuality: 20,
} as const;

/** Sub-weights inside each component. */
export const RANK_SUB = {
  // lexical
  titleTokenOverlap: 30,
  bodyKeywordMatch: 20,
  exactPhraseMatch: 25,
  // concept
  conceptInTitle: 25,
  conceptInPassage: 30,
  // authority multipliers are in AUTHORITY constants
  // temporal
  currentStatusBonus: 20,
  historicalPenalty: -10,
  // citation quality
  hasCanonicalUrl: 8,
  hasPassageText: 12,
  hasCaseNumber: 6,
  hasDate: 4,
} as const;

// ---------------------------------------------------------------------------
// Source authority hierarchy (spec §17)
//   OFFICIAL LEGISLATION > OFFICIAL COURT > OFFICIAL CONSTITUTIONAL COURT
//   > OFFICIAL HUDOC > REPUTABLE LEGAL DATABASE > SECONDARY > GENERAL WEB
// NOTE: authority affects RETRIEVAL PRIORITY, not legal correctness.
// ---------------------------------------------------------------------------

export const AUTHORITY = {
  officialLegislation: 100, // ARLIS (official legal information system)
  officialConstitutionalCourt: 95, // concourt.am
  officialCourt: 90, // Cassation precedents (via Datalex official mirror)
  officialHudoc: 85, // HUDOC (when accessible)
  reputableLegalDatabase: 75, // Datalex (judicial info system)
  localCuratedLaws: 70, // curated local corpus (needs online cross-check)
  secondaryLegalMaterial: 40, // reputable secondary sources
  generalWeb: 20, // general web results
} as const;

// ---------------------------------------------------------------------------
// Concurrency & politeness
// ---------------------------------------------------------------------------

export const POLICY = {
  /** Max concurrent document fetches. */
  maxConcurrentFetches: 5,
  /** Max expanded queries per search (explosion limiter, spec §9). */
  maxExpandedQueries: 8,
  /** Max expanded queries in deep mode. */
  maxDeepExpandedQueries: 12,
  /** Max subquestions from LLM decomposition. */
  maxSubquestions: 7,
  /** User agent presented to public sources. */
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 HayDevLegal/1.0 (+legal search)",
} as const;

// ---------------------------------------------------------------------------
// Canonical origins of the sources we fetch from (SSRF allowlist for docs).
// ---------------------------------------------------------------------------

export const SOURCE_ORIGINS = {
  arlis: ["https://arlis.am", "https://www.arlis.am"],
  concourt: ["https://concourt.am", "https://www.concourt.am"],
  datalex: ["https://datalex.am", "https://www.datalex.am"],
} as const;

// ---------------------------------------------------------------------------
// Phase 3 — Full-document resolution (§55-§60). All knobs live here.
// ---------------------------------------------------------------------------

export const RESOLUTION = {
  /** §38 — max research passes (PASS 1 retrieval + PASS 2 reference following). */
  maxResearchPasses: envInt("RESOLUTION_MAX_PASSES", 2),
  /** §38 — max exact references followed in PASS 2. */
  maxReferenceFollows: envInt("RESOLUTION_MAX_REF_FOLLOWS", 4),
  /** §60 — bounded document cache (LRU) for the request/session. */
  documentCacheSize: 64,
  documentCacheTtlMs: 10 * 60 * 1000,
  /** §59 — request coalescing window per unique document. */
  coalesceWindowMs: 30_000,
  /** §57 — HUDOC endpoint response profile differs; keep separate. */
  hudocTimeoutMs: envInt("HUDOC_TIMEOUT_MS", 8_000),
  /** §58 — bounded PDF maximum (never download 200 MB for one passage). */
  pdfMaxBytes: envInt("RESOLUTION_PDF_MAX_BYTES", 8 * 1024 * 1024),
  /** §65-§66 — web discovery result caps for targeted resolution. */
  webDiscoveryResults: 6,
  officialDomainSearchResults: 5,
  /** §33 — identity signals required for strong (non-identifier) acceptance. */
  strongIdentityMinSignals: 2,
  /** Interactive resume flow (§64): resolution token TTL + max outstanding. */
  resumeTokenTtlMs: 10 * 60 * 1000,
  maxResumeTokens: 32,
} as const;

/** Official Armenian legal domains for targeted discovery (§66). */
export const OFFICIAL_DOMAINS = [
  "arlis.am",
  "concourt.am",
  "datalex.am",
  "court.am",
  "judiciary.am",
  "parliament.am",
  "gov.am",
  "minjust.am",
  "echr.coe.int",
] as const;

// ---------------------------------------------------------------------------
// Phase 3 — concurrency (§55). Single source of truth.
// ---------------------------------------------------------------------------

export const CONCURRENCY = {
  maxConcurrentSourceSearches: envInt("CONC_MAX_SOURCE_SEARCHES", 4),
  maxConcurrentDocumentFetches: envInt("CONC_MAX_DOC_FETCHES", 3),
  maxConcurrentPassageExtractions: envInt("CONC_MAX_PASSAGES", 4),
  defaultPerDomain: 2,
  perSource: {
    arlis: 2,
    datalex: 1,
    constitutionalCourt: 2,
    judiciary: 1,
    hudoc: 2,
    web: 2,
  } as Record<string, number>,
} as const;

// ---------------------------------------------------------------------------
// Phase 3 — session store bounds (§26-§27).
// ---------------------------------------------------------------------------

export const SESSION_STORE = {
  maxSessions: 16,
  defaultTtlMs: 20 * 60 * 1000,
  /** Solved CAPTCHA keys are short-lived by design. */
  captchaKeyTtlMs: 15 * 60 * 1000,
} as const;
