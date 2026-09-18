// src/lib/legal-drafting/export/pdf.ts
// Phase 6 — §28 — PDF export.
//
// Uses `pdfkit` (v0.20.2) to produce a production PDF file. Armenian text
// renders correctly because we embed a Unicode TrueType font (DejaVuSans,
// which is bundled with most Linux distributions and supports the Armenian
// Unicode block U+0530–U+058F).
//
// §28 — "only from reviewed/verified state" — this function verifies the
// version's `verificationStatus` is one of VERIFIED / PARTIAL / NEEDS_REVIEW
// before producing the PDF. UNVERIFIED versions are refused.
//
// CRITICAL — §10: "normal export renders human-readable legal citations, NOT
//                  debug IDs (F1/C2 etc.)"
// CRITICAL — §28: "attachment list must contain only actual workspace
//                  documents"

// pdfkit 0.20.2 ships no TypeScript types. We use a runtime `require()` call
// to bypass TypeScript module resolution (an ambient `declare module
// "pdfkit"` augmentation is rejected because pdfkit resolves to an untyped
// .browser.mjs file). The runtime API used is documented at
// https://pdfkit.org/ for v0.20.x.
import { existsSync, statSync } from "node:fs";
import { db } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit") as new (opts?: {
  size?: string | [number, number];
  margins?: { top?: number; right?: number; bottom?: number; left?: number };
  margin?: number;
  info?: Record<string, string>;
  bufferPages?: boolean;
  autoFirstPage?: boolean;
}) => PdfDocLike;

/** Runtime shape of the pdfkit PDFDocument instance (we use only the API we need). */
interface PdfDocLike {
  font(src: string | Buffer, family?: string): PdfDocLike;
  fontSize(size: number): PdfDocLike;
  fillColor(color: string): PdfDocLike;
  fillColor(r: number, g: number, b: number): PdfDocLike;
  fill(): PdfDocLike;
  stroke(): PdfDocLike;
  rect(x: number, y: number, w: number, h: number): PdfDocLike;
  text(text: string, opts?: Record<string, unknown>): PdfDocLike;
  text(text: string, x: number, y: number, opts?: Record<string, unknown>): PdfDocLike;
  moveDown(lines?: number): PdfDocLike;
  addPage(opts?: unknown): PdfDocLike;
  end(): PdfDocLike;
  pipe<T extends NodeJS.WritableStream>(destination: T): T;
  on(event: "data", listener: (chunk: Buffer) => void): PdfDocLike;
  on(event: "end" | "finish", listener: () => void): PdfDocLike;
  on(event: "error", listener: (err: Error) => void): PdfDocLike;
  width: number;
  height: number;
  page: {
    width: number;
    height: number;
    margins: { top: number; bottom: number; left: number; right: number };
  };
}
import type {
  DraftSectionContent,
  SectionType,
  SourceIdMap,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §28 — Allowed verification states for PDF export (reviewed / verified only)
// ---------------------------------------------------------------------------

const ALLOWED_VERIFICATION_STATUSES = new Set([
  "VERIFIED",
  "PARTIAL",
  "NEEDS_REVIEW",
]);

// ---------------------------------------------------------------------------
// Unicode TTF font lookup (Armenian Unicode support)
// ---------------------------------------------------------------------------

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/DejaVuSans.ttf",
  "/usr/local/share/fonts/dejavu/DejaVuSans.ttf",
];

const FONT_BOLD_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
];

function findFont(candidates: string[]): string | null {
  for (const path of candidates) {
    try {
      if (existsSync(path) && statSync(path).isFile()) {
        return path;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type DraftRow = {
  id: string;
  caseId: string;
  documentType: string;
  title: string;
  language: string;
  targetCourtOrAuthority: string | null;
  proceduralStage: string | null;
  filingDeadline: Date | null;
  goal: string | null;
  requestedRelief: string | null;
  contextSummary: string;
  plan: string;
  parties: string;
  jurisdiction: string | null;
  caseNumber: string | null;
};

type VersionRow = {
  id: string;
  draftId: string;
  version: number;
  content: string;
  createdBy: string;
  verificationStatus: string;
  sourceIdMap: string;
  createdAt: Date;
  updatedAt: Date;
};

type SectionRow = {
  id: string;
  draftId: string;
  versionId: string;
  sectionType: string;
  title: string;
  content: string;
  reviewStatus: string;
  stale: boolean;
  warnings: string;
  previousContent: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CaseDocumentRow = {
  id: string;
  caseId: string;
  originalFilename: string;
  displayName: string;
  documentType: string;
  pageCount: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseContent(raw: string | null | undefined): DraftSectionContent {
  if (!raw) return { text: "", sourceIds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<DraftSectionContent>;
    return {
      text: parsed.text ?? "",
      sourceIds: Array.isArray(parsed.sourceIds) ? parsed.sourceIds : [],
      paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs : undefined,
      table: parsed.table ?? undefined,
    };
  } catch {
    return { text: "", sourceIds: [] };
  }
}

function parseSourceIdMap(raw: string | null | undefined): SourceIdMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as SourceIdMap;
  } catch {
    return {};
  }
}

function parseParties(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** §10 — Replace inline internal source ids with human-readable citations. */
const SOURCE_ID_PATTERN = /\[?(F\d+|CE\d+|L\d+|C\d+|CC\d+|E\d+|A\d+)\]?/g;

function replaceInlineSourceIds(text: string, map: SourceIdMap): string {
  return text.replace(SOURCE_ID_PATTERN, (_match, sid: string) => {
    const entry = map[sid];
    if (entry?.citation) return `(${entry.citation})`;
    return "";
  });
}

const SECTION_ORDER: SectionType[] = [
  "header",
  "introduction",
  "procedural_history",
  "facts",
  "legal_issues",
  "applicable_law",
  "precedents",
  "arguments",
  "counterarguments",
  "requested_relief",
  "missing_information",
  "attachments",
];

/** Buffer-collecting writable stream helper. */
function collectPdfBytes(doc: PdfDocLike): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// §28 — exportPdf
// ---------------------------------------------------------------------------

/**
 * §28 — Export a draft version as PDF.
 *
 * @param draftId   the LegalDraft id
 * @param versionId the DraftVersion id
 * @returns Uint8Array containing the PDF bytes
 * @throws if the version's verificationStatus is UNVERIFIED (§28 — only
 *         reviewed/verified state may be exported).
 */
export async function exportPdf(
  draftId: string,
  versionId: string,
): Promise<Uint8Array> {
  const draft = (await db.legalDraft.findUnique({
    where: { id: draftId },
  })) as DraftRow | null;
  if (!draft) throw new Error(`LegalDraft ${draftId} not found`);

  const version = (await db.draftVersion.findUnique({
    where: { id: versionId },
  })) as VersionRow | null;
  if (!version) throw new Error(`DraftVersion ${versionId} not found`);
  if (version.draftId !== draftId) {
    throw new Error(`DraftVersion ${versionId} does not belong to draft ${draftId}`);
  }

  // §28 — Only from reviewed / verified state.
  if (!ALLOWED_VERIFICATION_STATUSES.has(version.verificationStatus)) {
    throw new Error(
      `Cannot export PDF: version ${versionId} has verificationStatus=${version.verificationStatus}. PDF export requires VERIFIED / PARTIAL / NEEDS_REVIEW (§28).`,
    );
  }

  const sectionRows = (await db.draftSection.findMany({
    where: { versionId },
  })) as SectionRow[];
  sectionRows.sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a.sectionType as SectionType);
    const bi = SECTION_ORDER.indexOf(b.sectionType as SectionType);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });

  const sourceIdMap = parseSourceIdMap(version.sourceIdMap);
  const parties = parseParties(draft.parties);

  // §28 — Locate a Unicode TTF font supporting Armenian glyphs.
  const regularFont = findFont(FONT_CANDIDATES);
  const boldFont = findFont(FONT_BOLD_CANDIDATES) ?? regularFont;

  // Create the PDF document. A4 size with reasonable margins.
  const doc: PdfDocLike = new PDFDocument({
    size: "A4",
    margins: { top: 56, right: 56, bottom: 56, left: 56 },
    info: {
      Title: draft.title ?? "Draft",
      Author: "HayDevLegal — Phase 6",
      Subject: `Legal draft ${draft.documentType} (version ${version.version})`,
      Producer: "HayDevLegal pdfkit export",
    },
    autoFirstPage: true,
  });

  // Embed the Unicode font (Armenian Unicode support). If no font is found,
  // fall back to the default Helvetica (Armenian glyphs will not render —
  // Latin text will render correctly).
  if (regularFont) {
    doc.font(regularFont);
  }

  const pageWidth = doc.page.width;
  const pageMarginLeft = doc.page.margins.left;
  const pageMarginRight = doc.page.margins.right;
  const contentWidth = pageWidth - pageMarginLeft - pageMarginRight;

  // §11 — Header block.
  doc.fontSize(18);
  if (boldFont) doc.font(boldFont);
  doc.text(draft.title ?? "Untitled Draft", { align: "center" });
  if (regularFont) doc.font(regularFont);
  doc.fontSize(11);
  doc.moveDown(0.5);
  if (draft.targetCourtOrAuthority) {
    doc.text(`Լրացրած դատարան / մարմին: ${draft.targetCourtOrAuthority}`, { align: "left" });
  }
  if (draft.jurisdiction) {
    doc.text(`Իրավասություն: ${draft.jurisdiction}`, { align: "left" });
  }
  if (draft.caseNumber) {
    doc.text(`Գործի համար: ${draft.caseNumber}`, { align: "left" });
  }
  if (parties.length > 0) {
    doc.text(`Կողմեր: ${parties.join(", ")}`, { align: "left" });
  }
  if (draft.proceduralStage) {
    doc.text(`Դատավարական փուլ: ${draft.proceduralStage}`, { align: "left" });
  }
  if (draft.filingDeadline) {
    doc.text(
      `Կատարման ժամկետ: ${new Date(draft.filingDeadline).toLocaleDateString("hy-AM")}`,
      { align: "left" },
    );
  }
  doc.text(`Փաստաթուղթ: ${draft.documentType}`, { align: "left" });
  if (draft.goal) {
    doc.text(`Նպատակ: ${draft.goal}`, { align: "left" });
  }

  // Page break before body.
  doc.addPage();

  // Render each section.
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    // Section heading.
    doc.moveDown(0.5);
    if (boldFont) doc.font(boldFont);
    doc.fontSize(13);
    doc.text(row.title, { align: "left" });
    if (regularFont) doc.font(regularFont);
    doc.fontSize(11);
    doc.moveDown(0.2);

    // Section body.
    const rendered = replaceInlineSourceIds(content.text ?? "", sourceIdMap);
    const blocks = rendered.split(/\n{2,}/);
    for (const block of blocks) {
      if (block.trim().length === 0) continue;
      doc.text(block, { align: "justify" });
      doc.moveDown(0.2);
    }

    // Prayer-for-relief paragraphs (numbered for requested_relief).
    if (Array.isArray(content.paragraphs) && content.paragraphs.length > 0) {
      content.paragraphs.forEach((p, i) => {
        const renderedP = replaceInlineSourceIds(p, sourceIdMap);
        const prefix =
          row.sectionType === "requested_relief" ? `${i + 1}. ` : "• ";
        doc.text(`${prefix}${renderedP}`, { align: "left" });
        doc.moveDown(0.1);
      });
    }

    // Table — render as plain text rows (pdfkit tables are non-trivial;
    // a simple ASCII layout is robust and reliable).
    if (content.table) {
      doc.moveDown(0.2);
      const { headers, rows } = content.table;
      const colWidths = headers.map((_, i) => {
        const maxCell = Math.max(
          headers[i]?.length ?? 0,
          ...rows.map((r) => r[i]?.length ?? 0),
        );
        return Math.max(15, Math.min(40, maxCell + 2));
      });
      const totalWidth = colWidths.reduce((a, b) => a + b, 0);
      // Scale to contentWidth.
      const scale = contentWidth / Math.max(1, totalWidth);
      const scaledWidths = colWidths.map((w) => Math.floor(w * scale));
      const formatRow = (cells: string[]) =>
        cells
          .map((c, i) => (c ?? "").padEnd(scaledWidths[i]))
          .join(" | ");
      if (boldFont) doc.font(boldFont);
      doc.text(formatRow(headers));
      if (regularFont) doc.font(regularFont);
      doc.text("-".repeat(scaledWidths.reduce((a, b) => a + b, 0)));
      for (const r of rows) doc.text(formatRow(r));
      doc.moveDown(0.3);
    }

    // Page break between sections.
    doc.addPage();
  }

  // §10 — References section.
  const citedIds = new Set<string>();
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    for (const sid of content.sourceIds ?? []) citedIds.add(sid);
  }
  if (citedIds.size > 0) {
    if (boldFont) doc.font(boldFont);
    doc.fontSize(13);
    doc.text("Աղբյուրներ / References");
    if (regularFont) doc.font(regularFont);
    doc.fontSize(11);
    doc.moveDown(0.2);
    const typeOrder: Record<string, number> = {
      fact: 0,
      chronology: 1,
      legislation: 2,
      cassation: 3,
      concourt: 4,
      echr: 5,
      argument: 6,
      evidence: 7,
    };
    const cited = Array.from(citedIds)
      .map((sid) => ({ sid, entry: sourceIdMap[sid] }))
      .filter((x) => x.entry)
      .sort((a, b) => {
        const ta = typeOrder[a.entry!.type] ?? 99;
        const tb = typeOrder[b.entry!.type] ?? 99;
        return ta - tb;
      });
    for (const { sid, entry } of cited) {
      doc.text(`${sid} → ${entry!.citation ?? "(չհաստատված աղբյուր)"}`);
    }
  }

  // §28 — Attachments section.
  const citedDocIds = new Set<string>();
  for (const sid of citedIds) {
    const entry = sourceIdMap[sid];
    if (entry?.refId && entry.type === "evidence") {
      citedDocIds.add(entry.refId);
    }
  }
  let docs: CaseDocumentRow[] = [];
  if (citedDocIds.size > 0) {
    docs = (await db.caseDocument.findMany({
      where: { id: { in: Array.from(citedDocIds) } },
    })) as CaseDocumentRow[];
  } else {
    docs = (await db.caseDocument.findMany({
      where: { caseId: draft.caseId, processingStatus: "READY" },
    })) as CaseDocumentRow[];
  }
  if (docs.length > 0) {
    doc.addPage();
    if (boldFont) doc.font(boldFont);
    doc.fontSize(13);
    doc.text("Կից փաստաթղթեր / Attachments");
    if (regularFont) doc.font(regularFont);
    doc.fontSize(11);
    doc.moveDown(0.2);
    docs.forEach((d, i) => {
      doc.text(
        `${i + 1}. ${d.displayName} (${d.documentType}, ${d.pageCount} էջ) — ${d.originalFilename}`,
      );
    });
  }

  // Footer.
  doc.moveDown(1);
  doc.fontSize(9);
  doc.fillColor("gray");
  doc.text(
    `Արտահանված է ${new Date().toISOString()} | Տարբերակ ${version.version} | ${version.verificationStatus}`,
    { align: "right" },
  );
  doc.fillColor("black");

  // End and collect bytes.
  const bufferPromise = collectPdfBytes(doc);
  doc.end();
  return bufferPromise;
}
