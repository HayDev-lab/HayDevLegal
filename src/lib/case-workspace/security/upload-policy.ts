// src/lib/case-workspace/security/upload-policy.ts
// Phase 5 — file validation gate.
//
// SECURITY (Phase 5 §6):
//   * Reject executables/scripts outright — never execute uploaded content.
//   * Verify the actual bytes (magic bytes), not just the declared MIME.
//   * Enforce the per-file size cap.
//   * Only accept explicitly allow-listed extensions + MIME types.
//
// This module is pure (no I/O, no DB) so it can be unit-tested in isolation
// and called from both the API route handler and the ingestion orchestrator.

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAGIC_BYTES,
  MAX_FILE_SIZE_BYTES,
  REJECTED_EXTENSIONS,
  kindFromMime,
} from "../config";

export type FileValidationResult =
  | { ok: true; kind: ReturnType<typeof kindFromMime> }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot).toLowerCase();
}

function matchesMagicBytes(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Detect whether the file's leading bytes are obviously executable/script
 * content even though the extension claims otherwise. This is a defence-
 * in-depth check — we already reject by extension, but we also reject by
 * signature so a renamed payload cannot slip past.
 */
function looksLikeExecutableOrScript(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  // DOS/PE: "MZ" — .exe/.dll
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  // ELF: 0x7F "ELF"
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
    return true;
  // Mach-O (32-bit): FE ED FA FE / 64-bit: FE ED FA FE
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xfe &&
    bytes[1] === 0xed &&
    bytes[2] === 0xfa &&
    (bytes[3] === 0xfe || bytes[3] === 0xce)
  )
    return true;
  // Shell scripts: shebang "#!"
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return true;
  // Java class file: CA FE BA BE
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xca &&
    bytes[1] === 0xfe &&
    bytes[2] === 0xba &&
    bytes[3] === 0xbe
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an uploaded file before it touches the storage layer.
 * Returns `{ ok: true, kind }` on success, `{ ok: false, reason }` on
 * rejection. The `kind` field lets the caller route to the right parser.
 */
export function validateFile(
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): FileValidationResult {
  // 1. Filename sanity.
  if (!filename || typeof filename !== "string") {
    return { ok: false, reason: "Filename is required" };
  }
  if (filename.length > 255) {
    return { ok: false, reason: "Filename is too long (max 255 chars)" };
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return { ok: false, reason: "Filename must not contain path separators" };
  }
  if (filename.includes("\0")) {
    return { ok: false, reason: "Filename contains null byte" };
  }

  const ext = getExtension(filename);

  // 2. Reject executables/scripts outright (§6 — never execute uploaded content).
  if (REJECTED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `Executable/script extension "${ext}" is not allowed`,
    };
  }

  // 3. Check extension allow-list.
  const allowedExtList = ALLOWED_EXTENSIONS as readonly string[];
  if (!allowedExtList.includes(ext)) {
    return {
      ok: false,
      reason: `Extension "${ext || "(none)"}" is not allowed. Allowed: ${allowedExtList.join(", ")}`,
    };
  }

  // 4. Check MIME allow-list.
  const allowedMimeList = ALLOWED_MIME_TYPES as readonly string[];
  if (!allowedMimeList.includes(mimeType)) {
    return {
      ok: false,
      reason: `MIME type "${mimeType}" is not allowed. Allowed: ${allowedMimeList.join(", ")}`,
    };
  }

  // 5. Extension ↔ MIME must agree (defence in depth).
  const kind = kindFromMime(mimeType);
  const expectedExtByKind: Record<string, string> = {
    pdf: ".pdf",
    docx: ".docx",
    doc: ".doc",
    txt: ".txt",
  };
  if (expectedExtByKind[kind] !== ext) {
    return {
      ok: false,
      reason: `Extension "${ext}" does not match MIME "${mimeType}"`,
    };
  }

  // 6. Size cap.
  if (bytes.length === 0) {
    return { ok: false, reason: "File is empty" };
  }
  if (bytes.length > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      reason: `File is too large: ${bytes.length} bytes (max ${MAX_FILE_SIZE_BYTES})`,
    };
  }

  // 7. Magic bytes (§6 — verify actual content, not the declared MIME).
  const signature = MAGIC_BYTES[kind];
  if (signature !== null) {
    if (!matchesMagicBytes(bytes, signature)) {
      return {
        ok: false,
        reason: `Magic bytes do not match expected signature for "${kind}"`,
      };
    }
  } else {
    // TXT has no magic bytes — but it must NOT look like an executable/script.
    if (looksLikeExecutableOrScript(bytes)) {
      return {
        ok: false,
        reason: "File content looks like an executable/script (rejected per §6)",
      };
    }
    // And it must contain at least one printable ASCII / UTF-8 character.
    if (!hasPrintableText(bytes)) {
      return {
        ok: false,
        reason: "File does not contain any printable text",
      };
    }
  }

  // 8. Final defence in depth: reject anything that looks like an
  // executable/script regardless of declared kind (handles edge cases like
  // a renamed .exe with a `.pdf` extension that nonetheless starts with MZ).
  if (looksLikeExecutableOrScript(bytes)) {
    return {
      ok: false,
      reason: "File content looks like an executable/script (rejected per §6)",
    };
  }

  return { ok: true, kind };
}

/**
 * TXT files have no magic bytes — check at least some bytes are printable
 * ASCII or valid UTF-8 (we accept 0x09 TAB, 0x0A LF, 0x0D CR, and 0x20–0x7E
 * plus any high-bit byte that could be UTF-8 lead).
 */
function hasPrintableText(bytes: Uint8Array, window: number = 4096): boolean {
  const limit = Math.min(bytes.length, window);
  let printable = 0;
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) {
      printable++;
      continue;
    }
    if (b >= 0x20 && b <= 0x7e) {
      printable++;
      continue;
    }
    if (b >= 0x80) {
      // High byte — could be UTF-8 lead/continuation. Count as printable.
      printable++;
      continue;
    }
    // Other control byte — leave alone.
  }
  // Require at least 1% of leading bytes to be printable to consider it text.
  return printable >= Math.max(1, Math.floor(limit / 100));
}
