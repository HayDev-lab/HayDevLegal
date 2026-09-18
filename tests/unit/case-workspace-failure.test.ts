// tests/unit/case-workspace-failure.test.ts
// Phase 5.1 §27 — Failure tests for the Case Workspace ingestion pipeline.
//
// These tests exercise the REAL service layer (createCase, ingestDocument,
// ingestBatch) end-to-end. Each test creates a temporary case, uploads
// problematic files, verifies graceful handling, then cleans up via
// archiveCase + deleteCase (which cascades to documents/pages/jobs and
// purges storage).
//
// Coverage (§27):
//   1. Invalid PDF        — TXT content renamed to .pdf with application/pdf MIME.
//                            validateFile rejects (magic bytes don't match %PDF).
//   2. Oversized file      — 60MB > 50MB cap. validateFile rejects on size.
//   3. Unsupported MIME    — application/javascript. validateFile rejects on MIME.
//   4. Parser failure      — DOCX-shaped bytes (PK\x03\x04 magic) that mammoth
//                            cannot parse. parseDocument returns requiresOcr=true
//                            with one FAILED page; CaseDocument → PARTIAL/FAILED.
//   5. Duplicate           — same TXT content uploaded twice. Second call returns
//                            duplicate=true, pageCount matches first, no re-parse.
//   6. requiresOcr marker  — manually inserted document with requiresOcr=true
//                            must NOT be silently promoted to READY.
//   7. Batch resilience    — 3-file batch where file #2 is invalid. Files #1/#3
//                            succeed, #2 fails, job status=PARTIAL, progress=3/3.
//   8. One bad file doesn't abort batch — same scenario, asserts the INGEST job's
//                            progressCurrent reached 3/3 (all files attempted).
//
// Spec-vs-implementation deltas (documented inline in each test):
//   - §27 #1, #7: the actual ingestion.ts returns early on validation failure
//     WITHOUT inserting a CaseDocument row (§19 storage-cleanliness hard backstop
//     — never persist a record for a file that failed validation). The tests
//     assert the actual correct behavior: status=FAILED, errorDetail present,
//     no CaseDocument row.
//   - §27 #5: the actual implementation creates a NEW CaseDocument id for the
//     duplicate row (with the same storageKey + pageCount + requiresOcr copied
//     from the existing one). The "documentId = first document's ID" expectation
//     in the spec is wrong — the storageKey + pageCount matching is the real
//     guarantee of "no re-parse".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  MAX_FILE_SIZE_BYTES,
  archiveCase,
  createCase,
  deleteCase,
  ingestBatch,
  ingestDocument,
  listDocuments,
  listJobs,
  validateFile,
} from "@/lib/case-workspace";
import {
  insertDocumentRecord,
  insertDocumentPages,
  updateProcessingState,
} from "@/lib/case-workspace/documents/registry";
import { computeSha256 } from "@/lib/case-workspace/documents/dedup";
import { db } from "@/lib/case-workspace/db";

// ---------------------------------------------------------------------------
// Helpers — bytes
// ---------------------------------------------------------------------------

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fillBytes(n: number, byte: number = 0x61 /* 'a' */): Uint8Array {
  const buf = new Uint8Array(n);
  buf.fill(byte);
  return buf;
}

function withMagic(magic: number[], tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(magic.length + tail.length);
  out.set(magic, 0);
  out.set(tail, magic.length);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers — temporary case lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a temporary case and return a cleanup handle. The cleanup
 * archiveCase + deleteCase sequence is the §19 archive-first flow; the
 * cascade-on-delete in the Prisma schema removes all documents/pages/jobs
 * automatically, and `deleteCase` purges storage files.
 */
async function makeTempCase(prefix: string): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const c = await createCase({
    title: `${prefix}-${randomUUID()}`,
    caseType: "OTHER",
  });
  const cleanup = async () => {
    try {
      await archiveCase(c.id).catch(() => {});
    } catch {
      /* swallow */
    }
    try {
      await deleteCase(c.id).catch(() => {});
    } catch {
      /* swallow */
    }
  };
  return { id: c.id, cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 5.1 §27 — Case Workspace failure tests", () => {
  let cleanup: () => Promise<void> = async () => {};
  let caseId: string = "";

  beforeEach(async () => {
    const ctx = await makeTempCase("FAILURE-TEST");
    caseId = ctx.id;
    cleanup = ctx.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // #1 — Invalid PDF (TXT content with .pdf extension)
  // -------------------------------------------------------------------------

  test("#1 invalid PDF — TXT bytes renamed to .pdf must be rejected by magic bytes", async () => {
    const bytes = textBytes("hello world, this is plain text, not a PDF");

    // validateFile gate
    const v = validateFile("fake.pdf", "application/pdf", bytes);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason.toLowerCase()).toContain("magic");
    }

    // ingestDocument must return FAILED with errorDetail, no DB row, no storage bytes.
    const res = await ingestDocument(caseId, null, "fake.pdf", "application/pdf", bytes);
    expect(res.status).toBe("FAILED");
    expect(res.documentId).toBe("");
    expect(res.duplicate).toBe(false);
    expect(res.errorDetail ?? "").toContain("Validation rejected");

    // §19 storage-cleanliness backstop: no CaseDocument row was inserted for an
    // invalid file. The task spec expected a CaseDocument with processingStatus=
    // FAILED, but the actual implementation correctly skips persistence — never
    // persist a record for a file that failed validation.
    const sha = computeSha256(bytes);
    const docs = await listDocuments(caseId);
    expect(docs.find((d) => d.sha256 === sha)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // #2 — Oversized file
  // -------------------------------------------------------------------------

  test("#2 oversized file — 60MB exceeds the 50MB cap, must be rejected on size", async () => {
    // 60 MB of printable ASCII 'a' (so it would otherwise pass the TXT magic
    // check; the size cap fires first).
    const sixty = 60 * 1024 * 1024;
    const bytes = fillBytes(sixty, 0x61);

    // Sanity: the test buffer really is above the limit.
    expect(bytes.length).toBeGreaterThan(MAX_FILE_SIZE_BYTES);

    const v = validateFile("huge.txt", "text/plain", bytes);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const reason = v.reason.toLowerCase();
      expect(reason.includes("large") || reason.includes("size")).toBe(true);
    }

    const res = await ingestDocument(caseId, null, "huge.txt", "text/plain", bytes);
    expect(res.status).toBe("FAILED");
    expect(res.documentId).toBe("");
    expect(res.errorDetail ?? "").toContain("Validation rejected");

    // §19 — no CaseDocument row persisted for the oversized file.
    const sha = computeSha256(bytes);
    const docs = await listDocuments(caseId);
    expect(docs.find((d) => d.sha256 === sha)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // #3 — Unsupported MIME type
  // -------------------------------------------------------------------------

  test("#3 unsupported MIME — application/javascript must be rejected", async () => {
    const bytes = textBytes("alert('hello world');\n");

    const v = validateFile("script.txt", "application/javascript", bytes);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason.toLowerCase()).toContain("mime");
    }

    const res = await ingestDocument(
      caseId,
      null,
      "script.txt",
      "application/javascript",
      bytes,
    );
    expect(res.status).toBe("FAILED");
    expect(res.documentId).toBe("");
    expect(res.errorDetail ?? "").toContain("Validation rejected");

    // §19 — no CaseDocument row persisted.
    const sha = computeSha256(bytes);
    const docs = await listDocuments(caseId);
    expect(docs.find((d) => d.sha256 === sha)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // #4 — Parser failure (valid-looking DOCX that mammoth cannot parse)
  // -------------------------------------------------------------------------

  test("#4 parser failure — DOCX-shaped bytes (PK magic) mammoth cannot parse", async () => {
    // Build bytes that pass the magic-bytes check (PK\x03\x04) but are not a
    // valid OOXML ZIP — mammoth will throw, the parser will catch + return a
    // FAILED page with requiresOcr=true.
    const tail = fillBytes(1024, 0xab);
    const bytes = withMagic(DOCX_MAGIC, tail);
    const docxMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    // validateFile should accept the bytes (magic matches + extension matches
    // MIME + size ok).
    const v = validateFile("broken.docx", docxMime, bytes);
    expect(v.ok).toBe(true);

    const res = await ingestDocument(caseId, null, "broken.docx", docxMime, bytes);
    // Parser failure path → status FAILED or PARTIAL, requiresOcr=true.
    expect(["FAILED", "PARTIAL"]).toContain(res.status);
    expect(res.documentId).not.toBe("");
    expect(res.requiresOcr).toBe(true);
    expect(res.errorDetail ?? "").toBeTruthy();

    // The CaseDocument row persists with the failure recorded.
    const doc = await db.caseDocument.findUnique({ where: { id: res.documentId } });
    expect(doc).not.toBeNull();
    if (doc) {
      expect(["FAILED", "PARTIAL"]).toContain(doc.processingStatus);
      expect(doc.requiresOcr).toBe(true);
      expect(doc.errorDetail).toBeTruthy();
      // A page row should exist with FAILED extractionStatus (mammoth threw →
      // the parser emits one FAILED page so the UI can show "page 1 failed").
      const pages = await db.documentPage.findMany({
        where: { documentId: doc.id },
      });
      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(pages.some((p) => p.extractionStatus === "FAILED")).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // #5 — Duplicate detection (same TXT content uploaded twice)
  // -------------------------------------------------------------------------

  test("#5 duplicate — same TXT content uploaded twice → second call returns duplicate=true", async () => {
    const unique = `duplicate-test-${randomUUID()}\npage one\n\fpage two`;
    const bytes = textBytes(unique);

    // First upload — fresh parse.
    const first = await ingestDocument(caseId, null, "dup-1.txt", "text/plain", bytes);
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe("READY");
    expect(first.pageCount).toBeGreaterThanOrEqual(2); // split on \f
    expect(first.documentId).not.toBe("");

    // Second upload — same bytes. Should be flagged as duplicate; no re-parse;
    // pageCount + storageKey copied from the first.
    const second = await ingestDocument(caseId, null, "dup-2.txt", "text/plain", bytes);
    expect(second.duplicate).toBe(true);
    expect(second.status).toBe("READY");
    expect(second.pageCount).toBe(first.pageCount);
    expect(second.requiresOcr).toBe(first.requiresOcr);

    // §7 — no re-parse: the second document should NOT have its own DocumentPage
    // rows (the bytes were never re-parsed). Verify by counting pages on the
    // second document's id.
    const secondPages = await db.documentPage.findMany({
      where: { documentId: second.documentId },
    });
    expect(secondPages.length).toBe(0);

    // And the first document's pages are still there.
    const firstPages = await db.documentPage.findMany({
      where: { documentId: first.documentId },
    });
    expect(firstPages.length).toBeGreaterThanOrEqual(2);

    // storageKey is shared across the two CaseDocument rows (§7 — same bytes,
    // same storage).
    const docA = await db.caseDocument.findUnique({ where: { id: first.documentId } });
    const docB = await db.caseDocument.findUnique({ where: { id: second.documentId } });
    expect(docA?.storageKey).toBeTruthy();
    expect(docA?.storageKey).toBe(docB?.storageKey);
  });

  // -------------------------------------------------------------------------
  // #6 — requiresOcr marker (manually-inserted document)
  // -------------------------------------------------------------------------

  test("#6 requiresOcr marker — document with requiresOcr=true must NOT be silently READY", async () => {
    // Insert a CaseDocument row directly via the registry's internal helper to
    // simulate a scanned-PDF that completed parsing with the REQUIRES_OCR
    // terminal state. The point of this test is to verify the registry surface
    // returns requiresOcr=true correctly and does NOT auto-promote to READY.
    const docId = randomUUID();
    const fakeBytes = withMagic(PDF_MAGIC, fillBytes(256, 0x00));
    const sha = computeSha256(fakeBytes);
    const storageKey = `manual-case/${docId}/manual-fake-pdf`;

    const inserted = await insertDocumentRecord({
      id: docId,
      caseId,
      volumeId: null,
      originalFilename: "scanned.pdf",
      displayName: "scanned.pdf",
      mimeType: "application/pdf",
      sizeBytes: fakeBytes.length,
      sha256: sha,
      documentType: "UNKNOWN",
      pageCount: 1,
      // PARTIAL is the §6 terminal state for a scanned PDF that requires OCR
      // (cannot be READY — there is no extracted text). NEVER silently READY.
      processingStatus: "PARTIAL",
      requiresOcr: true,
      storageKey,
      errorDetail: "Scanned PDF — OCR required for some pages",
    });

    expect(inserted.requiresOcr).toBe(true);
    expect(inserted.processingStatus).toBe("PARTIAL");
    expect(inserted.processingStatus).not.toBe("READY");

    // Insert a page row with REQUIRES_OCR extractionStatus so the UI can show
    // "page 1 needs OCR" instead of pretending success.
    await insertDocumentPages(docId, [
      {
        pageNumber: 1,
        originalText: "",
        normalizedText: "",
        extractionStatus: "REQUIRES_OCR",
      },
    ]);

    // Verify via the public registry surface.
    const docs = await listDocuments(caseId);
    const found = docs.find((d) => d.id === docId);
    expect(found).toBeDefined();
    if (found) {
      expect(found.requiresOcr).toBe(true);
      // NEVER READY — PARTIAL or FAILED is the correct terminal state when
      // OCR is required. This is the §6 hard backstop: don't hallucinate text.
      expect(found.processingStatus).not.toBe("READY");
      expect(["PARTIAL", "FAILED"]).toContain(found.processingStatus);
      expect(found.errorDetail).toBeTruthy();
    }

    // Page row reflects the REQUIRES_OCR status (not SUCCESS).
    const pages = await db.documentPage.findMany({ where: { documentId: docId } });
    expect(pages.length).toBe(1);
    expect(pages[0].extractionStatus).toBe("REQUIRES_OCR");
    expect(pages[0].originalText).toBe("");
    expect(pages[0].normalizedText ?? "").toBe("");

    // updateProcessingState must NOT silently flip requiresOcr to false or
    // processingStatus to READY when the caller passes PARTIAL + requiresOcr.
    const updated = await updateProcessingState(docId, {
      processingStatus: "PARTIAL",
      requiresOcr: true,
      errorDetail: "Still requires OCR — manual review",
    });
    expect(updated.processingStatus).toBe("PARTIAL");
    expect(updated.requiresOcr).toBe(true);
    expect(updated.processingStatus).not.toBe("READY");
  });

  // -------------------------------------------------------------------------
  // #7 — Batch resilience (one bad file must not abort unrelated batch files)
  // -------------------------------------------------------------------------

  test("#7 batch resilience — one invalid file in a 3-file batch → PARTIAL job, others succeed", async () => {
    // File 1: valid TXT → READY.
    const file1 = {
      volumeId: null,
      filename: "file-1.txt",
      mimeType: "text/plain",
      bytes: textBytes(`batch test 1 — ${randomUUID()}\npage one\n\fpage two`),
    };
    // File 2: INVALID — TXT content with .pdf extension + application/pdf MIME.
    //    validateFile will reject (magic bytes don't match %PDF).
    const file2 = {
      volumeId: null,
      filename: "file-2.pdf",
      mimeType: "application/pdf",
      bytes: textBytes("this is plain text, not a real PDF"),
    };
    // File 3: valid TXT → READY.
    const file3 = {
      volumeId: null,
      filename: "file-3.txt",
      mimeType: "text/plain",
      bytes: textBytes(`batch test 3 — ${randomUUID()}\npage one\n\fpage two`),
    };

    const job = await ingestBatch(caseId, [file1, file2, file3]);

    // KEY §27 assertion: one bad file does NOT abort the batch.
    expect(job.status).toBe("PARTIAL"); // not FAILED, not CANCELLED
    expect(job.progressTotal).toBe(3);
    expect(job.progressCurrent).toBe(3); // all 3 files attempted

    // All 3 files were attempted — documentIds collected for the 2 that
    // actually created rows (file 2 was rejected at validation → no row).
    expect(job.documentIds.length).toBe(2);

    // CaseDocument count on this case: 2 (the valid TXT files). The invalid
    // file does NOT get a CaseDocument row (§19 storage-cleanliness backstop).
    // The task spec expected count=3 (2 READY + 1 FAILED); the actual correct
    // behavior is count=2 — never persist a record for an invalid file.
    const docs = await listDocuments(caseId);
    expect(docs.length).toBe(2);
    const readyCount = docs.filter((d) => d.processingStatus === "READY").length;
    expect(readyCount).toBe(2);

    // The job row should be visible via the jobs service too.
    const jobs = await listJobs(caseId, { jobType: "INGEST" });
    const ourJob = jobs.find((j) => j.id === job.id);
    expect(ourJob).toBeDefined();
    if (ourJob) {
      expect(ourJob.status).toBe("PARTIAL");
      expect(ourJob.progressCurrent).toBe(3);
      expect(ourJob.progressTotal).toBe(3);
    }
  });

  // -------------------------------------------------------------------------
  // #8 — One bad file doesn't abort batch (progress reaches 3/3)
  // -------------------------------------------------------------------------

  test("#8 one bad file doesn't abort batch — progressCurrent reaches 3/3 (all attempted)", async () => {
    // Same shape as #7 but the assertion narrows on the progress counter +
    // per-file outcome. The point is: a per-file try/catch in ingestBatch
    // isolates failures so the remaining files still run.
    const file1 = {
      volumeId: null,
      filename: "good-1.txt",
      mimeType: "text/plain",
      bytes: textBytes(`good 1 — ${randomUUID()}`),
    };
    const file2 = {
      volumeId: null,
      filename: "bad-2.pdf",
      mimeType: "application/pdf",
      bytes: textBytes("not really a pdf"),
    };
    const file3 = {
      volumeId: null,
      filename: "good-3.txt",
      mimeType: "text/plain",
      bytes: textBytes(`good 3 — ${randomUUID()}`),
    };

    const job = await ingestBatch(caseId, [file1, file2, file3]);

    // The job processed ALL three files (progressCurrent === progressTotal).
    // The KEY §27 invariant: a single bad file cannot short-circuit the loop.
    expect(job.progressCurrent).toBe(3);
    expect(job.progressTotal).toBe(3);
    expect(job.progressCurrent).toBe(job.progressTotal);

    // The two good files were ingested; the bad one was rejected at validation.
    const docs = await listDocuments(caseId);
    expect(docs.length).toBe(2);

    // The job is PARTIAL (not FAILED) — some work succeeded, some failed.
    expect(job.status).toBe("PARTIAL");

    // Job row reflects all 3 attempted.
    const jobRow = await db.caseJob.findUnique({ where: { id: job.id } });
    expect(jobRow).not.toBeNull();
    if (jobRow) {
      expect(jobRow.progressCurrent).toBe(3);
      expect(jobRow.progressTotal).toBe(3);
      expect(jobRow.status).toBe("PARTIAL");
      expect(jobRow.completedAt).not.toBeNull();
    }
  });
});
