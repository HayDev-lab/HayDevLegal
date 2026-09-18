// src/lib/legal-drafting/index.ts
// Phase 6 — Verified Legal Document Drafting Engine — public surface.
//
// Master prompt PART F §5–§15. The drafting engine drafts ONLY from
// verified case / research material — never "LLM, write a complaint."
//
// Pipeline (§5):
//   1. buildDraftingContext(caseId, opts)  → DraftingContext + SourceIdMap
//   2. buildDocumentPlan(draftId, ctx, type, goal) → DocumentPlan
//   3. assembleDeterministicSections(draftId, plan, ctx) → DraftSection[]
//      (header, procedural_history, attachments, applicable_law reference list)
//   4. assembleFactSection / assembleLegalSection / assemblePrecedentSection
//      / assembleLegalIssuesSection / assembleArgumentSection
//      / assembleCounterargumentSection / assembleRequestSection
//      → deterministic, no-AI sections
//   5. draftWithCodex(...) → AI-only prose sections (closed evidence).
//      If AUTH_REQUIRED / RATE_LIMITED → BLOCKED_EXTERNAL_QUOTA — the
//      deterministic assemblers cover every mechanical section.
//   6. draftWithFallback(...) → optional Z-AI / Ollama fallback (disabled by
//      default per §15 — operator must enable explicitly).
//
// §9 / §10 / §11 / §13 / §14 / §15 correctness rules are enforced throughout.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  AiDraftTask,
  ApplicabilityVerdict,
  CreatedBy,
  DraftingArgumentEntry,
  DraftingCassationCase,
  DraftingChronologyEvent,
  DraftingConCourtCase,
  DraftingContext,
  DraftingEchrCase,
  DraftingEvidenceRef,
  DraftingFact,
  DraftingLegalIssue,
  DraftingLegislation,
  DraftLanguage,
  DraftOperationResult,
  DraftOperationStatus,
  DraftSection,
  DraftSectionContent,
  DraftStatus,
  DocumentPlan,
  DocumentPlanSection,
  DocumentType,
  DocumentTypeSpec,
  EvidenceRefSummary,
  FactStatus,
  InternalSourceId,
  ReviewStatus,
  SectionType,
  SectionWarning,
  SourceIdMap,
  SourceIdMapEntry,
  VerificationAssertion,
  VerificationResult,
} from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export {
  CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION,
  CODEX_DRAFT_MAX_TOKENS,
  CODEX_DRAFT_TIMEOUT_MS,
  DRAFT_STORAGE_ROOT,
  FALLBACK_DRAFT_MAX_TOKENS,
  FALLBACK_DRAFT_TIMEOUT_MS,
  FALLBACK_DRAFTER_ENABLED,
  MAX_CASSATION_CASES,
  MAX_CHRONOLOGY_IN_CONTEXT,
  MAX_CONCOURT_CASES,
  MAX_DRAFT_VERSIONS,
  MAX_ECHR_CASES,
  MAX_EVIDENCE_REFS,
  MAX_FACTS_IN_CONTEXT,
  MAX_LEGISLATION,
  MAX_PASSAGES_PER_AUTHORITY,
  MAX_TOTAL_CONTEXT_CHARS,
} from "./config";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export {
  DOCUMENT_TYPE_REGISTRY,
  allSectionsForType,
  getDocumentTypeSpec,
  validateDraftMetadata,
} from "./registry/document-types";

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export {
  buildDraftingContext,
  type BuildDraftingContextOptions,
  type BuildDraftingContextResult,
} from "./planning/drafting-context";
export { buildDocumentPlan } from "./planning/document-plan";
export { selectIssuesForDraft } from "./planning/issue-selection";

// ---------------------------------------------------------------------------
// Assembly (deterministic — no AI)
// ---------------------------------------------------------------------------

export {
  assembleAttachmentsSection,
  assembleChronologyTableSection,
  assembleDeterministicSections,
  assembleHeaderSection,
  assembleReferenceListSection,
} from "./assembly/deterministic-sections";
export { assembleFactSection } from "./assembly/fact-sections";
export {
  assembleLegalIssuesSection,
  assembleLegalSection,
  assemblePrecedentSection,
} from "./assembly/legal-sections";
export {
  assembleArgumentSection,
  assembleCounterargumentSection,
} from "./assembly/argument-sections";
export { assembleRequestSection } from "./assembly/request-sections";

// ---------------------------------------------------------------------------
// Generation (AI — closed evidence)
// ---------------------------------------------------------------------------

export {
  draftWithCodex,
  AiDraftSectionSchema as AiDraftSectionSchemaCodex,
  type AiDraftSection as AiDraftSectionCodex,
} from "./generation/codex-drafter";
export {
  draftWithFallback,
  AiDraftSectionSchema as AiDraftSectionSchemaFallback,
  type AiDraftSection as AiDraftSectionFallback,
} from "./generation/fallback-drafter";
