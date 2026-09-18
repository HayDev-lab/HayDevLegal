// src/lib/case-workspace/documents/ingestion.ts
// Phase 5 — ingestion pipeline orchestrator.
//
// Flow (per Phase 5 §7):
//   1. validateFile (security/upload-policy) — reject if invalid
//   2. computeSha256 — dedup check via CaseDocument table
//   3. If duplicate: create a new CaseDocument row with processingStatus=READY
//      and storageKey copied from the existing one; do NOT re-parse. New
//      volumes must not reprocess unchanged old volumes (§7).
//   4. writeDocumentFile to storage (only when not a duplicate — bytes are
//      reused otherwise)
//   5. Create CaseDocument record (status: VALIDATING → PARSING)
//   6. parseDocument — extract pages
//   7. Persist DocumentPage rows (one per page with originalText +
//      normalizedText + extractionStatus)
//   8. Update CaseDocument: pageCount, requiresOcr, processingStatus=READY
//      (or PARTIAL/FAILED)
//   9. Update CaseWorkspace denormalized counts (documentCount++,
//      pageCount += N)
//  10. Return result
//
// The batch entrypoint `ingestBatch` wraps `ingestDocument` in a CaseJob
// (jobType=INGEST) and processes files sequentially. The job tracks
// progressCurrent/Total and resumes on failure (§7: failure at 37/100
// resumes remaining work).

import { randomUUID } from "node:crypto";

import { db } from "../db";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PAGES_PER_DOCUMENT,
  MAX_EXTRACTION_TIME_MS,
  inferDocumentType,
} from "../config";
import { validateFile } from "../security/upload-policy";
import { computeSha256, findDuplicate } from "./dedup";
import { parseDocument } from "./parser";
import {
  deleteDocumentFile,
  writeDocumentFile,
} from "./storage";
import {
  insertDocumentPages,
  insertDocumentRecord,
  updateProcessingState,
} from "./registry";
import { archiveCaseStorage } from "./storage";
import type {
  IngestibleFile,
  IngestionResult,
  JobType,
  ProcessingStatus,
} from "../types";
import type { CaseJob } from "../types";

// ---------------------------------------------------------------------------
// Single-document ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a single uploaded file.
 *
 * @param caseId    Owning CaseWorkspace id
 * @param volumeId  Owning CaseVolume id (may be null — unfiled docs)
 * @param filename  Original filename (validated; never used directly as a path)
 * @param mimeType  Declared MIME type (validated against actual bytes)
 * @param bytes     Raw bytes
 */
export async function ingestDocument(
  caseId: string,
  volumeId: string | null,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<IngestionResult> {
  // 1. Validate file (security gate). Reject if invalid — do not store.
  const validation = validateFile(filename, mimeType, bytes);
  if (!validation.ok) {
    return {
      documentId: "",
      status: "FAILED",
      duplicate: false,
      pageCount: 0,
      requiresOcr: false,
      errorDetail: `Validation rejected: ${validation.reason}`,
    };
  }

  // 2. Compute SHA-256 + dedup lookup.
  const sha256 = computeSha256(bytes);
  const dup = await findDuplicate(sha256);

  // 3. Decide storage strategy.
  let storageKey: string;
  let requiresParse: boolean;
  let pageCount = 0;
  let requiresOcr = false;

  const documentId = randomUUID();

  if (dup.duplicate && dup.existingStorageKey) {
    // Reuse existing storage bytes — do NOT re-parse. Per §7.
    storageKey = dup.existingStorageKey;
    requiresParse = false;
    // Pull the existing pageCount + ocr flag so the new row mirrors the
    // canonical parsed state.
    const existing = await db.caseDocument.findUnique({
      where: { id: dup.existingDocumentId! },
      select: { pageCount: true, requiresOcr: true },
    });
    if (existing) {
      pageCount = existing.pageCount;
      requiresOcr = existing.requiresOcr;
    }
  } else {
    // 4. Write bytes to storage.
    try {
      storageKey = await writeDocumentFile(caseId, documentId, bytes, filename);
    } catch (e) {
      return {
        documentId: "",
        status: "FAILED",
        duplicate: false,
        pageCount: 0,
        requiresOcr: false,
        errorDetail: `Storage write failed: ${(e as Error).message}`,
      };
    }
    requiresParse = true;
  }

  // 5. Create CaseDocument record (status: VALIDATING initially — we move
  //    to PARSING only if we need to parse; duplicates go straight to READY).
  let status: ProcessingStatus = "VALIDATING";
  let errorDetail: string | null = null;

  try {
    await insertDocumentRecord({
      id: documentId,
      caseId,
      volumeId,
      originalFilename: filename,
      displayName: filename,
      mimeType,
      sizeBytes: bytes.length,
      sha256,
      documentType: inferDocumentType(filename),
      pageCount,
      processingStatus: requiresParse ? "PARSING" : "READY",
      requiresOcr,
      storageKey,
    });
  } catch (e) {
    // Failed to persist metadata — clean up storage and bail.
    if (requiresParse) {
      await deleteDocumentFile(storageKey).catch(() => {});
    }
    return {
      documentId: "",
      status: "FAILED",
      duplicate: false,
      pageCount: 0,
      requiresOcr: false,
      errorDetail: `DB insert failed: ${(e as Error).message}`,
    };
  }

  // 6/7/8. Parse + persist pages (only when not a duplicate).
  if (requiresParse) {
    try {
      const parsed = await parseDocument(mimeType, bytes, {
        maxPages: MAX_PAGES_PER_DOCUMENT,
        timeoutMs: MAX_EXTRACTION_TIME_MS,
      });
      pageCount = parsed.pageCount;
      requiresOcr = parsed.requiresOcr;

      // Persist pages (chunked insert).
      if (parsed.pages.length > 0) {
        await insertDocumentPages(documentId, parsed.pages);
      }

      // Determine final status: PARTIAL if any page failed/needs OCR, READY otherwise.
      const hasFailures = parsed.pages.some(
        (p) => p.extractionStatus === "FAILED",
      );
      const anyOcr = parsed.requiresOcr;
      status = hasFailures
        ? "FAILED"
        : anyOcr
          ? "PARTIAL"
          : parsed.pages.length > 0
            ? "READY"
            : "PARTIAL";
      if (hasFailures) {
        errorDetail = "One or more pages failed to parse";
      } else if (anyOcr) {
        errorDetail = "Scanned PDF — OCR required for some pages";
      } else if (parsed.pages.length === 0) {
        errorDetail = "No pages extracted";
      }
    } catch (e) {
      status = "FAILED";
      errorDetail = `Parse failed: ${(e as Error).message}`;
    }

    await updateProcessingState(documentId, {
      processingStatus: status,
      pageCount,
      requiresOcr,
      errorDetail,
    });
  } else {
    // Duplicate: already READY, no pages to insert, pageCount already set.
    status = "READY";
  }

  // 9. Update CaseWorkspace denormalized counts.
  await db.caseWorkspace
    .update({
      where: { id: caseId },
      data: {
        documentCount: { increment: 1 },
        pageCount: { increment: pageCount },
      },
    })
    .catch(() => {
      // Workspace missing — non-fatal; the document row still exists.
    });

  return {
    documentId,
    status,
    duplicate: dup.duplicate,
    pageCount,
    requiresOcr,
    errorDetail: errorDetail ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Batch ingestion (with CaseJob orchestration)
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of files. Creates a CaseJob (jobType=INGEST), processes
 * files sequentially, updates progressCurrent/Total, resumes on failure
 * (§7 — failure at 37/100 resumes remaining work).
 *
 * Status: COMPLETED (all files succeeded) | PARTIAL (some failed) |
 * FAILED (all failed / job itself broke).
 */
export async function ingestBatch(
  caseId: string,
  files: IngestibleFile[],
): Promise<CaseJob> {
  // Create the job row (status: RUNNING — we start processing immediately).
  const job = await db.caseJob.create({
    data: {
      caseId,
      jobType: "INGEST" as JobType,
      status: "RUNNING",
      progressTotal: files.length,
      progressCurrent: 0,
      documentIds: JSON.stringify([]),
      startedAt: new Date(),
    },
  });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const documentIds: string[] = [];

  for (const file of files) {
    try {
      const result = await ingestDocument(
        caseId,
        file.volumeId,
        file.filename,
        file.mimeType,
        file.bytes,
      );
      if (result.documentId) {
        documentIds.push(result.documentId);
      }
      if (result.status === "READY" || result.status === "PARTIAL") {
        succeeded++;
      } else {
        failed++;
      }
    } catch (e) {
      // Per-file error — log it but keep processing the remaining files
      // (§7 — failure at 37/100 resumes remaining work).
      failed++;
      // Persist the error message on the job row so the UI can show it.
      await db.caseJob
        .update({
          where: { id: job.id },
          data: {
            errorDetail: `File ${file.filename}: ${(e as Error).message}`.slice(
              0,
              1000,
            ),
          },
        })
        .catch(() => {});
    }
    processed++;
    // Update progress after each file.
    await db.caseJob
      .update({
        where: { id: job.id },
        data: {
          progressCurrent: processed,
          documentIds: JSON.stringify(documentIds),
        },
      })
      .catch(() => {});
  }

  // Finalise the job.
  let finalStatus: "COMPLETED" | "PARTIAL" | "FAILED";
  if (succeeded === 0 && files.length > 0) {
    finalStatus = "FAILED";
  } else if (failed > 0) {
    finalStatus = "PARTIAL";
  } else {
    finalStatus = "COMPLETED";
  }

  const updated = await db.caseJob.update({
    where: { id: job.id },
    data: {
      status: finalStatus,
      progressCurrent: processed,
      documentIds: JSON.stringify(documentIds),
      completedAt: new Date(),
    },
  });

  return {
    id: updated.id,
    caseId: updated.caseId,
    jobType: updated.jobType as JobType,
    status: updated.status as CaseJob["status"],
    progressCurrent: updated.progressCurrent,
    progressTotal: updated.progressTotal,
    documentIds: documentIds, // already parsed array
    errorDetail: updated.errorDetail,
    startedAt: updated.startedAt,
    completedAt: updated.completedAt,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Rollback / archive helpers
// ---------------------------------------------------------------------------

/**
 * Archive a case's storage when the case is archived (§19).
 * Live files move into the archive root so the case can be reinstated
 * later without re-parsing.
 */
export async function archiveCaseStorageForJob(
  caseId: string,
): Promise<string> {
  return archiveCaseStorage(caseId);
}

// ---------------------------------------------------------------------------
// Constants re-exported for callers (e.g. the API route that wants to
// surface the limit to the client)
// ---------------------------------------------------------------------------

export { MAX_FILE_SIZE_BYTES } from "../config";
export { MAX_PAGES_PER_DOCUMENT, MAX_EXTRACTION_TIME_MS } from "../config";
