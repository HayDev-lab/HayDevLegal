// src/lib/case-workspace/documents/dedup.ts
// Phase 5 — SHA-256 content hashing + duplicate detection.
//
// §6 — exact duplicate detection by content hash. The same file uploaded
// to two volumes (or the same volume twice) is parsed once; subsequent
// uploads create a logical CaseDocument row that references the existing
// parsed content via the same sha256 + storageKey. This is the §7
// incremental/resumability primitive: new volumes don't reprocess
// unchanged old volumes.

import { createHash } from "node:crypto";

import { db } from "../db";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Compute the SHA-256 hex digest of an arbitrary byte buffer. */
export function computeSha256(bytes: Uint8Array): string {
  const hash = createHash("sha256");
  // node crypto accepts Uint8Array | ArrayBuffer | string | Buffer.
  hash.update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return hash.digest("hex");
}

/** Compute the SHA-256 hex digest of a string (UTF-8 encoded). */
export function computeSha256OfString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export interface DuplicateLookup {
  /** Whether a CaseDocument row with the same sha256 already exists. */
  duplicate: boolean;
  /** If duplicate, the existing CaseDocument's id. */
  existingDocumentId?: string;
  /** If duplicate, the existing CaseDocument's caseId (could be a different case — but content is shared). */
  existingCaseId?: string;
  /** If duplicate, the existing CaseDocument's storageKey (reused for byte storage). */
  existingStorageKey?: string;
}

/**
 * Find an existing CaseDocument with the given SHA-256 content hash.
 * Per §6 — exact duplicate detection. Per §7 — content is reused across
 * volumes; we do NOT re-parse the same file twice.
 *
 * NOTE: cross-case dedup is intentional. The same evidence document
 * attached to two different cases is parsed once; both CaseDocument rows
 * point at the same storageKey + parsed pages. Provenance still records
 * the right caseId on every derived item.
 */
export async function findDuplicate(
  sha256: string,
): Promise<DuplicateLookup> {
  const existing = await db.caseDocument.findFirst({
    where: { sha256 },
    select: {
      id: true,
      caseId: true,
      storageKey: true,
    },
  });
  if (!existing) {
    return { duplicate: false };
  }
  return {
    duplicate: true,
    existingDocumentId: existing.id,
    existingCaseId: existing.caseId,
    existingStorageKey: existing.storageKey,
  };
}

/**
 * Convenience: hash the bytes and look up the resulting digest.
 */
export async function isExactDuplicate(
  bytes: Uint8Array,
): Promise<DuplicateLookup> {
  const sha = computeSha256(bytes);
  return findDuplicate(sha);
}

/**
 * Check whether a duplicate exists within a specific case (same content
 * already uploaded to this case). Used by the API to surface "already
 * uploaded" warnings.
 */
export async function findDuplicateInCase(
  caseId: string,
  sha256: string,
): Promise<DuplicateLookup> {
  const existing = await db.caseDocument.findFirst({
    where: { caseId, sha256 },
    select: { id: true, caseId: true, storageKey: true },
  });
  if (!existing) return { duplicate: false };
  return {
    duplicate: true,
    existingDocumentId: existing.id,
    existingCaseId: existing.caseId,
    existingStorageKey: existing.storageKey,
  };
}
