// src/lib/legal-drafting/export/docx.ts
// Phase 6 — §28 — DOCX export.
//
// Uses the `docx` package (v9.7.1) to produce a production DOCX file:
//   - Headings (h1 for the title, h2 for sections)
//   - Paragraphs (with inline emphasis via TextRun)
//   - Numbered lists (for prayer-for-relief paragraphs)
//   - Tables (for verified chronology)
//   - Page breaks between sections
//   - Armenian Unicode content (TextRun handles UTF-8 internally)
//   - References + Attachments sections at the end
//
// CRITICAL — §10: "normal export renders human-readable legal citations,
//                  NOT debug IDs (F1/C2 etc.)"
// CRITICAL — §28: "attachment list must contain only actual workspace
//                  documents"

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
    return "";
  });
}

/** Convert a body string into docx Paragraph[] (one paragraph per \n\n). */
function bodyToParagraphs(text: string): Paragraph[] {
  if (!text) return [];
  const blocks = text.split(/\n{2,}/);
  return blocks.map(
    (block) =>
      new Paragraph({
        children: [new TextRun({ text: block })],
        spacing: { after: 200 },
      }),
  );
}

/** Build a docx Table from the section's table content. */
function buildTable(table: {
  headers: string[];
  rows: string[][];
}): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: table.headers.map(
      (h) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
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
              children: [new Paragraph({ children: [new TextRun({ text: cell ?? "" })] })],
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
// §28 — exportDocx
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

  // Build the docx children list.
  const children: (Paragraph | Table)[] = [];

  // §11 — Header block.
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: draft.title ?? "Untitled Draft", bold: true })],
    }),
  );
  if (draft.targetCourtOrAuthority) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Լրացրած դատարան / մարմին: ${draft.targetCourtOrAuthority}` })],
      }),
    );
  }
  if (draft.jurisdiction) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Իրավասություն: ${draft.jurisdiction}` })],
      }),
    );
  }
  if (draft.caseNumber) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Գործի համար: ${draft.caseNumber}` })],
      }),
    );
  }
  if (parties.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Կողմեր: ${parties.join(", ")}` })],
      }),
    );
  }
  if (draft.proceduralStage) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Դատավարական փուլ: ${draft.proceduralStage}` })],
      }),
    );
  }
  if (draft.filingDeadline) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Կատարման ժամկետ: ${new Date(draft.filingDeadline).toLocaleDateString("hy-AM")}`,
          }),
        ],
      }),
    );
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: `Փաստաթուղթ: ${draft.documentType}` })],
    }),
  );
  if (draft.goal) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Նպատակ: ${draft.goal}`, italics: true })],
      }),
    );
  }

  // Page break before the body.
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Render each section.
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: row.title, bold: true })],
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
            children: [new TextRun({ text: `${prefix}${renderedP}` })],
            spacing: { after: 100 },
          }),
        );
      });
    }

    if (content.table) {
      children.push(buildTable(content.table));
    }

    // Page break between sections.
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // §10 — References section. List every cited source id with its
  // human-readable citation.
  const citedIds = new Set<string>();
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    for (const sid of content.sourceIds ?? []) citedIds.add(sid);
  }
  if (citedIds.size > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "Աղբյուրներ / References", bold: true })],
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
    for (const { sid, entry } of cited) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${sid} → `, bold: true }),
            new TextRun({ text: entry!.citation ?? "(չհաստատված աղբյուր)" }),
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
        children: [new TextRun({ text: "Կից փաստաթղթեր / Attachments", bold: true })],
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

  // Footer with version metadata.
  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({
          text: `Արտահանված է ${new Date().toISOString()} | Տարբերակ ${version.version} | ${version.verificationStatus}`,
          italics: true,
          size: 18,
        }),
      ],
    }),
  );

  const doc = new Document({
    creator: "HayDevLegal — Phase 6",
    title: draft.title ?? "Draft",
    description: `Legal draft ${draftId} (version ${version.version})`,
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1132, right: 1132, bottom: 1132, left: 1132 },
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
