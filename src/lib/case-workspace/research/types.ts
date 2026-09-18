// src/lib/case-workspace/research/types.ts
// Local types for the Case Workspace Research + Analysis + Search + Evaluation
// layer (Task 14-C / Phase 5 §13–§20).
//
// These types sit on top of:
//   - Subagent A's case-workspace Prisma types (`@/lib/case-workspace/types`)
//   - Subagent A's case-workspace JSON-serialized fields (LegalReferenceEntry
//     in LegalIssueLink.relatedLaw / relatedPrecedents).
//   - The existing Phase 4.1 Codex subsystem types
//     (`@/lib/ai-runtime/codex/types`) — CaseAnalysisPack, CodexCaseAnalysis,
//     EvidenceRef (codex pack shape), ApplicablePrecedent, etc.
//
// Nothing here redefines CaseAnalysisPack or CodexCaseAnalysis — those remain
// the single source of truth in `codex/types.ts`. We only declare the local
// status enums + the deterministic analysis shape that mirrors CodexCaseAnalysis
// with a `deterministic: true` flag (§26).

import type { CodexCaseAnalysis } from "@/lib/ai-runtime/codex/types";
import type { LegalReferenceEntry, EvidenceRef } from "@/lib/case-workspace/types";

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

/** Per §13 — federated search outcome for a case issue. */
export type ResearchStatus =
  | "COMPLETED"
  | "PARTIAL_AI_UNAVAILABLE"
  | "DETERMINISTIC_ONLY"
  | "FAILED";

/** Per §15 — Codex case-analysis operation outcome. */
export type AnalysisOperationStatus =
  | "SUCCESS"
  | "SUCCESS_EMPTY"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_SCHEMA"
  | "ERROR"
  | "BLOCKED_EXTERNAL_QUOTA";

/** Per §15 — final status persisted to CaseAnalysisResult.status. */
export type CaseAnalysisResultStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "BLOCKED_EXTERNAL_QUOTA"
  | "FAILED";

// ---------------------------------------------------------------------------
// Research outputs
// ---------------------------------------------------------------------------

/** Result bundle for `researchIssueForCase`. */
export interface CaseResearchResult {
  /** Phase-4 ResearchReport from the federated search (null on FAILED). */
  report: import("@/lib/legal-research/types").ResearchReport | null;
  /** Legal authority entries (laws) to persist into LegalIssueLink.relatedLaw. */
  relatedLaw: LegalReferenceEntry[];
  /** Legal authority entries (precedents) to persist into LegalIssueLink.relatedPrecedents. */
  relatedPrecedents: LegalReferenceEntry[];
  status: ResearchStatus;
}

// ---------------------------------------------------------------------------
// Precedent linker
// ---------------------------------------------------------------------------

/**
 * Result of `linkPrecedents`.
 * `counterAuthorities` uses the CODEX pack EvidenceRef shape (evidenceId +
 * optional quote) since the linker runs on pack-internal ids (§13).
 */
export interface PrecedentLinkResult {
  precedents: import("@/lib/ai-runtime/codex/types").ApplicablePrecedent[];
  counterAuthorities: import("@/lib/ai-runtime/codex/types").EvidenceRef[];
  distinguishingFactors: string[];
}

// ---------------------------------------------------------------------------
// Deterministic analysis (§26 — no LLM fallback)
// ---------------------------------------------------------------------------

/**
 * DeterministicCaseAnalysis — same shape as CodexCaseAnalysis, with a
 * `deterministic: true` flag. Per §26: produced when Codex is unavailable
 * so the user still gets a structural analysis (issues / argument map /
 * missing material facts / additional research needed / synthesis).
 */
export interface DeterministicCaseAnalysis extends CodexCaseAnalysis {
  deterministic: true;
}

// ---------------------------------------------------------------------------
// Codex analysis operation result
// ---------------------------------------------------------------------------

export interface CodexAnalysisResult {
  analysis: import("@/lib/ai-runtime/codex/types").CodexCaseAnalysis | null;
  status: AnalysisOperationStatus;
  provider?: import("@/lib/ai-runtime/types").AiProviderId;
  errorDetail?: string;
}

// ---------------------------------------------------------------------------
// Search (§13 — no RAG, no vector DB)
// ---------------------------------------------------------------------------

export interface CaseSearchHit {
  documentId: string;
  pageNumber: number;
  /** Short verbatim snippet (≤ 200 chars) surrounding the match. */
  snippet: string;
  /** 0..1 relevance score (exact phrase > all tokens > any token). */
  score: number;
  /** Where the hit came from — drives UI navigation (§17). */
  source:
    | "page_text"
    | "filename"
    | "entity"
    | "fact"
    | "claim"
    | "chronology";
  /** Optional label for non-page hits (entity name, fact category, etc.). */
  label?: string;
}

export interface CaseSearchResult {
  hits: CaseSearchHit[];
  total: number;
  /** "fts5" when the SQLite FTS5 virtual table path was used; "like" otherwise. */
  engine: "fts5" | "like";
}

// ---------------------------------------------------------------------------
// Evaluation (§20)
// ---------------------------------------------------------------------------

export interface CaseGoldFixture {
  id: string;
  name: string;
  description: string;
  /** Descriptive setup steps (the test harness generates data from these). */
  setupSteps: string[];
  /** Descriptive assertions — what the test should check. */
  assertions: string[];
}

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface EvalResult {
  passed: boolean;
  checks: EvalCheck[];
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Parse a JSON string field, returning `fallback` on failure. */
export function parseJsonField<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Convenience: parse a LegalIssueLink row from Prisma into its typed form. */
export interface LegalIssueLinkRow {
  id: string;
  caseId: string;
  issueId: string;
  issueStatement: string;
  factIds: string[];
  evidenceRefs: EvidenceRef[];
  relatedLaw: LegalReferenceEntry[];
  relatedPrecedents: LegalReferenceEntry[];
}

/** Map a Prisma `legalIssueLink` row to the typed shape (parses JSON fields). */
export function parseLegalIssueLink(row: {
  id: string;
  caseId: string;
  issueId: string;
  issueStatement: string;
  factIds: string;
  evidenceRefs: string;
  relatedLaw: string;
  relatedPrecedents: string;
  createdAt: Date;
  updatedAt: Date;
}): LegalIssueLinkRow {
  return {
    id: row.id,
    caseId: row.caseId,
    issueId: row.issueId,
    issueStatement: row.issueStatement,
    factIds: parseJsonField<string[]>(row.factIds, []),
    evidenceRefs: parseJsonField<EvidenceRef[]>(row.evidenceRefs, []),
    relatedLaw: parseJsonField<LegalReferenceEntry[]>(row.relatedLaw, []),
    relatedPrecedents: parseJsonField<LegalReferenceEntry[]>(
      row.relatedPrecedents,
      [],
    ),
  };
}
