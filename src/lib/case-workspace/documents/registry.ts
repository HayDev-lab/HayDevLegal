// src/lib/case-workspace/documents/registry.ts
// Phase 5 — CaseDocument + DocumentPage CRUD (registry layer).
//
// The registry is the read/update-metadata surface for documents AFTER
// ingestion. It does NOT parse or store bytes — that's the ingestion
// orchestrator's job. The registry exposes:
//   * list / get / get-pages / get-page
//   * update metadata (displayName, documentType)
//   * get by sha256 (for dedup)

import { db } from "../db";
import {
  parseEvidenceRef,
  parseEvidenceRefArray,
  parseStringArray,
  serializeArray,
} from "./provenance";
import type {
  CaseDocument,
  DocumentPage,
  DocumentType,
  ProcessingStatus,
  UpdateDocumentMetadataInput,
} from "../types";

// ---------------------------------------------------------------------------
// Row → parsed interface mappers
// ---------------------------------------------------------------------------

type DocumentRow = Awaited<ReturnType<typeof db.caseDocument.findFirst>>;
type PageRow = Awaited<ReturnType<typeof db.documentPage.findFirst>>;

function mapDocument(row: NonNullable<DocumentRow>): CaseDocument {
  return {
    id: row.id,
    caseId: row.caseId,
    volumeId: row.volumeId,
    originalFilename: row.originalFilename,
    displayName: row.displayName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    documentType: row.documentType as DocumentType,
    pageCount: row.pageCount,
    processingStatus: row.processingStatus as ProcessingStatus,
    requiresOcr: row.requiresOcr,
    storageKey: row.storageKey,
    errorDetail: row.errorDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPage(row: NonNullable<PageRow>): DocumentPage {
  return {
    id: row.id,
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    originalText: row.originalText,
    normalizedText: row.normalizedText,
    extractionStatus: row.extractionStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListDocumentsFilter {
  volumeId?: string | null;
  processingStatus?: ProcessingStatus;
  documentType?: DocumentType;
}

/** List documents in a case (optionally filtered). */
export async function listDocuments(
  caseId: string,
  filter?: ListDocumentsFilter,
): Promise<CaseDocument[]> {
  const where: Record<string, unknown> = { caseId };
  if (filter?.volumeId !== undefined) {
    where.volumeId = filter.volumeId;
  }
  if (filter?.processingStatus) {
    where.processingStatus = filter.processingStatus;
  }
  if (filter?.documentType) {
    where.documentType = filter.documentType;
  }
  const rows = await db.caseDocument.findMany({
    where,
    orderBy: [{ createdAt: "asc" }],
  });
  return rows.map(mapDocument);
}

/** Get a single document by id. */
export async function getDocument(id: string): Promise<CaseDocument | null> {
  const row = await db.caseDocument.findUnique({ where: { id } });
  if (!row) return null;
  return mapDocument(row);
}

/** Get a document by sha256 (for dedup checks). */
export async function getDocumentBySha256(
  sha256: string,
): Promise<CaseDocument | null> {
  const row = await db.caseDocument.findFirst({ where: { sha256 } });
  if (!row) return null;
  return mapDocument(row);
}

/** Get all pages of a document, ordered by page number. */
export async function getDocumentPages(
  documentId: string,
): Promise<DocumentPage[]> {
  const rows = await db.documentPage.findMany({
    where: { documentId },
    orderBy: { pageNumber: "asc" },
  });
  return rows.map(mapPage);
}

/**
 * Get a single page of a document by page number (1-indexed).
 * Used by the evidence-click-→-open-source-page UI (§17).
 */
export async function getDocumentPage(
  documentId: string,
  pageNumber: number,
): Promise<DocumentPage | null> {
  const row = await db.documentPage.findFirst({
    where: { documentId, pageNumber },
  });
  if (!row) return null;
  return mapPage(row);
}

/** Update a document's display metadata (operator-facing only). */
export async function updateDocumentMetadata(
  id: string,
  patch: UpdateDocumentMetadataInput,
): Promise<CaseDocument> {
  const data: Record<string, unknown> = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.documentType !== undefined) data.documentType = patch.documentType;
  const row = await db.caseDocument.update({ where: { id }, data });
  return mapDocument(row);
}

// ---------------------------------------------------------------------------
// Internal helpers (used by the ingestion orchestrator — not exported in index.ts)
// ---------------------------------------------------------------------------

/**
 * Insert a new CaseDocument row. Used by the ingestion orchestrator.
 * @internal
 */
export async function insertDocumentRecord(input: {
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
  errorDetail?: string | null;
}): Promise<CaseDocument> {
  const row = await db.caseDocument.create({
    data: {
      id: input.id,
      caseId: input.caseId,
      volumeId: input.volumeId,
      originalFilename: input.originalFilename,
      displayName: input.displayName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      documentType: input.documentType,
      pageCount: input.pageCount,
      processingStatus: input.processingStatus,
      requiresOcr: input.requiresOcr,
      storageKey: input.storageKey,
      errorDetail: input.errorDetail ?? null,
    },
  });
  return mapDocument(row);
}

/**
 * Update processing status + page count + ocr flag on a document.
 * @internal
 */
export async function updateProcessingState(
  id: string,
  patch: {
    processingStatus: ProcessingStatus;
    pageCount?: number;
    requiresOcr?: boolean;
    errorDetail?: string | null;
    documentType?: DocumentType;
  },
): Promise<CaseDocument> {
  const data: Record<string, unknown> = {
    processingStatus: patch.processingStatus,
  };
  if (patch.pageCount !== undefined) data.pageCount = patch.pageCount;
  if (patch.requiresOcr !== undefined) data.requiresOcr = patch.requiresOcr;
  if (patch.errorDetail !== undefined) data.errorDetail = patch.errorDetail;
  if (patch.documentType !== undefined) data.documentType = patch.documentType;
  const row = await db.caseDocument.update({ where: { id }, data });
  return mapDocument(row);
}

/**
 * Bulk-insert DocumentPage rows for a parsed document.
 * @internal
 */
export async function insertDocumentPages(
  documentId: string,
  pages: Array<{
    pageNumber: number;
    originalText: string;
    normalizedText: string;
    extractionStatus: string;
  }>,
): Promise<number> {
  if (pages.length === 0) return 0;
  // Insert in chunks of 100 to keep the SQLite parameter list bounded.
  const chunkSize = 100;
  for (let i = 0; i < pages.length; i += chunkSize) {
    const slice = pages.slice(i, i + chunkSize);
    await db.documentPage.createMany({
      data: slice.map((p) => ({
        documentId,
        pageNumber: p.pageNumber,
        originalText: p.originalText,
        normalizedText: p.normalizedText || null,
        extractionStatus: p.extractionStatus,
      })),
    });
  }
  return pages.length;
}

/**
 * Delete a document and all its pages (cascades via FK). Does NOT delete
 * the storage bytes — call `deleteDocumentFile` separately.
 * @internal
 */
export async function deleteDocumentRecord(id: string): Promise<void> {
  await db.caseDocument.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Re-exports for ingestion orchestrator
// ---------------------------------------------------------------------------

export {
  parseEvidenceRef,
  parseEvidenceRefArray,
  parseStringArray,
  serializeArray,
};
