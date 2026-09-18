// src/lib/legal-drafting/export/txt.ts
// Phase 6 — §28 — Plain-text export.
//
// Produces a clean UTF-8 plain-text rendering of the draft. CRITICAL — §10:
// "normal export renders human-readable legal citations, NOT debug IDs
// (F1/C2 etc.)" — internal source ids are replaced with their
// human-readable citation forms via the SourceIdMap.
//
// §28 — "attachment list must contain only actual workspace documents".

import { db } from "@/lib/db";
import type {
  DraftSection,
  DraftSectionContent,
  SourceIdMap,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// DB row shapes (Prisma returns `any` for SQLite JSON fields — we cast here)
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
// Helpers — parsing + rendering
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

function parseSectionList(raw: string | null | undefined): DraftSection[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is DraftSection => typeof x === "object" && x !== null && "sectionType" in x)
      .map((s) => ({
        ...s,
        content: typeof s.content === "string" ? parseContent(s.content) : s.content,
      })) as DraftSection[];
  } catch {
    return [];
  }
}

/**
 * Internal source id regex. Matches the AI's inline form (F1, L2, C3, CC1,
 * E5, A2, CE4) — with or without surrounding brackets.
 */
const SOURCE_ID_PATTERN = /\[?(F\d+|CE\d+|L\d+|C\d+|CC\d+|E\d+|A\d+)\]?/g;

/**
 * §10 — Replace inline internal source ids with their human-readable
 * citations from the SourceIdMap. Ids without a map entry are stripped
 * (we never leak debug ids to the export).
 */
function replaceInlineSourceIds(
  text: string,
  sourceIdMap: SourceIdMap,
): string {
  return text.replace(SOURCE_ID_PATTERN, (match, sid: string) => {
    const entry = sourceIdMap[sid];
    if (entry?.citation) {
      return `(${entry.citation})`;
    }
    // No map entry — strip the debug id entirely (§10 — never leak debug
    // ids to the export).
    return "";
  });
}

/**
 * Render a section's table as ASCII text (for the txt export).
 */
function renderTable(table: {
  headers: string[];
  rows: string[][];
}): string {
  const { headers, rows } = table;
  if (headers.length === 0 && rows.length === 0) return "";
  // Compute column widths.
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((r) => (r[i] ?? "").length)),
  );
  const line = widths.map((w) => "-".repeat(w + 2)).join("+");
  const fmtRow = (r: string[]) =>
    "| " +
    r.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join(" | ") +
    " |";
  const out: string[] = [];
  out.push(line);
  out.push(fmtRow(headers));
  out.push(line);
  for (const r of rows) out.push(fmtRow(r));
  out.push(line);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// §28 — exportTxt
// ---------------------------------------------------------------------------

/**
 * §28 — Export a draft version as UTF-8 plain text.
 *
 * @param draftId   the LegalDraft id
 * @param versionId the DraftVersion id
 * @returns clean UTF-8 plain-text string
 */
export async function exportTxt(
  draftId: string,
  versionId: string,
): Promise<string> {
  // Load draft + version + sections.
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

  // Load the DraftSection rows for this version, ordered by section type.
  // The order is deterministic — header comes first, attachments last.
  const SECTION_ORDER: string[] = [
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
  const sectionRows = (await db.draftSection.findMany({
    where: { versionId },
  })) as SectionRow[];
  sectionRows.sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a.sectionType);
    const bi = SECTION_ORDER.indexOf(b.sectionType);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });

  const sourceIdMap = parseSourceIdMap(version.sourceIdMap);
  const parties = parseParties(draft.parties);

  const out: string[] = [];

  // §11 — Header block (court, case number, parties, procedural stage,
  // filing deadline, document type, title). Captured, never invented.
  out.push(draft.title ?? "Untitled Draft");
  out.push("");
  if (draft.targetCourtOrAuthority) {
    out.push(`Լրացրած դատարան / մարմին: ${draft.targetCourtOrAuthority}`);
  }
  if (draft.jurisdiction) {
    out.push(`Իրավասություն: ${draft.jurisdiction}`);
  }
  if (draft.caseNumber) {
    out.push(`Գործի համար: ${draft.caseNumber}`);
  }
  if (parties.length > 0) {
    out.push(`Կողմեր: ${parties.join(", ")}`);
  }
  if (draft.proceduralStage) {
    out.push(`Դատավարական փուլ: ${draft.proceduralStage}`);
  }
  if (draft.filingDeadline) {
    out.push(
      `Կատարման ժամկետ: ${new Date(draft.filingDeadline).toLocaleDateString("hy-AM")}`,
    );
  }
  out.push(`Փաստաթուղթ: ${draft.documentType}`);
  if (draft.goal) {
    out.push(`Նպատակ: ${draft.goal}`);
  }
  out.push("");
  out.push("=".repeat(72));
  out.push("");

  // Render each section.
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    out.push(row.title);
    out.push("-".repeat(Math.min(72, row.title.length || 40)));
    const rendered = replaceInlineSourceIds(content.text ?? "", sourceIdMap);
    out.push(rendered);
    if (Array.isArray(content.paragraphs) && content.paragraphs.length > 0) {
      out.push("");
      content.paragraphs.forEach((p, i) => {
        const renderedP = replaceInlineSourceIds(p, sourceIdMap);
        // §21 — prayer-for-relief paragraphs are numbered.
        const prefix = row.sectionType === "requested_relief" ? `${i + 1}. ` : "• ";
        out.push(`${prefix}${renderedP}`);
      });
    }
    if (content.table) {
      out.push("");
      out.push(renderTable(content.table));
    }
    out.push("");
  }

  // §28 — References section. List every cited source id with its
  // human-readable citation. Sorted by type (Facts → Chronology →
  // Legislation → Cassation → ConCourt → ECHR → Argument → Evidence).
  const citedIds = new Set<string>();
  for (const row of sectionRows) {
    const content = parseContent(row.content);
    for (const sid of content.sourceIds ?? []) citedIds.add(sid);
  }
  if (citedIds.size > 0) {
    out.push("=".repeat(72));
    out.push("ՍԱղբյուրներ / References");
    out.push("=".repeat(72));
    out.push("");
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
    cited.forEach(({ sid, entry }) => {
      const citation = entry!.citation ?? "(քանի որ աղբյուրը չի հաստատվել)";
      out.push(`${sid} → ${citation}`);
    });
    out.push("");
  }

  // §28 — Attachments section. List only ACTUAL workspace documents that
  // are cited (or all if none cited). Per §28: "attachment list must
  // contain only actual workspace documents".
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
    // §28 — Fall back to listing all READY documents in the case.
    docs = (await db.caseDocument.findMany({
      where: { caseId: draft.caseId, processingStatus: "READY" },
    })) as CaseDocumentRow[];
  }
  if (docs.length > 0) {
    out.push("=".repeat(72));
    out.push("Կից փաստաթղթեր / Attachments");
    out.push("=".repeat(72));
    out.push("");
    docs.forEach((d, i) => {
      out.push(
        `${i + 1}. ${d.displayName} (${d.documentType}, ${d.pageCount} էջ) — ${d.originalFilename}`,
      );
    });
    out.push("");
  }

  out.push("=".repeat(72));
  out.push(
    `Արտահանված է ${new Date().toISOString()} | Տարբերակ ${version.version} | ${version.verificationStatus}`,
  );
  out.push("=".repeat(72));

  return out.join("\n");
}
