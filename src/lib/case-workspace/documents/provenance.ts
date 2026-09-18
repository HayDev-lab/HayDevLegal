// src/lib/case-workspace/documents/provenance.ts
// Phase 5 — JSON (de)serialisation helpers for the JSON-typed Prisma fields.
//
// SQLite (via Prisma) stores arrays/objects as JSON-serialised String
// columns. The service layer converts raw rows → parsed TypeScript types
// using these helpers. They are defensive: bad/missing/empty values fall
// back to `[]` / `null`, never throw.

import type { EvidenceRef } from "../types";

// ---------------------------------------------------------------------------
// EvidenceRef helpers
// ---------------------------------------------------------------------------

/** Serialise an EvidenceRef to a JSON string (for prisma String column). */
export function serializeEvidenceRef(ref: EvidenceRef): string {
  return JSON.stringify(ref);
}

/** Parse a JSON-string EvidenceRef. Returns null on parse failure. */
export function parseEvidenceRef(json: string | null | undefined): EvidenceRef | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    if (typeof v.documentId !== "string") return null;
    return v as EvidenceRef;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON-string EvidenceRef stored on a NOT-NULL column.
 * Falls back to a placeholder `{ documentId: "__missing__" }` so callers
 * that assume non-null keep type-checking happy while still surfacing the
 * data integrity problem at the UI layer.
 */
export function parseEvidenceRefRequired(
  json: string | null | undefined,
): EvidenceRef {
  return parseEvidenceRef(json) ?? { documentId: "__missing__" };
}

// ---------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------

/** Serialise any array to a JSON string (for prisma String column). */
export function serializeArray(arr: unknown[]): string {
  return JSON.stringify(arr);
}

/** Parse a JSON-string array. Falls back to [] on any failure. */
export function parseArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v as T[];
  } catch {
    return [];
  }
}

/** Parse a JSON-string array of EvidenceRef. Falls back to []. */
export function parseEvidenceRefArray(
  json: string | null | undefined,
): EvidenceRef[] {
  return parseArray<EvidenceRef>(json).filter(
    (r) => r && typeof r.documentId === "string",
  );
}

/** Parse a JSON-string array of strings. Falls back to []. */
export function parseStringArray(json: string | null | undefined): string[] {
  return parseArray<string>(json).filter((r) => typeof r === "string");
}

// ---------------------------------------------------------------------------
// Object helpers
// ---------------------------------------------------------------------------

/** Serialise any plain object to a JSON string (for prisma String column). */
export function serializeObject(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Parse a JSON-string object. Falls back to fallback on any failure. */
export function parseObject<T>(
  json: string | null | undefined,
  fallback: T,
): T {
  if (!json) return fallback;
  try {
    const v = JSON.parse(json);
    if (typeof v !== "object" || v === null) return fallback;
    return v as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Provenance envelope helper
// ---------------------------------------------------------------------------

/**
 * Build a minimal provenance envelope (Phase 5 §6).
 * Used by analysis subagents when persisting extracted items — every
 * event/fact/claim/entity must carry this so the UI can trace back to the
 * source page.
 */
export function buildProvenance(input: {
  caseId: string;
  volumeId?: string | null;
  documentId?: string;
  page?: number;
  section?: string;
  originalFilename?: string;
  contentHash?: string;
}) {
  return {
    caseId: input.caseId,
    volumeId: input.volumeId ?? null,
    documentId: input.documentId,
    page: input.page,
    section: input.section,
    originalFilename: input.originalFilename,
    contentHash: input.contentHash,
  };
}
