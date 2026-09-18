// src/lib/case-workspace/config.ts
// Phase 5 — Case Workspace configuration constants.
//
// File size limit, allowed MIME types/extensions, magic-byte signatures,
// parser limits, and storage root directory. Centralised so the upload
// policy, parser, and storage layers all agree on the same rules.

import type { DocumentType } from "./types";

// ---------------------------------------------------------------------------
// File size + page limits
// ---------------------------------------------------------------------------

/** Per-file upload size cap (50 MB). Large enough for 5000-page PDFs. */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Hard cap on pages per document (§6 — preserve page boundaries). */
export const MAX_PAGES_PER_DOCUMENT = 5000;

/** Per-document extraction wall-clock budget (60s). */
export const MAX_EXTRACTION_TIME_MS = 60_000;

// ---------------------------------------------------------------------------
// Allowed upload kinds
// ---------------------------------------------------------------------------

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
] as const;

export const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".doc", ".txt"] as const;

/** MIME → simple kind discriminator (used by parser). */
export type DocumentKind = "pdf" | "docx" | "doc" | "txt" | "unknown";

export function kindFromMime(mimeType: string): DocumentKind {
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (mimeType === "application/msword") return "doc";
  if (mimeType === "text/plain") return "txt";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Magic bytes (first 8 bytes is enough to discriminate)
// ---------------------------------------------------------------------------

/**
 * Magic-byte signatures (Phase 5 §6 — never trust the declared MIME; verify
 * the bytes). Each entry: the leading bytes that must match.
 */
export const MAGIC_BYTES: Record<DocumentKind, number[] | null> = {
  // %PDF (0x25 0x50 0x44 0x46)
  pdf: [0x25, 0x50, 0x44, 0x46],
  // PK\x03\x04 (ZIP / OOXML)
  docx: [0x50, 0x4b, 0x03, 0x04],
  // Legacy .doc (CFB): D0 CF 11 E0 A1 B1 1A E1
  doc: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  // Plain text — no magic bytes; we treat as "best-effort text".
  txt: null,
  unknown: null,
};

// ---------------------------------------------------------------------------
// Rejected kinds — never accept executable/script content (Phase 5 §6)
// ---------------------------------------------------------------------------

/** Extensions that MUST be rejected outright. Never execute uploaded content. */
export const REJECTED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".pl",
  ".php",
  ".jar",
  ".class",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".com",
  ".scr",
  ".msi",
  ".vbs",
  ".vba",
  ".wsf",
  ".app",
  ".command",
  ".deb",
  ".rpm",
  ".dmg",
  ".pkg",
]);

// ---------------------------------------------------------------------------
// Document-type heuristics (default heuristics — not authoritative)
// ---------------------------------------------------------------------------

/**
 * Best-effort DocumentType inference from filename keywords. The user can
 * always override via the registry's `updateDocumentMetadata` API.
 */
export function inferDocumentType(filename: string): DocumentType {
  const f = filename.toLowerCase();
  if (/\bdecision\b|verdict|sentence|judg(e?ment)|ruling|դատավճիռ|որոշում/.test(f))
    return "COURT_DECISION";
  if (/indictment|accusation|մեղադր|կարճ/.test(f)) return "INDICTMENT";
  if (/charge|կանխավարկ/.test(f)) return "CHARGE_DECISION";
  if (/search|բնութագրո?ւ?չ|search.?protocol/.test(f)) return "SEARCH_PROTOCOL";
  if (/seizure|առգրավ/.test(f)) return "SEIZURE_PROTOCOL";
  if (/interrogation|question|հարցաքնն|ցուցմունք/.test(f)) return "INTERROGATION";
  if (/expert|փորձաքննությ/.test(f)) return "EXPERT_REPORT";
  if (/motion|petition|միջնորդ/.test(f)) return "MOTION";
  if (/appeal|բողոք/.test(f) && /cassation|վճռաբեկ/.test(f))
    return "CASSATION_APPEAL";
  if (/appeal|բողոք/.test(f)) return "APPEAL";
  if (/notice|notification|ծանուց/.test(f)) return "NOTICE";
  if (/postal|post|նամակ|փոստ/.test(f)) return "POSTAL_RECORD";
  if (/contract|agreement|պայմանագիր/.test(f)) return "CONTRACT";
  if (/payment|invoice|փողհան|վճար/.test(f)) return "PAYMENT_RECORD";
  if (/medical|diagnosis|բժշկ|առողջական/.test(f)) return "MEDICAL_RECORD";
  if (/letter|official|նամակ|պաշտոնական/.test(f)) return "OFFICIAL_LETTER";
  if (/evidence|exhibit|ապացույց/.test(f)) return "EVIDENCE_ATTACHMENT";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Storage root
// ---------------------------------------------------------------------------

/**
 * Root directory for case storage. Override via env (per §19 — storage paths
 * are server-only; never exposed to UI).
 */
export const STORAGE_ROOT =
  process.env.CASE_STORAGE_ROOT ?? "/tmp/haydevlegal-case-storage";

/** Archive root (§19 — archive-first delete). */
export const ARCHIVE_ROOT =
  process.env.CASE_ARCHIVE_ROOT ?? "/tmp/haydevlegal-case-archive";

// ---------------------------------------------------------------------------
// Job runner limits
// ---------------------------------------------------------------------------

/** How long an INGEST job can stay RUNNING before being considered stale. */
export const JOB_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

/** Max documents processed per single ingestBatch call (safety). */
export const MAX_FILES_PER_BATCH = 1000;
