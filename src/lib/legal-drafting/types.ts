// src/lib/legal-drafting/types.ts
// Phase 6 — Verified Legal Document Drafting Engine — public type surface.
//
// Master prompt PART F §5–§15. These types mirror the Prisma models in
// `prisma/schema.prisma` (LegalDraft / DraftVersion / DraftSection) and add
// the in-memory interfaces the drafting engine needs at runtime.
//
// CRITICAL CORRECTNESS RULES enforced everywhere downstream:
//   §9  — Draft language must reflect fact status. Never write "established"
//          for an ALLEGED fact.
//   §10 — Internal source IDs (F1, CE4, L2, C3, CC1, E5, A2) are used by the
//          AI internally while drafting. Normal export renders human-readable
//          citations through the SourceIdMap.
//   §11 — Never invent court / address / case number. Unknown stays unknown.
//   §13 — Mechanical fields (case number, parties, court, title, dates,
//          attachment list, verified chronology table, reference list) are
//          produced DETERMINISTICALLY — never via LLM.
//   §14 — The AI may not introduce new factual or legal sources. It can only
//          reorganize, transition, and compare what is in the closed context.
//   §15 — Closed evidence. Network / web disabled. Read-only. If support is
//          missing → [SUPPORT_REQUIRED]. If material information is missing
//          → [MISSING_INFORMATION].

// ---------------------------------------------------------------------------
// §5 — Document types
// ---------------------------------------------------------------------------

export type DocumentType =
  | "MOTION"
  | "OBJECTION"
  | "CLAIM"
  | "RESPONSE"
  | "APPEAL"
  | "CASSATION_APPEAL"
  | "CONSTITUTIONAL_COMPLAINT"
  | "ECHR_APPLICATION_SUPPORT"
  | "LEGAL_MEMORANDUM"
  | "FACTUAL_STATEMENT"
  | "REQUEST_TO_AUTHORITY"
  | "OTHER";

// ---------------------------------------------------------------------------
// §7 — Draft lifecycle statuses
// ---------------------------------------------------------------------------

export type DraftStatus =
  | "PLANNING"
  | "DRAFTING"
  | "VERIFYING"
  | "NEEDS_REVIEW"
  | "VERIFIED"
  | "EXPORT_READY"
  | "ARCHIVED";

// ---------------------------------------------------------------------------
// §7 — Draft language
// ---------------------------------------------------------------------------

export type DraftLanguage = "hy" | "ru" | "en";

// ---------------------------------------------------------------------------
// §7 — CreatedBy (version authorship)
// ---------------------------------------------------------------------------

export type CreatedBy = "SYSTEM" | "USER" | "AI";

// ---------------------------------------------------------------------------
// §12 — Section types
// ---------------------------------------------------------------------------

export type SectionType =
  | "header"
  | "introduction"
  | "procedural_history"
  | "facts"
  | "legal_issues"
  | "applicable_law"
  | "precedents"
  | "arguments"
  | "counterarguments"
  | "requested_relief"
  | "attachments"
  | "missing_information";

// ---------------------------------------------------------------------------
// §23 — Per-section review status
// ---------------------------------------------------------------------------

export type ReviewStatus =
  | "UNREVIEWED"
  | "AI_DRAFTED"
  | "VERIFIED"
  | "NEEDS_SUPPORT"
  | "USER_EDITED"
  | "REJECTED";

// ---------------------------------------------------------------------------
// §9 — Fact status (mirrors case-workspace FactStatus, extended with
// DOCUMENT_VERIFIED and USER_CONFIRMED — these distinguish documentary
// verification from human-only confirmation per Phase 5.1 §13).
// ---------------------------------------------------------------------------

export type FactStatus =
  | "DOCUMENT_VERIFIED"
  | "USER_CONFIRMED"
  | "ALLEGED"
  | "DISPUTED"
  | "CONTRADICTED"
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// §23 — Section warning shape (serialized to JSON in DraftSection.warnings)
// ---------------------------------------------------------------------------

export interface SectionWarning {
  /** Machine-readable warning category, e.g. "MISSING_SUPPORT", "UNVERIFIED_FACT", "MATERIALIZED_CONTRADICTION", "INVENTED_CITATION". */
  type: string;
  /** Human-readable explanation. */
  detail: string;
  /** Internal source id (F3, CE4, L2, C3, CC1, E5, A2) the warning concerns. */
  sourceId?: string;
}

// ---------------------------------------------------------------------------
// §8 — DraftingContext: bounded context handed to the AI drafter.
//
// NEVER the whole case. Built by `buildDraftingContext` from a small set of
// verified facts, chronology events, evidence refs, legal issues, applicable
// legislation, Cassation / ConCourt / ECHR precedents, applicability
// verdicts, distinguishing factors, counter-authorities, the argument map,
// and missing material facts.
// ---------------------------------------------------------------------------

/** A single fact inside the DraftingContext. Carries an internal source id (F1, F2…). */
export interface DraftingFact {
  /** Internal source id (§10). */
  sourceId: string;
  /** Underlying CaseFact id (for traceability). */
  factId: string;
  /** The proposition asserted by the fact. */
  proposition: string;
  /** §9 — status governs the draft language used in narrative sections. */
  status: FactStatus;
  /** HIGH | MEDIUM | LOW (carried over from case-workspace Materiality). */
  materiality: "HIGH" | "MEDIUM" | "LOW";
  /** Category carried over from CaseFact.category. */
  category: string;
  /** Brief evidence references (only refs, NOT full document text). */
  supportingEvidence: EvidenceRefSummary[];
  contradictingEvidence: EvidenceRefSummary[];
}

/** Minimal evidence reference summary inside the context (NOT full text). */
export interface EvidenceRefSummary {
  documentId?: string;
  page?: number;
  section?: string;
  quote?: string;
  /** Display name of the source document (for the attachment list). */
  displayName?: string;
}

/** Chronology event inside the DraftingContext. Carries internal source id (CE1…). */
export interface DraftingChronologyEvent {
  sourceId: string;
  eventId: string;
  date: string | null;
  originalDateText: string | null;
  dateStatus: "EXACT" | "INFERRED" | "UNKNOWN";
  eventType: string;
  title: string;
  description: string | null;
  participants: string[];
  verification: "DOCUMENT_VERIFIED" | "USER_ALLEGED" | "DISPUTED";
  hasConflict: boolean;
  conflictDetail: string | null;
  evidenceRefs: EvidenceRefSummary[];
}

/** Case-internal evidence reference (just refs, not full text). Carries CE-based source id. */
export interface DraftingEvidenceRef {
  /** Internal source id (we reuse the document id namespace; e.g. CE_doc_x). The map records the citation. */
  sourceId: string;
  documentId?: string;
  page?: number;
  section?: string;
  quote?: string;
  displayName?: string;
  /** Relation to a fact or claim — SUPPORTS / CONTRADICTS / CONTEXT / AUTHENTICATES. */
  relation?: string;
  /** Strength — DIRECT / INDIRECT / CONTEXTUAL. */
  strength?: string;
}

/** Legislation entry (§8 applicable_law). Carries internal source id (L1…). */
export interface DraftingLegislation {
  sourceId: string;
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
}

/** Cassation precedent (§8 precedents). Carries internal source id (C1…). */
export interface DraftingCassationCase {
  sourceId: string;
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
  /** §20 — distinguishing factors when applicability is WITH_DISTINCTIONS. */
  distinguishingFactors?: string[];
}

/** Constitutional Court precedent (§8 precedents). Carries internal source id (CC1…). */
export interface DraftingConCourtCase {
  sourceId: string;
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
  distinguishingFactors?: string[];
}

/** ECHR precedent (§8 precedents). Carries internal source id (E1…). */
export interface DraftingEchrCase {
  sourceId: string;
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
  distinguishingFactors?: string[];
}

/** Argument map entry (§8). Carries internal source id (A1…). */
export interface DraftingArgumentEntry {
  sourceId: string;
  proposition: string;
  /** Internal source ids of supporting authorities (L1, C2, E5, etc.). */
  supportingAuthorities: string[];
  /** Internal source ids of counter authorities (§20 — serious adverse authority). */
  counterAuthorities: string[];
  limitations: string[];
}

/** Legal issue inside the DraftingContext. */
export interface DraftingLegalIssue {
  issueId: string;
  issueStatement: string;
  /** Internal source ids of related facts (F1, F2…). */
  factSourceIds: string[];
  /** Internal source ids of related legislation (L1, L2…). */
  legislationSourceIds: string[];
  /** Internal source ids of related precedents (C1, CC1, E1…). */
  precedentSourceIds: string[];
}

/** Applicability verdict for a precedent in the context. */
export type ApplicabilityVerdict =
  | "DIRECT"
  | "WITH_DISTINCTIONS"
  | "ANALOGICAL"
  | "NOT_APPLICABLE"
  | "UNRESOLVED";

export interface DraftingContext {
  caseId: string;
  /** §11 — Parties, jurisdiction, court, case number. Captured, NEVER invented. */
  parties: string[];
  jurisdiction: string | null;
  court: string | null;
  caseNumber: string | null;
  caseTitle: string | null;
  caseType: string | null;
  proceedingType: string | null;
  /** §8 — bounded sets. */
  facts: DraftingFact[];
  chronology: DraftingChronologyEvent[];
  evidenceRefs: DraftingEvidenceRef[];
  legalIssues: DraftingLegalIssue[];
  legislation: DraftingLegislation[];
  cassationCases: DraftingCassationCase[];
  conCourtCases: DraftingConCourtCase[];
  echrCases: DraftingEchrCase[];
  /** §20 — explicit distinguishing factors keyed by precedent source id. */
  distinguishing: Record<string, string[]>;
  /** §20 — counter-authority source ids. */
  counterAuthorities: string[];
  /** §8 — argument map. */
  argumentMap: DraftingArgumentEntry[];
  /** §8 — material facts the context cannot establish. */
  missingMaterialFacts: string[];
  /** Total character count of the serialized context (bounded by MAX_TOTAL_CONTEXT_CHARS). */
  totalChars: number;
  /** Whether the context was truncated due to bounds. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// §10 — Internal source id type
// ---------------------------------------------------------------------------

export type InternalSourceId =
  | `F${number}`
  | `CE${number}`
  | `L${number}`
  | `C${number}`
  | `CC${number}`
  | `E${number}`
  | `A${number}`;

// F  = fact
// CE = chronology event
// L  = legislation
// C  = cassation
// CC = constitutional court
// E  = ECHR
// A  = argument

// ---------------------------------------------------------------------------
// §10 — SourceIdMap: maps internal source ids to human-readable citations
// (used at export time only — the AI never sees the human-readable form).
// ---------------------------------------------------------------------------

export interface SourceIdMapEntry {
  /** Type of the source — matches the source-id prefix. */
  type:
    | "fact"
    | "chronology"
    | "legislation"
    | "cassation"
    | "concourt"
    | "echr"
    | "argument"
    | "evidence";
  /** Underlying record id (CaseFact.id, LegalIssueLink.id, etc.). */
  refId: string;
  /** Human-readable citation rendered at export time. */
  citation: string;
  /** Optional URL of the original source (for legal authorities). */
  url?: string;
}

export type SourceIdMap = Record<string, SourceIdMapEntry>;

// ---------------------------------------------------------------------------
// §12 — DocumentPlan: structured plan BEFORE prose. Every section has a
// required/optional flag + internal source id references.
// ---------------------------------------------------------------------------

export interface DocumentPlanSection {
  sectionType: SectionType;
  /** Whether the document type requires this section. */
  required: boolean;
  /** Internal source ids this section is allowed to reference. */
  sourceIds: string[];
  /** Free-text note explaining what the section should cover (deterministic). */
  note: string;
  /** Whether the plan flagged this section as missing material. */
  missing: boolean;
  /** Whether the plan flagged this section as needing additional support. */
  needsSupport: boolean;
  /** Warnings surfaced by the planner (e.g. material contradiction, unresolved issue). */
  warnings: SectionWarning[];
}

export interface DocumentPlan {
  draftId: string;
  documentType: DocumentType;
  goal: string;
  /** §11 — captured case identity (never invented). */
  parties: string[];
  caseNumber: string | null;
  court: string | null;
  jurisdiction: string | null;
  /** All planned sections (required + optional). */
  sections: DocumentPlanSection[];
  /** §12 — material contradictions surfaced by the planner. */
  materialContradictions: SectionWarning[];
  /** §12 — missing metadata fields (flagged, NOT invented). */
  missingMetadata: string[];
  /** §12 — requested relief (derived from goal + document type + verified context). */
  requestedRelief: string | null;
}

// ---------------------------------------------------------------------------
// §7 — DraftSection (parsed — matches the Prisma model)
// ---------------------------------------------------------------------------

export interface DraftSectionContent {
  /** Body text (Armenian / Russian / English per the draft's language). */
  text: string;
  /** Internal source ids cited by this section (F1, CE4, L2, C3, CC1, E5, A2). */
  sourceIds: string[];
  /** Optional structured sub-paragraphs (e.g. numbered prayer-for-relief). */
  paragraphs?: string[];
  /** Optional table (e.g. verified chronology). */
  table?: { headers: string[]; rows: string[][] };
}

export interface DraftSection {
  id: string;
  draftId: string;
  versionId: string;
  sectionType: SectionType;
  title: string;
  content: DraftSectionContent;
  reviewStatus: ReviewStatus;
  stale: boolean;
  warnings: SectionWarning[];
  previousContent: DraftSectionContent | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// §15 — AI draft task
// ---------------------------------------------------------------------------

export type AiDraftTask =
  | "FULL_DOCUMENT_DRAFT"
  | "COMPLEX_ARGUMENT_DRAFT"
  | "MULTI_ISSUE_DRAFT"
  | "CASSATION_DRAFT"
  | "CONSTITUTIONAL_DRAFT"
  | "ECHR_SUPPORT_DRAFT"
  | "DEEP_REVISION";

// ---------------------------------------------------------------------------
// §15 — Drafter operation result
// ---------------------------------------------------------------------------

export type DraftOperationStatus =
  | "SUCCESS"
  | "SUCCESS_EMPTY"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_SCHEMA"
  | "ERROR"
  | "BLOCKED_EXTERNAL_QUOTA";

export interface DraftOperationResult {
  sections: DraftSection[];
  status: DraftOperationStatus;
  provider?: string;
  errorDetail?: string;
}

// ---------------------------------------------------------------------------
// §16 — Verification result (returned by the verification firewall)
// ---------------------------------------------------------------------------

export interface VerificationAssertion {
  /** Machine-readable assertion type, e.g. "FACT_HAS_EVIDENCE", "CITATION_IN_CONTEXT", "RELIEF_IN_GOAL", "FACT_STATUS_LANGUAGE". */
  type: string;
  passed: boolean;
  detail?: string;
  sourceId?: string;
}

export interface VerificationResult {
  passed: boolean;
  assertions: VerificationAssertion[];
}

// ---------------------------------------------------------------------------
// §5 — Document type spec (registry entry)
// ---------------------------------------------------------------------------

export interface DocumentTypeSpec {
  type: DocumentType;
  /** Required metadata fields (e.g. ["court", "caseNumber", "filingDeadline"]). */
  requiredMetadata: string[];
  /** Required section types. */
  requiredSections: SectionType[];
  /** Optional section types. */
  optionalSections: SectionType[];
  /** Procedural constraints (free-text bullet list, surfaced to the drafter). */
  proceduralConstraints: string[];
  /** Validation rules (free-text bullet list, surfaced to the verifier). */
  validationRules: string[];
}
