// src/lib/legal-drafting/export/index.ts
// Phase 6 — §28 — Export dispatcher.
//
// Single entry point for exporting a draft version in any of the supported
// formats (DOCX, PDF, TXT). Per §28:
//   - DOCX is always allowed (it's editable downstream).
//   - PDF is allowed only from VERIFIED / PARTIAL / NEEDS_REVIEW state
//     (reviewed/verified only).
//   - TXT is always allowed (it's a plain rendering).
//
// CRITICAL — §10: "normal export renders human-readable legal citations,
//                  NOT debug IDs (F1/C2 etc.)" — all three formats replace
//                  internal source ids with human-readable citations.
// CRITICAL — §28: "attachment list must contain only actual workspace
//                  documents".

import { exportDocx } from "@/lib/legal-drafting/export/docx";
import { exportPdf } from "@/lib/legal-drafting/export/pdf";
import { exportTxt } from "@/lib/legal-drafting/export/txt";

export { exportDocx } from "@/lib/legal-drafting/export/docx";
export { exportPdf } from "@/lib/legal-drafting/export/pdf";
export { exportTxt } from "@/lib/legal-drafting/export/txt";

export type ExportFormat = "docx" | "pdf" | "txt";

/**
 * §28 — Export a draft version in the requested format.
 *
 * @param draftId   the LegalDraft id
 * @param versionId the DraftVersion id
 * @param format    "docx" | "pdf" | "txt"
 * @returns Uint8Array (docx / pdf) or string (txt)
 * @throws when the format is unsupported, when the draft / version doesn't
 *         exist, or when PDF export is requested on an UNVERIFIED version
 *         (§28 — only reviewed/verified state may be exported to PDF).
 */
export async function exportDraft(
  draftId: string,
  versionId: string,
  format: ExportFormat,
): Promise<Uint8Array | string> {
  switch (format) {
    case "docx":
      return exportDocx(draftId, versionId);
    case "pdf":
      return exportPdf(draftId, versionId);
    case "txt":
      return exportTxt(draftId, versionId);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`);
    }
  }
}
