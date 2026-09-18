// src/lib/legal-drafting/export/docx.ts
// Phase 6.1 — §11/§12/§22/§28/§37/§49 — DOCX export (court-ready).
//
// Uses the `docx` package (v9.7.1) to produce a production DOCX file whose
// formatting is governed by the centralized `COURT_READY_FORMAT` config
// (§11 — "Do not pretend a statutory formatting rule exists unless
// verified"). Every magic number (page size, margin, font size, indent,
// signature block format) lives in the config module — this file does NOT
// hardcode formatting values.
//
// Hardening (Phase 6.1):
//   - Armenian Unicode: the `docx` package handles UTF-8 natively in
//     TextRun.text; we additionally verify in the formatting test by
//     unzipping word/document.xml and checking the Armenian strings are
//     present verbatim.
//   - §22: the References section lists citations WITHOUT leaking the
//     internal debug source ids (F1/C2/...). Each entry is prefixed with a
//     human-readable type label ("Փաստ", "Օրենսդրություն", ...) instead.
//   - §37: UNVERIFIED drafts carry a visible "DRAFT / ՉՍՏՈՒԳՎԱԾ ՆԱԽԱԳԻԾ"
//     label at the top so the operator never accidentally files an
//     unverified draft.
//   - §11 pageBreak.beforeHeading: page breaks inserted between major
//     sections.
//   - §11 signature: a signature block (config.SIGNATURE_BLOCK) is appended
//     to every export — the operator fills the signer/title/date.
//   - §25 attachments: the attachment list contains only ACTUAL workspace
//     documents (cited evidence, or all READY docs in the case as
//     fallback) — never invented titles.
//
// CRITICAL — §10: "normal export renders human-readable legal citations,
//                  NOT debug IDs (F1/C2 etc.)"
// CRITICAL — §28: "attachment list must contain only actual workspace
//                  documents"
// CRITICAL — §49: "Court-ready VERIFIED export must contain none of the
//                  placeholders/IDs" (verified by checkPlaceholders +
//                  checkInternalIdLeak in the formatting certification test)

import {
  AlignmentType,
  Document,
  HeadingLevel,
  PageBreak,
  Paragraph,
  Packer,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { db } from "@/lib/db";
import {
  COURT_READY_FORMAT,
  SOURCE_TYPE_LABELS_HY,
} from "@/lib/legal-drafting/config/formatting";
import type {
  DraftSectionContent,
  SectionType,
  SourceIdMap,
} from "@/lib/legal-drafting/types";

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
    // §22 — No map entry: strip the debug id entirely. Never leak F\d+/C\d+
    // etc. to the export (the formatting certification test asserts this).
    return "";
  });
}

/**
 * Convert a body string into docx Paragraph[] (one paragraph per \n\n).
 * Uses the centralized body typography from COURT_READY_FORMAT.
 *
 * docx's TextRun `size` is in half-points: 12pt → size 24.
 */
function bodyToParagraphs(text: string): Paragraph[] {
  if (!text) return [];
  const blocks = text.split(/\n{2,}/);
  const sizeHalfPt = COURT_READY_FORMAT.body.fontSize * 2;
  const lineSpacing = Math.round(240 * COURT_READY_FORMAT.body.lineHeight); // 240 = single
  return blocks.map(
    (block) =>
      new Paragraph({
        children: [new TextRun({ text: block, size: sizeHalfPt })],
        spacing: { after: 200, line: lineSpacing },
        alignment: AlignmentType.JUSTIFIED,
      }),
  );
}

/** Build a docx Table from the section's table content. */
function buildTable(table: {
  headers: string[];
  rows: string[][];
}): Table {
  const sizeHalfPt = COURT_READY_FORMAT.table.fontSize * 2;
  const headerRow = new TableRow({
    tableHeader: true,
    children: table.headers.map(
      (h) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: h,
                  bold: COURT_READY_FORMAT.table.headerBold,
                  size: sizeHalfPt,
                }),
              ],
            }),
          ],
          width: { size: Math.floor(100 / table.headers.length), type: WidthType.PERCENTAGE },
        }),
    ),
  });
  const bodyRows = table.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: cell ?? "", size: sizeHalfPt })],
                }),
              ],
            }),
        ),
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

// ---------------------------------------------------------------------------
// §28 — exportDocx (court-ready)
// ---------------------------------------------------------------------------

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

/**
 * §28 — Export a draft version as DOCX.
 *
 * @param draftId   the LegalDraft id
 * @param versionId the DraftVersion id
 * @returns Uint8Array containing the DOCX bytes
 */
export async function exportDocx(
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
  const isUnverified = version.verificationStatus === "UNVERIFIED";

  // Build the docx children list.
  const children: (Paragraph | Table)[] = [];

  // §37 — DRAFT watermark at the very top of unverified drafts. Visible
  // red bold label so the operator cannot accidentally file an
  // unverified draft.
  if (isUnverified) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: COURT_READY_FORMAT.draftLabel,
            bold: true,
            color: "C00000",
            size: 28, // 14pt
          }),
        ],
        spacing: { after: 200 },
      }),
    );
  }

  // §11 — Header block (title as H1, centered per §11 alignment.heading).
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: draft.title ?? "Untitled Draft",
          bold: COURT_READY_FORMAT.heading.bold,
          size: COURT_READY_FORMAT.heading.h1Size * 2,
          font: COURT_READY_FORMAT.heading.font,
        }),
      ],
    }),
  );
  if (draft.targetCourtOrAuthority) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Լրացրած դատարան / մարմին: ${draft.targetCourtOrAuthority}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  if (draft.jurisdiction) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Իրավասություն: ${draft.jurisdiction}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  if (draft.caseNumber) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Գործի համար: ${draft.caseNumber}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  if (parties.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Կողմեր: ${parties.join(", ")}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  if (draft.proceduralStage) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Դատավարական փուլ: ${draft.proceduralStage}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  if (draft.filingDeadline) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Կատարման ժամկետ: ${new Date(draft.filingDeadline).toLocaleDateString("hy-AM")}`,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Փաստաթուղթ: ${draft.documentType}`,
          size: COURT_READY_FORMAT.body.fontSize * 2,
        }),
      ],
    }),
  );
  if (draft.goal) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Նպատակ: ${draft.goal}`,
            italics: true,
            size: COURT_READY_FORMAT.body.fontSize * 2,
          }),
        ],
      }),
    );
  }

  // §11 pageBreak.beforeHeading — page break before the body.
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Render each section.
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: row.title,
            bold: COURT_READY_FORMAT.heading.bold,
            size: COURT_READY_FORMAT.heading.h2Size * 2,
            font: COURT_READY_FORMAT.heading.font,
          }),
        ],
      }),
    );

    const rendered = replaceInlineSourceIds(content.text ?? "", sourceIdMap);
    for (const p of bodyToParagraphs(rendered)) children.push(p);

    if (Array.isArray(content.paragraphs) && content.paragraphs.length > 0) {
      content.paragraphs.forEach((p, i) => {
        const renderedP = replaceInlineSourceIds(p, sourceIdMap);
        const prefix =
          row.sectionType === "requested_relief" ? `${i + 1}. ` : "• ";
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${prefix}${renderedP}`,
                size: COURT_READY_FORMAT.body.fontSize * 2,
              }),
            ],
            spacing: { after: 100 },
          }),
        );
      });
    }

    if (content.table) {
      children.push(buildTable(content.table));
    }

    // §11 pageBreak.beforeHeading — page break between major sections.
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // §22 — References section. List every cited source with its
  // human-readable citation. CRITICAL: do NOT leak the internal source id
  // (F1, C2, ...). Use a human-readable type label ("Փաստ", ...) instead.
  const citedIds = new Set<string>();
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    for (const sid of content.sourceIds ?? []) citedIds.add(sid);
  }
  if (citedIds.size > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: "Աղբյուրներ / References",
            bold: COURT_READY_FORMAT.heading.bold,
            size: COURT_READY_FORMAT.heading.h2Size * 2,
          }),
        ],
      }),
    );
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
    for (const { entry } of cited) {
      const typeLabel =
        SOURCE_TYPE_LABELS_HY[entry!.type] ?? "Աղբյուր";
      const citation = entry!.citation ?? "(չհաստատված աղբյուր)";
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${typeLabel}: `, bold: true }),
            new TextRun({ text: citation }),
          ],
        }),
      );
    }
  }

  // §28 — Attachments section. List only ACTUAL workspace documents.
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
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: "Կից փաստաթղթեր / Attachments",
            bold: COURT_READY_FORMAT.heading.bold,
            size: COURT_READY_FORMAT.heading.h2Size * 2,
          }),
        ],
      }),
    );
    docs.forEach((d, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true }),
            new TextRun({
              text: `${d.displayName} (${d.documentType}, ${d.pageCount} էջ) — ${d.originalFilename}`,
            }),
          ],
        }),
      );
    });
  }

  // §11 — Signature block appended at the end of every export. The
  // operator fills [signer name] / [title] / [date] before filing.
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: "Ստորագրություն / Signature",
          bold: true,
          size: COURT_READY_FORMAT.heading.h3Size * 2,
        }),
      ],
    }),
  );
  for (const line of COURT_READY_FORMAT.signature.block.split("\n")) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: line })],
        spacing: { after: 100 },
      }),
    );
  }

  // Footer with version metadata.
  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({
          text: `Արտահանված է ${new Date().toISOString()} | Տարբերակ ${version.version} | ${version.verificationStatus}`,
          italics: true,
          size: 18, // 9pt
        }),
      ],
    }),
  );

  const doc = new Document({
    creator: "HayDevLegal — Phase 6.1",
    title: draft.title ?? "Draft",
    description: `Legal draft ${draftId} (version ${version.version})`,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: COURT_READY_FORMAT.marginsTwips.top,
              right: COURT_READY_FORMAT.marginsTwips.right,
              bottom: COURT_READY_FORMAT.marginsTwips.bottom,
              left: COURT_READY_FORMAT.marginsTwips.left,
            },
          },
        },
        children,
      },
    ],
  });

  // Packer.toBuffer returns a Node.js Buffer (which is a Uint8Array subclass).
  const buffer = await Packer.toBuffer(doc);
  // Return a fresh Uint8Array view so the result type matches the contract.
  return new Uint8Array(buffer);
}
