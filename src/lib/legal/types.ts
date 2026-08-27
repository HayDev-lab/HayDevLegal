// src/lib/legal/types.ts
// Core legal domain types for the Armenian Legal Search application.

/**
 * A single primary legal source retrieved from ARLIS.
 * The agent receives an array of these as grounding evidence.
 */
export type LegalSource = {
  /** Stable internal ID used for citation, e.g. "S1" */
  id: string;
  /** Always "ARLIS" in v1 */
  source: "ARLIS";

  title: string;
  canonicalUrl: string;

  /** ARLIS numeric act id, e.g. "6" */
  actId?: string;
  /** Document number if ARLIS exposed one */
  actNumber?: string;

  /** Article number when the query targeted a specific article */
  article?: string;
  /** Part within article, when detected */
  part?: string;
  /** Point within part, when detected */
  point?: string;

  /** Status label, e.g. "Գործունակ" / "Չի գործունակ" */
  status?: string;

  /** Adoption date string as shown by ARLIS */
  adoptionDate?: string;
  /** Effective date string as shown by ARLIS */
  effectiveDate?: string;

  /** Short relevant excerpt (plain text, no HTML) */
  excerpt: string;
  /** Longer retrieved source text (article body) when available */
  fullRetrievedText?: string;

  /** ISO timestamp of retrieval */
  retrievedAt: string;

  /** sha256 of the canonical text, for dedup */
  contentHash?: string;

  /** Deterministic relevance score 0..1 (normalised) */
  relevanceScore: number;

  /** Optional human-readable source label: Օրենսդրություն / Վճռաբեկ դատարան / ... */
  sourceLabel?: SourceLabel;
};

export type SourceLabel =
  | "Օրենսդրություն"
  | "Վճռաբեկ դատարան"
  | "Սահմանադրական դատարան"
  | "ՄԻԵՎԴ"
  | "Իրավական ակտ";

export type QuestionType =
  | "exact_article"
  | "legal_rule"
  | "case_law"
  | "definition"
  | "procedure"
  | "unknown";

/**
 * Structured representation of a user's legal query.
 */
export type LegalQuery = {
  raw: string;
  normalized: string;

  actTitle?: string;
  actType?: string;

  article?: string;
  part?: string;
  point?: string;

  caseNumber?: string;

  keywords: string[];

  date?: string;

  wantsCurrentLaw: boolean;
  wantsHistoricalLaw: boolean;

  questionType: QuestionType;
};

/** Response shape of the /api/search endpoint. */
export type SearchResponse = {
  query: string;
  normalizedQuery: string;
  parsed?: LegalQuery;
  results: LegalSource[];
  /** ARLIS retrieval status for telemetry / UX */
  retrieval: {
    ok: boolean;
    durationMs: number;
    error?: string;
    fromCache?: boolean;
  };
  requestId: string;
};

/** A single streamed chunk from /api/answer. */
export type AnswerChunk =
  | { type: "delta"; text: string }
  | { type: "done"; requestId: string; citations: CitationRef[] }
  | { type: "error"; message: string; requestId: string };

export type CitationRef = {
  /** "S1".."S4" */
  id: string;
  title: string;
  url: string;
};
