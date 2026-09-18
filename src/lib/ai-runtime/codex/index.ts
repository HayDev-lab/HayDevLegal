// src/lib/ai-runtime/codex/index.ts
// Public surface of the Codex case-analysis subsystem.
//
// Phase 4.1 master prompt PART D §32–§47, PART E §48–§51.
//
// Task 2's Codex providers (`src/lib/ai-runtime/providers/codex-sdk.ts` and
// `codex-cli.ts`) import the CaseAnalysisPack / CodexCaseAnalysis types and
// the constants declared here when constructing the codex CLI invocation.
//
// Exports:
//   Types           — CaseAnalysisPack, CodexCaseAnalysis, EvidenceRef, …
//   Schema          — CodexCaseAnalysisSchema (ZodType<CodexCaseAnalysis>)
//   Prompt builder  — buildCasePrompt(pack) → { system, user }
//   Workspace       — createWorkspace, readWorkspaceOutput, cleanupWorkspace,
//                     verifyNoRepositoryMutation
//   Firewall        — validateCodexOutput(analysis, pack) → { ok: true } |
//                                                 { ok: false, reason }
//   Constants       — CODEX_NETWORK_ACCESS, CODEX_WEB_SEARCH, CODEX_SANDBOX_MODE
//                     (consumed by Task 2's providers when invoking codex).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  CaseAnalysisPack,
  CodexCaseAnalysis,
  EvidenceRef,
  LegalIssue,
  UserCaseFact,
  ChronologyEvent,
  LegalEvidence,
  LegalEvidenceType,
  ApplicabilityVerdict,
  ApplicablePrecedent,
  IssueAnalysis,
  ArgumentMapEntry,
  CodexWorkspace,
  ResearchReport,
} from "./types";

// ---------------------------------------------------------------------------
// Schema + firewall
// ---------------------------------------------------------------------------

export {
  CodexCaseAnalysisSchema,
  validateCodexOutput,
  allPackEvidence,
  type CodexOutputValidation,
} from "./case-analysis-schema";

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export {
  CLOSED_EVIDENCE_SYSTEM_PROMPT,
  buildCasePrompt,
  type CodexPrompt,
} from "./closed-evidence-prompt";

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

export {
  createWorkspace,
  readWorkspaceOutput,
  cleanupWorkspace,
  verifyNoRepositoryMutation,
} from "./workspace";

// ---------------------------------------------------------------------------
// §41–§42 — Network + sandbox config (consumed by Task 2's Codex providers).
//
// These are exported as `as const` literals so callers can branch on the
// string value at compile time if they wish. They MUST stay disabled /
// read-only for the closed-evidence guarantee to hold — see the closed-
// evidence system prompt (§40) which forbids the model from introducing
// authorities not in the supplied pack.
// ---------------------------------------------------------------------------

export const CODEX_NETWORK_ACCESS = "disabled" as const; // §41
export const CODEX_WEB_SEARCH = "disabled" as const; // §41
export const CODEX_SANDBOX_MODE = "read-only" as const; // §42
