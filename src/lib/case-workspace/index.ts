// src/lib/case-workspace/index.ts
// Phase 5 — Case Workspace Core Data Layer — public re-exports.
//
// This is the single entry-point other modules (API routes, analysis
// subagents) import from. The internal layout (cases/, volumes/,
// documents/, security/, jobs/) is an implementation detail — callers
// should never reach into a subpath directly.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  CaseType,
  CaseStatus,
  DocumentType,
  ProcessingStatus,
  JobType,
  JobStatus,
  DateStatus,
  FactStatus,
  Materiality,
  EvidenceRelation,
  EvidenceStrength,
  Verification,
  ClaimType,
  ContradictionType,
  ContradictionStatus,
  EntityType,
  EvidenceRef,
  Provenance,
  CaseWorkspace,
  CaseVolume,
  CaseDocument,
  DocumentPage,
  CaseJob,
  ChronologyEvent,
  CaseEntity,
  CaseFact,
  CaseEvidenceLink,
  CaseClaim,
  ContradictionSide,
  CaseContradiction,
  LegalReferenceEntry,
  LegalIssueLink,
  CaseAnalysisResult,
  IngestionResult,
  CaseSummary,
  IngestibleFile,
  CreateCaseInput,
  UpdateCaseInput,
  CreateVolumeInput,
  UpdateVolumeInput,
  UpdateDocumentMetadataInput,
  CreateJobInput,
} from "./types";

// ---------------------------------------------------------------------------
// Config + constants
// ---------------------------------------------------------------------------

export {
  MAX_FILE_SIZE_BYTES,
  MAX_PAGES_PER_DOCUMENT,
  MAX_EXTRACTION_TIME_MS,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  REJECTED_EXTENSIONS,
  MAGIC_BYTES,
  STORAGE_ROOT,
  ARCHIVE_ROOT,
  JOB_STALE_AFTER_MS,
  MAX_FILES_PER_BATCH,
  kindFromMime,
  inferDocumentType,
} from "./config";
export type { DocumentKind } from "./config";

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

export { db } from "./db";

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

export {
  serializeEvidenceRef,
  parseEvidenceRef,
  parseEvidenceRefRequired,
  serializeArray,
  parseArray,
  parseEvidenceRefArray,
  parseStringArray,
  serializeObject,
  parseObject,
  buildProvenance,
} from "./documents/provenance";

// ---------------------------------------------------------------------------
// Storage helpers (SERVER-ONLY)
// ---------------------------------------------------------------------------

export {
  generateStorageKey,
  resolveStoragePath,
  ensureStorageDir,
  ensureArchiveDir,
  writeDocumentFile,
  readDocumentFile,
  deleteDocumentFile,
  archiveCaseStorage,
  purgeArchivedCase,
  purgeCaseStorage,
  storageKeyBasename,
  StorageError,
} from "./documents/storage";

// ---------------------------------------------------------------------------
// Security / upload policy
// ---------------------------------------------------------------------------

export { validateFile } from "./security/upload-policy";
export type { FileValidationResult } from "./security/upload-policy";

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

export {
  computeSha256,
  computeSha256OfString,
  findDuplicate,
  isExactDuplicate,
  findDuplicateInCase,
} from "./documents/dedup";
export type { DuplicateLookup } from "./documents/dedup";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export {
  parseDocument,
  normalizeText,
  parserKindFor,
} from "./documents/parser";
export type {
  PageExtractionStatus,
  ParsedPage,
  ParseResult,
  ParseOptions,
} from "./documents/parser";

// ---------------------------------------------------------------------------
// Document registry (list/get/update metadata)
// ---------------------------------------------------------------------------

export {
  listDocuments,
  getDocument,
  getDocumentBySha256,
  getDocumentPages,
  getDocumentPage,
  updateDocumentMetadata,
} from "./documents/registry";
export type { ListDocumentsFilter } from "./documents/registry";

// ---------------------------------------------------------------------------
// Ingestion orchestrator
// ---------------------------------------------------------------------------

export {
  ingestDocument,
  ingestBatch,
  archiveCaseStorageForJob,
} from "./documents/ingestion";

// ---------------------------------------------------------------------------
// Cases service
// ---------------------------------------------------------------------------

export {
  createCase,
  getCase,
  listCases,
  updateCase,
  archiveCase,
  deleteCase,
  getCaseSummary,
} from "./cases/service";

// ---------------------------------------------------------------------------
// Volumes service
// ---------------------------------------------------------------------------

export {
  createVolume,
  listVolumes,
  updateVolume,
  deleteVolume,
  reorderVolumes,
} from "./volumes/service";

// ---------------------------------------------------------------------------
// Jobs service
// ---------------------------------------------------------------------------

export {
  createJob,
  getJob,
  listJobs,
  updateJobProgress,
  completeJob,
  failJob,
  cancelJob,
  resumeJob,
  getOrCreateRunningJob,
  jobDocumentIds,
  remainingDocumentIds,
} from "./jobs/service";
