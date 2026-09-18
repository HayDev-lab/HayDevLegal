// src/lib/legal-search/config.ts
// Centralized, environment-tunable configuration for the federated search engine.
// NO magic weights scattered across the codebase — everything lives here.

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
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

// ---------------------------------------------------------------------------
// Phase 4 — research intelligence analysis budget (master prompt §71, §72).
//   80 candidates -> rerank -> 10 docs -> role classification ->
//   6-8 strongest authorities -> deep applicability.
// ---------------------------------------------------------------------------

export const ANALYSIS = {
  /** §72 — max precedents entering deep applicability analysis. */
  maxPrecedentsAnalyzed: envInt("ANALYSIS_MAX_PRECEDENTS", 8),
  /** §71 — max verified holdings kept per document. */
  maxHoldingsPerDocument: envInt("ANALYSIS_MAX_HOLDINGS", 3),
  /** §71 — max precedent relations followed per request. */
  maxRelationsFollowed: envInt("ANALYSIS_MAX_RELATIONS", 6),
  /** §71 — max counter-authorities surfaced in the argument map. */
  maxCounterAuthorities: envInt("ANALYSIS_MAX_COUNTER_AUTHORITIES", 4),
  /** §105 — whole-pipeline budget for the research layer (deep mode). */
  timeBudgetMs: envInt("ANALYSIS_TIME_BUDGET_MS", 24_000),
  /** §106 — max concurrent LLM analysis calls. */
  maxConcurrentLlmCalls: envInt("ANALYSIS_MAX_CONCURRENT_LLM", 2),
  /** §75-§76 — bounded retries for structured LLM output; then fail closed. */
  llmMaxRetries: 1,
  /** §73 — analysis cache keyed by contentHash + analysis version. */
  cacheVersion: "4.0.0",
  cacheSize: 64,
  /** §70 — bounded second research pass when temporal risks are flagged. */
  secondPassMaxQueries: 2,
  secondPassTimeoutMs: 6_000,
} as const;

// ---------------------------------------------------------------------------
// Phase 4.1 — Security hotfixes (master prompt Part A §4–§14).
// ---------------------------------------------------------------------------

/**
 * §5 — maximum number of HTTP redirects the SSRF-aware fetchGuarded will
 * follow manually. Each redirect hostname goes through FRESH DNS validation
 * (no trust is carried). Exceeding this limit raises a `redirect_limit`
 * UrlPolicyError. Default 5 (env-tunable).
 */
export const MAX_REDIRECTS = envInt("URL_POLICY_MAX_REDIRECTS", 5);

/**
 * §11–§12 — application-level per-IP rate limits (in-memory token-bucket).
 * Single-instance deployment; the abstraction is swappable for an external
 * store later. Limits are expressed per minute (windowMs = 60s).
 *
 * Categories (§12) — QA is the strictest by design.
 */
export const RATE_LIMIT = {
  windowMs: 60_000,
  categories: {
    quick_search: { capacity: envInt("RATE_LIMIT_QUICK_SEARCH", 60) },
    deep_search: { capacity: envInt("RATE_LIMIT_DEEP_SEARCH", 10) },
    answer: { capacity: envInt("RATE_LIMIT_ANSWER", 20) },
    resolve: { capacity: envInt("RATE_LIMIT_RESOLVE", 30) },
    qa: { capacity: envInt("RATE_LIMIT_QA", 5) },
  },
  /** Periodic prune of stale entries (ms). */
  pruneIntervalMs: 5 * 60_000,
  /** Entries older than this are prunable (ms). */
  entryTtlMs: 10 * 60_000,
} as const;

/**
 * §9–§10 — QA endpoint guard. Routes under /api/test/* are hidden from
 * production unless explicitly enabled AND a bearer token matches.
 *
 *   LEGAL_QA_ENABLED  (default: false in production)
 *   LEGAL_QA_TOKEN    server-side secret; never sent to the frontend
 */
export const QA = {
  enabled: envBool("LEGAL_QA_ENABLED", false),
  token: envStr("LEGAL_QA_TOKEN", ""),
} as const;
