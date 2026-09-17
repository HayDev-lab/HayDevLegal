// src/lib/legal-search/types.ts
// Core types for the LIVE FEDERATED LEGAL SEARCH engine.
//
// Architecture (per master spec):
//   USER QUESTION -> QUERY UNDERSTANDING -> LEGAL INTENT EXTRACTION
//   -> SEMANTIC QUERY EXPANSION -> PARALLEL LIVE SOURCE SEARCH
//   -> FETCH ORIGINAL DOCUMENTS -> PARSE + NORMALIZE
//   -> RELEVANT PASSAGE EXTRACTION -> LEGAL RERANKING
//   -> DEDUPLICATION -> TEMPORAL/SOURCE VALIDATION
//   -> EVIDENCE PACK -> AI LEGAL ANALYSIS -> VERIFIABLE CITATIONS
//
// There is NO RAG database, NO vector store, NO mirror of legal platforms.
// Every search hits the live public internet at query time.

import type { LegalQuery } from "@/lib/legal/types";

// ---------------------------------------------------------------------------
// Query side
// ---------------------------------------------------------------------------

export type SearchMode = "quick" | "deep";

/** A normalized retrieval query targeted at one or more sources. */
export type ExpandedQuery = {
  /** The query text to send to a source's search endpoint. */
  text: string;
  /** Where this variant came from (original / expansion / subquestion / multilingual). */
  origin: "original" | "act_title" | "article" | "concept" | "subquestion" | "multilingual";
  /** Target language of the variant. */
  lang: "hy" | "en" | "ru";
  /** Rough priority; lower runs first. */
  weight: number;
};

/** A legal concept detected in / derived for the query. */
export type LegalConcept = {
  /** Canonical Armenian term, e.g. "պատշաճ ծանուցում" */
  hy: string;
  /** English equivalent, e.g. "proper notification" (for HUDOC/web). */
  en?: string;
  /** Russian equivalent (secondary). */
  ru?: string;
  /** Related Armenian search phrases. */
  relatedPhrases?: string[];
  /** Source of detection: lexicon match or LLM extraction. */
  detectedBy: "lexicon" | "parser" | "llm";
};

/** Enhanced query understanding result. */
export type QueryUnderstanding = {
  /** Original parsed query (existing parser). */
  parsed: LegalQuery;
  /** Detected legal concepts. */
  concepts: LegalConcept[];
  /** Retrieval query variants. */
  variants: ExpandedQuery[];
  /** True when the query contains exact references that override expansion. */
  hasExactReference: boolean;
  /** Exact references found (article, case number, act). */
  exactReferences: {
    articles: string[];
    caseNumbers: string[];
    actTitles: string[];
  };
  /** For deep mode: legal subquestions to research separately. */
  subquestions?: string[];
  /** Multilingual variants for non-Armenian sources. */
  multilingual?: ExpandedQuery[];
};

// ---------------------------------------------------------------------------
// Search context
// ---------------------------------------------------------------------------

export type SearchContext = {
  /** Overall deadline for the whole search (epoch ms). */
  deadline: number;
  /** Per-source timeout in ms. */
  sourceTimeoutMs: number;
  /** Per-document fetch timeout in ms. */
  documentTimeoutMs: number;
  /** Search mode. */
  mode: SearchMode;
  /** Request id for tracing. */
  requestId: string;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Source adapter contract
// ---------------------------------------------------------------------------

/**
 * Status of an adapter call — never throw for expected failures.
 *
 * PARTIAL (Phase 3 §23): the source returned real metadata but the full
 * document could not be retrieved (e.g. Datalex CAPTCHA). The case EXISTS,
 * the canonical URL EXISTS — only full-text access is gated.
 */
export type SourceStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "EMPTY"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "RESTRICTED"
  | "ERROR"
  | "UNSUPPORTED";

/**
 * Phase 3 §22 — document access states. Distinct from transport errors:
 * CAPTCHA is NOT "document not found".
 */
export type AccessState =
  | "DIRECT"
  | "SESSION_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "RESTRICTED";

/**
 * Phase 3 §18 — fine-grained error classification for external calls.
 * RESTRICTED is reserved for genuine access restriction.
 */
export type ExternalErrorKind =
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "SERVER_ERROR"
  | "CLOUDFLARE_CHALLENGE"
  | "ACCESS_RESTRICTED"
  | "NOT_FOUND";

/** Phase 3 §31 — resolution strategy ladder. */
export type ResolutionMethod =
  | "DIRECT_API"
  | "DIRECT_HTML"
  | "DIRECT_PDF"
  | "ACTIVE_SESSION"
  | "OTHER_OFFICIAL_SOURCE"
  | "OFFICIAL_DOMAIN_SEARCH"
  | "WEB_DISCOVERY"
  | "SECONDARY_SOURCE"
  | "METADATA_ONLY";

export type SourceSearchOutcome = {
  status: SourceStatus;
  /** Human-readable detail for the trace UI (Armenian). */
  detail?: string;
  /** Set for RESTRICTED: a URL the user can open manually. */
  fallbackUrl?: string;
  durationMs: number;
  resultCount: number;
  /** Phase 3: document access state when status is PARTIAL/RESTRICTED. */
  accessState?: AccessState;
};

/**
 * Unified adapter contract. The engine knows nothing about site specifics.
 */
export interface LegalSourceAdapter {
  /** Stable id, e.g. "arlis". */
  id: string;
  /** Human-readable name (Armenian for UI). */
  name: string;
  /** Authority tier 0..100 (higher = more authoritative for retrieval priority). */
  authority: number;
  /** Source type label. */
  sourceType:
    | "legislation"
    | "case_law"
    | "constitutional_court"
    | "cassation"
    | "echr"
    | "web"
    | "local_laws";

  /** Whether this adapter can serve the given query. */
  supports(query: LegalSearchQuery): boolean;

  /** Optional search-timeout multiplier (slow official sites). */
  timeoutMultiplier?: number;

  /**
   * Run a live search. MUST NOT throw for expected conditions — return a
   * status instead. Only unexpected programming errors may throw.
   */
  search(
    query: LegalSearchQuery,
    context: SearchContext,
  ): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }>;

  /**
   * Fetch the original document for a result to extract passages.
   * Optional: adapters without public document access return RESTRICTED.
   *
   * Phase 3: PARTIAL + accessState communicates gated access (e.g. the
   * document exists, its metadata is valid, but a CAPTCHA/session gates
   * the full text — §22-§23).
   */
  fetchDocument?(
    result: LegalSearchResult,
    context: SearchContext,
  ): Promise<{
    status: SourceStatus;
    document?: FetchedDocument;
    accessState?: AccessState;
    /** Trace note, e.g. "full text via active session". */
    resolutionNote?: string;
  }>;
}

/** The query object passed to adapters. */
export type LegalSearchQuery = {
  /** Raw user question. */
  raw: string;
  /** Parsed + understood query. */
  understanding: QueryUnderstanding;
  /** Retrieval variants relevant to this adapter (already language-filtered). */
  variants: ExpandedQuery[];
  /** Search mode. */
  mode: SearchMode;
};

// ---------------------------------------------------------------------------
// Results & evidence
// ---------------------------------------------------------------------------

export type TemporalStatus = "current" | "historical" | "unknown";

/** A single candidate result from a live source (pre-reranking). */
export type LegalSearchResult = {
  /** Adapter id that produced this result. */
  sourceId: string;
  /** Source display name. */
  sourceName: string;
  sourceType: LegalSourceAdapter["sourceType"];
  /** Authority of the producing adapter (copied for ranking). */
  authority: number;

  title: string;
  /** Canonical URL of the original document. */
  url: string;

  /** Court name for case-law results. */
  court?: string;
  /** Case number, e.g. "ԵԴ/1234/02/21". */
  caseNumber?: string;
  /** Act number for legislation. */
  actNumber?: string;
  /** Article number when targeted. */
  article?: string;
  part?: string;
  point?: string;

  /** Dates as displayed by the source (Armenian or ISO). */
  date?: string;
  adoptionDate?: string;
  effectiveDate?: string;

  /** Status label from the source, e.g. "Գործունակ". */
  status?: string;
  temporalStatus: TemporalStatus;

  /** Short excerpt (plain text). */
  excerpt: string;
  /** Passages extracted after document fetch. */
  passages?: string[];
  /** Full fetched text (bounded). */
  fullText?: string;

  /** Phase 3 §46 — verification flags (fullTextVerified ≠ metadataVerified). */
  metadataVerified?: boolean;
  fullTextVerified?: boolean;
  /** §32-§33 — identity verified by the resolver against the FULL text. */
  identityVerified?: boolean;
  /** Phase 3 §31 — how the document text was obtained. */
  resolvedVia?: ResolutionMethod;
  /** Phase 3 §22 — current access state for gated documents. */
  accessState?: AccessState;
  /** Where the full text was actually found (when resolved via fallback). */
  resolvedViaUrl?: string;
  resolvedViaSource?: string;

  /** Best passage relevance 0..1 (set by reranker). */
  relevance: number;

  /** ISO timestamp of retrieval. */
  retrievedAt: string;
  /** sha256 of canonical text for dedup. */
  contentHash?: string;

  /** Adapter-specific internal id (e.g. ARLIS actId, Datalex case_external_id). */
  externalId?: string;

  /** Extra adapter-specific metadata (bounded, plain values only). */
  meta?: Record<string, string | number | boolean>;
};

/** A fetched original document, ready for passage extraction. */
export type FetchedDocument = {
  url: string;
  /** Extracted main legal text (HTML stripped). */
  text: string;
  /** Content type hint. */
  kind: "html" | "pdf" | "text";
  fetchedAt: string;
  bytes: number;
};

// ---------------------------------------------------------------------------
// Evidence pack
// ---------------------------------------------------------------------------

/**
 * Phase 3 §45 — evidence grades. The pack MUST distinguish:
 *   PRIMARY_VERIFIED    official source + full text verified
 *   PRIMARY_METADATA    official source, metadata only (no full text)
 *   SECONDARY_VERIFIED  non-official source + verified full text
 *   DISCOVERY_ONLY      discovered link/snippet, no verified text
 */
export type EvidenceGrade =
  | "PRIMARY_VERIFIED"
  | "PRIMARY_METADATA"
  | "SECONDARY_VERIFIED"
  | "DISCOVERY_ONLY";

/**
 * Structured evidence item the answer AI is allowed to cite.
 * The AI receives ONLY this pack — it never retrieves on its own.
 */
export type LegalEvidence = {
  /** Stable citation id, e.g. "E1". */
  id: string;
  /** Adapter id (arlis / datalex / constitutional-court / judiciary / web / local-laws). */
  source: string;
  /** Human-readable source name. */
  sourceName: string;
  sourceType: LegalSourceAdapter["sourceType"];

  title: string;
  court?: string;
  caseNumber?: string;
  actNumber?: string;
  article?: string;
  date?: string;
  /** Canonical URL of the original document (mandatory when available). */
  url: string;

  /** The most relevant extracted passage(s). */
  passage: string;

  /** Reranker relevance 0..1. */
  relevance: number;
  /** Authority of the source. */
  authority: number;
  temporalStatus: TemporalStatus;
  /** Status label from the source (Գործող / Պատմական խմբագրություն / ...). */
  statusLabel?: string;

  /** Phase 3 §45-§46 — grade + verification flags. */
  grade?: EvidenceGrade;
  fullTextVerified?: boolean;
  metadataVerified?: boolean;
  /** §32-§33 — identity verified by the resolver against the FULL text. */
  identityVerified?: boolean;
  /** Phase 3 §22/§31 — access state + resolution path for gated documents. */
  accessState?: AccessState;
  resolvedVia?: ResolutionMethod;
  /** Where the full text was actually found (fallback resolution). */
  resolvedViaUrl?: string;
  resolvedViaSource?: string;
  /** Document reference for the interactive resume flow (§64). */
  documentRef?: string;
};

// ---------------------------------------------------------------------------
// Trace & response
// ---------------------------------------------------------------------------

/** Per-capability stage outcome inside a trace entry (Phase 3 §50, §61). */
export type TraceStageStatus = "ok" | "partial" | "restricted" | "failed" | "skipped";

export type SourceTraceEntry = {
  id: string;
  name: string;
  status: SourceStatus;
  detail?: string;
  resultCount: number;
  durationMs: number;
  fallbackUrl?: string;
  /** Phase 3 §22 — access state for gated documents. */
  accessState?: AccessState;
  /**
   * Phase 3 §50 — per-stage outcomes:
   *   search    did the search endpoint respond
   *   metadata  did we get structured metadata
   *   document  full text / captcha / restricted
   */
  stages?: {
    search: TraceStageStatus;
    metadata: TraceStageStatus;
    document: TraceStageStatus;
    /** Human-readable resolution note, e.g. "full text via official source". */
    resolutionNote?: string;
  };
};

export type SearchTrace = {
  mode: SearchMode;
  sources: SourceTraceEntry[];
  expandedQueries: string[];
  subquestions?: string[];
  documentsFetched: number;
  passagesExtracted: number;
  totalDurationMs: number;
  /** Phase 3 §52 — factual retrieval completeness (no fake confidence). */
  completeness?: RetrievalCompleteness;
};

/** Phase 3 §52 — factual retrieval completeness. */
export interface RetrievalCompleteness {
  documentsFound: number;
  metadataVerified: number;
  fullTextsVerified: number;
  resolvedViaFallback: number;
  metadataOnly: number;
}

/**
 * Phase 3 §64 — a document whose full text can be unlocked through the
 * interactive source-confirmation (CAPTCHA) flow.
 */
export interface ResumableDocument {
  documentRef: string;
  source: string;
  sourceName: string;
  title: string;
  caseNumber?: string;
  url: string;
  accessState: AccessState;
}

/** Warnings surfaced to the user (temporal, conflicts, restrictions). */
export type SearchWarning = {
  kind: "temporal" | "restricted" | "conflict" | "partial";
  message: string;
};

/** Response of POST /api/search (v2). */
export type FederatedSearchResponse = {
  query: string;
  normalizedQuery: string;
  parsed?: LegalQuery;
  mode: SearchMode;
  /** Top results mapped back to the legacy LegalSource shape (UI compat). */
  results: import("@/lib/legal/types").LegalSource[];
  /** Structured evidence pack (E1..En). */
  evidence: LegalEvidence[];
  trace: SearchTrace;
  warnings: SearchWarning[];
  /** Phase 3 §52 — factual retrieval completeness. */
  completeness: RetrievalCompleteness;
  /** Phase 3 §64 — documents unlockable via the interactive resume flow. */
  resumable: ResumableDocument[];
  retrieval: {
    ok: boolean;
    durationMs: number;
    error?: string;
  };
  requestId: string;
};

// ---------------------------------------------------------------------------
// Universal Document Resolver 2.0 (Phase 3 §30)
// ---------------------------------------------------------------------------

/** What we know about a document we want the full text of. */
export interface ResolutionCandidate {
  sourceId: string;
  sourceName: string;
  sourceType: LegalSourceAdapter["sourceType"];
  authority: number;
  /** Canonical URL from the search result (never LLM-generated). */
  url: string;
  title: string;
  court?: string;
  caseNumber?: string;
  /** ECHR application number, e.g. "11275/07". */
  applicationNumber?: string;
  /** Constitutional Court decision number, e.g. "ՍԴՈ-1842". */
  sdvoNumber?: string;
  ecli?: string;
  actNumber?: string;
  article?: string;
  date?: string;
  /** Adapter-specific id (ARLIS actId, Datalex case_external_id, HUDOC itemId). */
  externalId?: string;
  excerpt?: string;
}

export type ResolutionStatus =
  | "FULL_TEXT"
  | "METADATA_ONLY"
  | "CAPTCHA_REQUIRED"
  | "RESTRICTED"
  | "NOT_FOUND"
  | "ERROR";

/** Result of resolveLegalDocument (Phase 3 §30). */
export interface ResolvedLegalDocument {
  status: ResolutionStatus;
  method: ResolutionMethod;
  accessState?: AccessState;
  /** Extracted legal text when status === FULL_TEXT. */
  text?: string;
  /** Canonical URL of the original (always from the resolver, never the LLM). */
  url: string;
  /** Phase 3 §32-§33 — identity verification outcome. */
  identityVerified: boolean;
  identitySignals: string[];
  /** Where the full text actually came from. */
  sourceName: string;
  sourceUrl?: string;
  fetchedAt: string;
  bytes?: number;
}
