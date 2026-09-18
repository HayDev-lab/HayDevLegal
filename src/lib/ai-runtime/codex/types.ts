// src/lib/ai-runtime/codex/types.ts
// CODEX CASE ANALYSIS SUBSYSTEM — Phase 4.1
// Master prompt PART D §32–§47, PART E §48–§51.
//
// The Codex subsystem performs CLOSED-EVIDENCE case analysis on an isolated
// workspace under /tmp/haydevlegal-case/<request-id>/. It never reaches the
// network (§41) and runs in read-only sandbox mode (§42). Its only input is
// a CaseAnalysisPack; its only output is a CodexCaseAnalysis JSON document
// that is checked against a verification firewall (§46) which guarantees
// every referenced evidence id exists in the supplied pack.
//
// This file is intentionally narrower than the rich research-layer types in
// `src/lib/legal-research/types.ts`. The codex prompt needs only the closed
// evidence set + the issue map; it does NOT need the full Phase-4 analysis
// graph. Keeping the surface small keeps the prompt token cost down and
// makes the closed-evidence guarantee easier to enforce.

// ---------------------------------------------------------------------------
// Research report — re-used from the Phase 4 research layer (§38 existingResearch)
// ---------------------------------------------------------------------------
//
// The existing ResearchReport carries `partial: boolean` and the full Phase-4
// analysis graph; the codex layer only needs to pass it through as optional
// prior context for the closed-evidence prompt. Importing keeps a single
// source of truth and avoids drift between the two layers.
import type { ResearchReport } from "@/lib/legal-research/types";

export type { ResearchReport };

// ---------------------------------------------------------------------------
// Evidence taxonomy (§33)
// ---------------------------------------------------------------------------

export type LegalEvidenceType =
  | "legislation"
  | "cassation"
  | "constitutional"
  | "echr"
  | "other";

// ---------------------------------------------------------------------------
// §38 — LegalEvidence: a single piece of closed evidence in the pack.
// ---------------------------------------------------------------------------

export interface LegalEvidence {
  /** Stable evidence id, e.g. "E1". Referenced by EvidenceRef.evidenceId. */
  id: string;
  /** Adapter / source label (e.g. "datalex", "arlis", "hudoc"). */
  source: string;
  /** Canonical human-readable citation (e.g. "ՔԴՕ 179" or "ՄԻԵՎԴ 11275/07"). */
  citation: string;
  /** Canonical URL of the original document (mandatory when available). */
  url?: string;
  /** ISO date string when available (decision date / enactment date). */
  date?: string;
  /** Verbatim passages extracted from the document — the only quotable text. */
  passages: string[];
  /** Taxonomy slot the evidence occupies in the pack. */
  type: LegalEvidenceType;
}

// ---------------------------------------------------------------------------
// §18–§19 — User-asserted facts (codex-local, narrower than the research layer)
// ---------------------------------------------------------------------------

export interface UserCaseFact {
  id: string;
  /** Plain-language description of the fact alleged by the user. */
  description: string;
  /** Codex pack facts are always user-sourced (no auto-promotion to proven). */
  source: "user";
  /** Whether the fact is currently supported by evidence in the pack. */
  supported: boolean;
}

// ---------------------------------------------------------------------------
// Chronology — optional timeline reconstructed from the user's facts.
// ---------------------------------------------------------------------------

export interface ChronologyEvent {
  id: string;
  /** ISO date string when available; otherwise undefined. */
  date?: string;
  /** Plain-language description of the event. */
  event: string;
  /** Evidence id backing this event, when one exists in the pack. */
  evidenceId?: string;
}

// ---------------------------------------------------------------------------
// §38 — Legal issues the user wants analyzed.
// ---------------------------------------------------------------------------

export interface LegalIssue {
  id: string;
  /** Short statement of the legal issue (one sentence). */
  statement: string;
  /** Evidence ids in the pack already known to bear on this issue. */
  relatedEvidence: string[];
}

// ---------------------------------------------------------------------------
// Evidence reference — the ONLY permissible citation shape in codex output.
// §40 — every evidenceId MUST exist in the supplied pack.
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  evidenceId: string;
  /** Verbatim quote drawn from that evidence's passages (optional but encouraged). */
  quote?: string;
  /** Section / article label inside the source document (optional). */
  section?: string;
}

// ---------------------------------------------------------------------------
// §38 — CaseAnalysisPack: the closed input bundle handed to the codex CLI.
// ---------------------------------------------------------------------------

export interface CaseAnalysisPack {
  /** Original user question. */
  query: string;
  userFacts: UserCaseFact[];
  chronology?: ChronologyEvent[];
  issues: LegalIssue[];
  legislation: LegalEvidence[];
  cassationCases: LegalEvidence[];
  constitutionalCases: LegalEvidence[];
  echrCases: LegalEvidence[];
  otherEvidence: LegalEvidence[];
  /** Optional Phase-4 research already performed — passed through as context. */
  existingResearch?: ResearchReport;
}

// ---------------------------------------------------------------------------
// §45 — CodexCaseAnalysis output shape.
// ---------------------------------------------------------------------------

export type ApplicabilityVerdict =
  | "DIRECT"
  | "WITH_DISTINCTIONS"
  | "ANALOGICAL"
  | "NOT_APPLICABLE";

export interface ApplicablePrecedent {
  evidenceId: string;
  /** The rule / holding extracted from the precedent (grounded in passages). */
  holding: string;
  /** Factual similarities to the user's case. */
  similarities: string[];
  /** Factual distinctions that may weaken applicability. */
  distinguishingFactors: string[];
  /** Codex applicability verdict. */
  applicability: ApplicabilityVerdict;
}

export interface IssueAnalysis {
  /** Matches a LegalIssue.id from the input pack. */
  issueId: string;
  governingRules: EvidenceRef[];
  applicablePrecedents: ApplicablePrecedent[];
  counterAuthorities: EvidenceRef[];
  /** Open questions the pack cannot resolve with the supplied evidence. */
  unresolvedQuestions: string[];
}

export interface ArgumentMapEntry {
  /** Proposition advanced by the analysis. */
  proposition: string;
  /** Evidence supporting the proposition. */
  support: EvidenceRef[];
  /** Evidence countering the proposition. */
  counter: EvidenceRef[];
  /** Limitations / caveats on the proposition. */
  limitations: string[];
}

export interface CodexCaseAnalysis {
  issues: IssueAnalysis[];
  argumentMap: ArgumentMapEntry[];
  /** Material facts the pack cannot establish — surfaces research debt. */
  missingMaterialFacts: string[];
  /** §40 — additional authorities needed but NOT invented (honest research debt). */
  additionalResearchNeeded: string[];
  /** Final synthesis paragraph tying the analysis together. */
  synthesis: string;
}

// ---------------------------------------------------------------------------
// §43 — Workspace descriptor returned by createWorkspace().
// ---------------------------------------------------------------------------

export interface CodexWorkspace {
  /** Absolute path under /tmp/haydevlegal-case/<request-id>/. */
  rootDir: string;
  /** Relative path → file content map for the files written. */
  files: Record<string, string>;
}
