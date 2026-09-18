// src/lib/case-workspace/documents/parser.ts
// Phase 5 — PDF / DOCX / DOC / TXT text extraction with explicit page
// boundaries (Phase 5 §6 — preserve page boundaries for evidence provenance).
//
// Strategy (per task spec):
//   * PDF  — try `pdfToText` (system pdftotext — battle-tested) first;
//            split output on the form-feed character (`\f`) that pdftotext
//            emits between pages. Use `pdfinfo` for the authoritative page
//            count. Fallback to `pdf-parse` (JS, pdfjs under the hood) for
//            per-page text. If both fail or every page is empty →
//            `requiresOcr=true`. We NEVER hallucinate text or mark
//            extraction successful when there is none.
//   * DOCX — `mammoth.extractRawText({ arrayBuffer })`. Mammoth doesn't
//            expose native page boundaries, so we split on form-feed tokens
//            (Word's manual page break character) and fall back to "page 1"
//            when none are present.
//   * DOC  — legacy CFB binary. Try mammoth (it occasionally handles
//            mis-labeled .docx). If extraction yields no text →
//            `requiresOcr=true`. No silent success.
//   * TXT  — UTF-8 decode. Split on form-feed if present, otherwise
//            treat the whole text as page 1.
//
// All public functions are bounded by `MAX_EXTRACTION_TIME_MS` so a single
// pathological document cannot stall an ingestBatch job.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pdfToText } from "@/lib/legal-search/sources/pdf-text";
import {
  MAX_EXTRACTION_TIME_MS,
  MAX_PAGES_PER_DOCUMENT,
  kindFromMime,
} from "../config";
import type { DocumentKind } from "../config";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PageExtractionStatus =
  | "SUCCESS"
  | "EMPTY"
  | "REQUIRES_OCR"
  | "FAILED";

export interface ParsedPage {
  pageNumber: number;
  originalText: string;
  normalizedText: string;
  extractionStatus: PageExtractionStatus;
}

export interface ParseResult {
  pages: ParsedPage[];
  pageCount: number;
  requiresOcr: boolean;
}

export interface ParseOptions {
  maxPages?: number;
  timeoutMs?: number;
}

const DEFAULT_OPTS: Required<ParseOptions> = {
  maxPages: MAX_PAGES_PER_DOCUMENT,
  timeoutMs: MAX_EXTRACTION_TIME_MS,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a document into pages.
 *
 * @param mimeType Declared MIME (already validated by upload-policy)
 * @param bytes    Raw bytes
 * @param opts     maxPages / timeoutMs overrides
 */
export async function parseDocument(
  mimeType: string,
  bytes: Uint8Array,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const o = { ...DEFAULT_OPTS, ...opts };
  const kind = kindFromMime(mimeType);

  switch (kind) {
    case "pdf":
      return parsePdf(bytes, o);
    case "docx":
      return parseDocx(bytes, o);
    case "doc":
      return parseDoc(bytes, o);
    case "txt":
      return parseTxt(bytes, o);
    default:
      return { pages: [], pageCount: 0, requiresOcr: true };
  }
}

// ---------------------------------------------------------------------------
// Normalisation (deterministic — no LLM)
// ---------------------------------------------------------------------------

/**
 * Normalise page text: collapse runs of whitespace, strip BOM, and trim.
 * Used as the `normalizedText` field on DocumentPage rows so the search
 * index has a stable surface.
 */
export function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .replace(/^\uFEFF/, "") // strip BOM
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// PDF parser
// ---------------------------------------------------------------------------

async function parsePdf(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
): Promise<ParseResult> {
  // 1. Get authoritative page count from `pdfinfo`. If unavailable, fall
  //    back to counting form-feeds in the extracted text (1 + count).
  const infoPageCount = await getPdfPageCount(bytes).catch(() => null);

  // 2. Try pdftotext (system tool — most reliable for text-layer PDFs).
  const text = await withTimeout(pdfToText(bytes), opts.timeoutMs).catch(
    () => null,
  );

  if (text && text.trim().length > 0) {
    // pdftotext emits a form-feed (\f, 0x0c) between pages.
    const rawPages = text.split("\f");
    const pageCount =
      infoPageCount ??
      rawPages.filter((p) => p.trim().length > 0).length ??
      rawPages.length;
    const capped = Math.min(pageCount, opts.maxPages);
    const pages: ParsedPage[] = [];
    for (let i = 0; i < capped; i++) {
      const pageText = rawPages[i] ?? "";
      const normalized = normalizeText(pageText);
      const status: PageExtractionStatus = normalized.length
        ? "SUCCESS"
        : "EMPTY";
      pages.push({
        pageNumber: i + 1,
        originalText: pageText,
        normalizedText: normalized,
        extractionStatus: status,
      });
    }

    // If ALL pages are empty (scanned PDF with no text layer), flag OCR.
    const anyText = pages.some((p) => p.normalizedText.length > 0);
    if (anyText) {
      return { pages, pageCount: capped, requiresOcr: false };
    }
    // else fall through to pdf-parse fallback, then OCR flag.
  }

  // 3. Fallback: pdf-parse (JS, pdfjs) for per-page text.
  const fallback = await withTimeout(parsePdfWithPdfParse(bytes, opts), opts.timeoutMs).catch(
    () => null,
  );
  if (fallback && fallback.pages.some((p) => p.normalizedText.length > 0)) {
    return fallback;
  }

  // 4. No text layer anywhere → scanned PDF. Mark requiresOcr=true and
  //    emit one empty page with REQUIRES_OCR status so the UI can show
  //    "page 1 needs OCR" instead of pretending success.
  const pageCount = Math.max(1, infoPageCount ?? 1);
  const capped = Math.min(pageCount, opts.maxPages);
  const pages: ParsedPage[] = [];
  for (let i = 0; i < capped; i++) {
    pages.push({
      pageNumber: i + 1,
      originalText: "",
      normalizedText: "",
      extractionStatus: "REQUIRES_OCR",
    });
  }
  return { pages, pageCount: capped, requiresOcr: true };
}

/** Use `pdfinfo` to get the page count. Returns null on any failure. */
async function getPdfPageCount(bytes: Uint8Array): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "case-pdfinfo-"));
  try {
    const pdfPath = join(dir, "doc.pdf");
    await writeFile(pdfPath, bytes);
    const { stdout } = await execFileP("pdfinfo", [pdfPath], {
      maxBuffer: 1 * 1024 * 1024,
      timeout: 8_000,
    });
    const match = stdout.match(/Pages:\s+(\d+)/i);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Fallback PDF parser using the `pdf-parse` JS package (pdfjs under the hood). */
async function parsePdfWithPdfParse(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
): Promise<ParseResult> {
  // Dynamic import — pdf-parse is ESM-only in v2.x.
  const mod = await import("pdf-parse");
  const PDFParse = (mod as { PDFParse?: new (opts: { data: Uint8Array }) => {
    getText: (params?: { first?: number; last?: number }) => Promise<{
      pages: Array<{ num: number; text: string }>;
      total: number;
      text: string;
    }>;
    destroy: () => Promise<void>;
  } }).PDFParse;
  if (!PDFParse) {
    throw new Error("pdf-parse: PDFParse export not found");
  }
  const instance = new PDFParse({ data: bytes });
  try {
    const result = await instance.getText({
      first: 1,
      last: Math.min(opts.maxPages, opts.maxPages),
    });
    const pages: ParsedPage[] = (result.pages ?? []).map((p) => {
      const normalized = normalizeText(p.text ?? "");
      return {
        pageNumber: p.num,
        originalText: p.text ?? "",
        normalizedText: normalized,
        extractionStatus: normalized.length ? "SUCCESS" : "EMPTY",
      };
    });
    return {
      pages,
      pageCount: result.total ?? pages.length,
      requiresOcr: pages.length > 0 && pages.every((p) => !p.normalizedText),
    };
  } finally {
    await instance.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// DOCX parser
// ---------------------------------------------------------------------------

async function parseDocx(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
): Promise<ParseResult> {
  try {
    const mammoth = await import("mammoth");
    // mammoth 1.12.x Node.js runtime expects `buffer: Buffer` (the
    // TypeScript types declare `arrayBuffer` for BrowserInput, but the
    // runtime `openZip` only routes via `path` / `buffer` / `file`).
    // Phase 5.1 §25.B stress test surfaced this — the previous call
    // `extractRawText({ arrayBuffer })` threw "Could not find file in
    // options" at runtime, so DOCX parsing always fell into the catch
    // branch and returned extractionStatus=FAILED + requiresOcr=true.
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await withTimeout(
      mammoth.extractRawText({ buffer: buf }),
      opts.timeoutMs,
    );
    const text = result?.value ?? "";
    if (!text.trim()) {
      // Empty docx — return one empty page so the UI can show the truth.
      return {
        pages: [
          {
            pageNumber: 1,
            originalText: "",
            normalizedText: "",
            extractionStatus: "EMPTY",
          },
        ],
        pageCount: 1,
        requiresOcr: false,
      };
    }
    return splitByFormFeed(text, opts.maxPages);
  } catch {
    // mammoth failed on what was declared as DOCX — treat as failure + OCR flag.
    return {
      pages: [
        {
          pageNumber: 1,
          originalText: "",
          normalizedText: "",
          extractionStatus: "FAILED",
        },
      ],
      pageCount: 1,
      requiresOcr: true,
    };
  }
}

// ---------------------------------------------------------------------------
// DOC (legacy) parser
// ---------------------------------------------------------------------------

async function parseDoc(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
): Promise<ParseResult> {
  // mammoth does NOT support legacy .doc (CFB binary). Try anyway (in case
  // the file is mis-labeled .docx); if it fails, mark requiresOcr=true so
  // the operator can convert it. We never pretend success.
  try {
    const mammoth = await import("mammoth");
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await withTimeout(
      mammoth.extractRawText({ buffer: buf }),
      opts.timeoutMs,
    );
    const text = result?.value ?? "";
    if (!text.trim()) {
      return {
        pages: [
          {
            pageNumber: 1,
            originalText: "",
            normalizedText: "",
            extractionStatus: "REQUIRES_OCR",
          },
        ],
        pageCount: 1,
        requiresOcr: true,
      };
    }
    return splitByFormFeed(text, opts.maxPages);
  } catch {
    return {
      pages: [
        {
          pageNumber: 1,
          originalText: "",
          normalizedText: "",
          extractionStatus: "REQUIRES_OCR",
        },
      ],
      pageCount: 1,
      requiresOcr: true,
    };
  }
}

// ---------------------------------------------------------------------------
// TXT parser
// ---------------------------------------------------------------------------

async function parseTxt(
  bytes: Uint8Array,
  opts: Required<ParseOptions>,
): Promise<ParseResult> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(bytes);
  if (!text.trim()) {
    return {
      pages: [
        {
          pageNumber: 1,
          originalText: "",
          normalizedText: "",
          extractionStatus: "EMPTY",
        },
      ],
      pageCount: 1,
      requiresOcr: false,
    };
  }
  return splitByFormFeed(text, opts.maxPages);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Split text on form-feed (`\f`); if none, treat whole text as page 1. */
function splitByFormFeed(text: string, maxPages: number): ParseResult {
  const rawPages = text.split("\f");
  const hasFormFeed = rawPages.length > 1;
  const pageCount = Math.min(
    hasFormFeed ? rawPages.length : 1,
    maxPages,
  );
  const pages: ParsedPage[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageText = rawPages[i] ?? "";
    const normalized = normalizeText(pageText);
    pages.push({
      pageNumber: i + 1,
      originalText: pageText,
      normalizedText: normalized,
      extractionStatus: normalized.length ? "SUCCESS" : "EMPTY",
    });
  }
  return { pages, pageCount, requiresOcr: false };
}

/** Wrap a promise with a timeout. Rejects with Error on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Parser exceeded timeout of ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// (Removed `ensureArrayBuffer` — mammoth 1.12.x Node.js runtime expects a
// `Buffer` (via `openZip`'s `buffer` branch), not an `arrayBuffer: ArrayBuffer`.
// The Phase 5.1 §25.B stress test caught this. See parseDocx/parseDoc above.)

// ---------------------------------------------------------------------------
// Misc helpers exported for tests / inspection
// ---------------------------------------------------------------------------

/** Inspect-only: returns the kind the parser will dispatch on for a given MIME. */
export function parserKindFor(mimeType: string): DocumentKind {
  return kindFromMime(mimeType);
}
