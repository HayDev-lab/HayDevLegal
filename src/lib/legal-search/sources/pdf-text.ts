// src/lib/legal-search/sources/pdf-text.ts
// Shared PDF → text extraction (pdftotext). Extracted from the working
// Constitutional Court adapter so the Universal Document Resolver can use
// the same battle-tested path for any official PDF discovered online.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

let pdftotextAvailable: boolean | null = null;

/** Extract text from PDF bytes via pdftotext (bounded). Null when unavailable. */
export async function pdfToText(bytes: Uint8Array): Promise<string | null> {
  if (pdftotextAvailable === false) return null;
  const dir = await mkdtemp(join(tmpdir(), "legal-pdf-"));
  try {
    const pdfPath = join(dir, "document.pdf");
    await writeFile(pdfPath, bytes);
    const { stdout } = await execFileP("pdftotext", ["-enc", "UTF-8", pdfPath, "-"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 12_000,
    });
    pdftotextAvailable = true;
    return stdout;
  } catch {
    pdftotextAvailable = false;
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
