// src/lib/case-workspace/types.ts
// Phase 5 — Case Workspace type system.
//
// These TypeScript types mirror the Prisma models in `prisma/schema.prisma`.
// Prisma's SQLite backend stores enums as `String` and arrays/objects as
// JSON-serialized `String`. This module re-declares them as proper union
// types and provides parsed interfaces (with JSON fields already converted
// back to arrays/objects) for in-memory use.
//
// Provenance rule (Phase 5 §6): every extracted item (event/fact/claim/
// entity/evidence link) carries caseId + volumeId? + documentId? + page? +
// section? + originalFilename + contentHash. Nothing becomes VERIFIED without
// traceable evidence.

// ---------------------------------------------------------------------------
// Enums (union types — stored as String in SQLite, surfaced as unions here)
// ---------------------------------------------------------------------------

export type CaseType =
  | "CRIMINAL"
  | "CIVIL"
  | "ADMINISTRATIVE"
  | "BANKRUPTCY"
  | "CONSTITUTIONAL"
  | "ECHR"
  | "OTHER";

export type CaseStatus = "ACTIVE" | "ARCHIVED";

export type DocumentType =
  | "COURT_DECISION"
  | "INDICTMENT"
  | "CHARGE_DECISION"
  | "SEARCH_PROTOCOL"
  | "SEIZURE_PROTOCOL"
  | "INTERROGATION"
  | "EXPERT_REPORT"
  | "MOTION"
  | "APPEAL"
  | "CASSATION_APPEAL"
  | "NOTICE"
  | "POSTAL_RECORD"
  | "CONTRACT"
  | "PAYMENT_RECORD"
  | "MEDICAL_RECORD"
  | "OFFICIAL_LETTER"
  | "EVIDENCE_ATTACHMENT"
  | "OTHER"
  | "UNKNOWN";

export type ProcessingStatus =
  | "UPLOADED"
  | "VALIDATING"
  | "PARSING"
  | "EXTRACTED"
  | "ANALYZING"
  | "READY"
  | "PARTIAL"
  | "FAILED";

export type JobType =
  | "INGEST"
  | "CHRONOLOGY"
  | "FACTS"
  | "EVIDENCE"
  | "RESEARCH"
  | "CASE_ANALYSIS";

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export type DateStatus = "EXACT" | "INFERRED" | "UNKNOWN";

export type FactStatus =
  | "VERIFIED"
  | "ALLEGED"
  | "DISPUTED"
  | "CONTRADICTED"
  | "UNKNOWN";

export type Materiality = "HIGH" | "MEDIUM" | "LOW";

export type EvidenceRelation =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "CONTEXT"
  | "AUTHENTICATES";

export type EvidenceStrength = "DIRECT" | "INDIRECT" | "CONTEXTUAL";

export type Verification = "DOCUMENT_VERIFIED" | "USER_ALLEGED" | "DISPUTED";

export type ClaimType =
  | "DEFENDANT"
  | "APPLICANT"
  | "PROSECUTION"
  | "GOVERNMENT"
  | "WITNESS"
  | "EXPERT"
  | "LOWER_COURT"
  | "COURT_FINDING"
  | "OTHER";

export type ContradictionType =
  | "DIRECT"
  | "TEMPORAL"
  | "IDENTITY"
  | "PROCEDURAL"
  | "APPARENT";

export type ContradictionStatus = "OPEN" | "EXPLAINED" | "RESOLVED";

export type EntityType =
  | "PERSON"
  | "COMPANY"
  | "COURT"
  | "INVESTIGATOR"
  | "PROSECUTOR"
  | "LAWYER"
  | "EXPERT"
  | "GOVERNMENT_BODY"
  | "PENITENTIARY"
  | "OTHER";

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/**
 * Evidence reference (Phase 5 §6).
 * Points to one specific location inside a document — used by every
 * extracted item (event/fact/claim/entity/evidence link/issue link) so that
 * any proposition can be traced back to its source page.
 */
export interface EvidenceRef {
  /** ID of the CaseDocument this evidence came from. */
  documentId: string;
  /** Page number (1-indexed) inside the document, when applicable. */
  page?: number;
  /** Section / heading label inside the document, when applicable. */
  section?: string;
  /** Verbatim quote of the relevant passage (kept short). */
  quote?: string;
  /** SHA-256 of the source document content (for integrity check). */
  contentHash?: string;
}

/** Provenance envelope attached to extracted items (Phase 5 §6). */
export interface Provenance {
  caseId: string;
  volumeId?: string | null;
  documentId?: string;
  page?: number;
  section?: string;
  originalFilename?: string;
  contentHash?: string;
}

// ---------------------------------------------------------------------------
// Prisma model interfaces (parsed — JSON fields converted back to arrays/objects)
// ---------------------------------------------------------------------------

export interface CaseWorkspace {
  id: string;
  title: string;
  caseNumber: string | null;
  jurisdiction: string | null;
  court: string | null;
  proceedingType: string | null;
  caseType: CaseType;
  status: CaseStatus;
  documentCount: number;
  pageCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseVolume {
  id: string;
  caseId: string;
  number: number | null;
  title: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseDocument {
  id: string;
  caseId: string;
  volumeId: string | null;
  originalFilename: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  documentType: DocumentType;
  pageCount: number;
  processingStatus: ProcessingStatus;
  requiresOcr: boolean;
  storageKey: string;
  errorDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentPage {
  id: string;
  documentId: string;
  pageNumber: number;
  originalText: string;
  normalizedText: string | null;
  extractionStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseJob {
  id: string;
  caseId: string;
  jobType: JobType;
  status: JobStatus;
  progressCurrent: number;
  progressTotal: number;
  /** Parsed from the stored JSON string — array of CaseDocument ids. */
  documentIds: string[];
  errorDetail: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChronologyEvent {
  id: string;
  caseId: string;
  date: string | null;
  originalDateText: string | null;
  dateStatus: DateStatus;
  eventType: string;
  title: string;
  description: string | null;
  /** Parsed from JSON. */
  participants: string[];
  /** Parsed from JSON. */
  evidenceRefs: EvidenceRef[];
  verification: Verification;
  hasConflict: boolean;
  conflictDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseEntity {
  id: string;
  caseId: string;
  canonicalName: string;
  /** Parsed from JSON. */
  aliases: string[];
  type: EntityType;
  /** Parsed from JSON. */
  roles: string[];
  /** Parsed from JSON. */
  evidenceRefs: EvidenceRef[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseFact {
  id: string;
  caseId: string;
  proposition: string;
  category: string;
  status: FactStatus;
  /** Parsed from JSON. */
  supportingEvidence: EvidenceRef[];
  /** Parsed from JSON. */
  contradictingEvidence: EvidenceRef[];
  /** Parsed from JSON — array of LegalIssueLink ids. */
  relatedIssues: string[];
  materiality: Materiality;
  /** USER | AI (who proposed this fact). */
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseEvidenceLink {
  id: string;
  caseId: string;
  factId: string | null;
  /** Parsed from JSON. */
  evidenceRef: EvidenceRef;
  relation: EvidenceRelation;
  strength: EvidenceStrength;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseClaim {
  id: string;
  caseId: string;
  claimType: ClaimType;
  proposition: string;
  /** Parsed from JSON — source EvidenceRef. */
  source: EvidenceRef;
  status: string;
  /** Parsed from JSON — array of EvidenceRef. */
  evidenceRefs: EvidenceRef[];
  createdAt: Date;
  updatedAt: Date;
}

/** One side of a contradiction (side A or side B). */
export interface ContradictionSide {
  claimId?: string;
  proposition: string;
  source?: EvidenceRef;
}

export interface CaseContradiction {
  id: string;
  caseId: string;
  contradictionType: ContradictionType;
  significance: Materiality;
  status: ContradictionStatus;
  /** Parsed from JSON. */
  claimA: ContradictionSide;
  /** Parsed from JSON. */
  claimB: ContradictionSide;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Applicable law or precedent reference inside a LegalIssueLink. */
export interface LegalReferenceEntry {
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages?: string[];
  applicability?: string;
}

export interface LegalIssueLink {
  id: string;
  caseId: string;
  issueId: string;
  issueStatement: string;
  /** Parsed from JSON — CaseFact ids. */
  factIds: string[];
  /** Parsed from JSON. */
  evidenceRefs: EvidenceRef[];
  /** Parsed from JSON. */
  relatedLaw: LegalReferenceEntry[];
  /** Parsed from JSON. */
  relatedPrecedents: LegalReferenceEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseAnalysisResult {
  id: string;
  caseId: string;
  requestId: string;
  /** Raw JSON string of the CaseAnalysisPack (kept opaque here — the analysis subagent owns the typed shape). */
  pack: string;
  /** Raw JSON string of the analysis output. */
  analysis: string | null;
  analysisVersion: string;
  status: string;
  provider: string | null;
  errorDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Result / DTO shapes returned by services
// ---------------------------------------------------------------------------

/** Result of a single document ingestion. */
export interface IngestionResult {
  documentId: string;
  status: ProcessingStatus;
  duplicate: boolean;
  pageCount: number;
  requiresOcr: boolean;
  errorDetail?: string;
}

/** Deterministic case summary (Phase 5 §17 — no LLM). */
export interface CaseSummary {
  documentCount: number;
  pageCount: number;
  /** Earliest + latest event dates in the chronology (ISO), if any. */
  dateRange: { earliest: string | null; latest: string | null };
  keyEntitiesCount: number;
  verifiedFactsCount: number;
  openIssuesCount: number;
  contradictionsCount: number;
  /** Coverage fraction (0..1) — what fraction of facts have ≥1 supporting evidence. */
  researchCoverage: number;
}

/** File ready for ingestion. */
export interface IngestibleFile {
  volumeId: string | null;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateCaseInput {
  title: string;
  caseNumber?: string;
  jurisdiction?: string;
  court?: string;
  proceedingType?: string;
  caseType?: CaseType;
}

export interface UpdateCaseInput {
  title?: string;
  caseNumber?: string;
  jurisdiction?: string;
  court?: string;
  proceedingType?: string;
  caseType?: CaseType;
  status?: CaseStatus;
}

export interface CreateVolumeInput {
  number?: number;
  title: string;
  order?: number;
}

export interface UpdateVolumeInput {
  number?: number;
  title?: string;
  order?: number;
}

export interface UpdateDocumentMetadataInput {
  displayName?: string;
  documentType?: DocumentType;
}

export interface CreateJobInput {
  caseId: string;
  jobType: JobType;
  documentIds: string[];
}
