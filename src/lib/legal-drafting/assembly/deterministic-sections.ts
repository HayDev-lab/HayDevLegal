// src/lib/legal-drafting/assembly/deterministic-sections.ts
// Phase 6 §13 — Deterministic / mechanical section assembler.
//
// §13 — The following are produced MECHANICALLY (no AI):
//   - case number
//   - parties
//   - court
//   - title
//   - dates
//   - attachment list
//   - verified chronology table
//   - reference list
//
// Per §11: parties / court / case number come from the DraftingContext —
// captured from CaseWorkspace, NEVER invented. When missing, the assembled
// text contains `[MISSING_INFORMATION]`.

import { randomUUID } from "node:crypto";
import type {
  DocumentPlan,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
  SectionType,
} from "../types";

// ---------------------------------------------------------------------------
// Draft id namespace
// ---------------------------------------------------------------------------

let _versionIdCounter = 0;

/** Helper: synthesize stable ids for assembled sections (caller can override). */
function makeSectionId(draftId: string, sectionType: SectionType): string {
  return `${draftId}-${sectionType}-${randomUUID().slice(0, 8)}`;
}

function defaultVersionId(): string {
  _versionIdCounter += 1;
  return `version-${Date.now()}-${_versionIdCounter}`;
}

// ---------------------------------------------------------------------------
// §13 — Header section (case number, parties, court, title, dates)
// ---------------------------------------------------------------------------

export function assembleHeaderSection(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  versionId?: string,
): DraftSection {
  const vId = versionId ?? defaultVersionId();
  const partiesLine =
    ctx.parties.length > 0
      ? ctx.parties.join(", ")
      : "[MISSING_INFORMATION: parties]";
  const courtLine = ctx.court ?? "[MISSING_INFORMATION: court]";
  const caseNumberLine =
    ctx.caseNumber ?? "[MISSING_INFORMATION: case number]";
  const jurisdictionLine =
    ctx.jurisdiction ?? "[MISSING_INFORMATION: jurisdiction]";
  const proceedingLine =
    ctx.proceedingType ?? "[MISSING_INFORMATION: procedural stage]";
  const caseTitleLine = ctx.caseTitle ?? "[MISSING_INFORMATION: case title]";

  const lines: string[] = [
    caseTitleLine,
    `Դատարան — ${courtLine}`,
    `Գործի համար — ${caseNumberLine}`,
    `Մասնակիցներ — ${partiesLine}`,
    `Իրավասություն — ${jurisdictionLine}`,
    `Վարույթի փուլ — ${proceedingLine}`,
  ];

  const content: DraftSectionContent = {
    text: lines.join("\n"),
    sourceIds: [],
  };

  const warnings = plan.sections.find((s) => s.sectionType === "header")
    ?.warnings ?? [];

  return {
    id: makeSectionId(draftId, "header"),
    draftId,
    versionId: vId,
    sectionType: "header",
    title: "Վերնագիր",
    content,
    reviewStatus: "VERIFIED", // §13 — mechanical sections are pre-verified.
    stale: false,
    warnings,
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — Attachments list (mechanical)
// ---------------------------------------------------------------------------

export function assembleAttachmentsSection(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  versionId?: string,
): DraftSection {
  const vId = versionId ?? defaultVersionId();
  const refs = ctx.evidenceRefs;
  if (refs.length === 0) {
    const content: DraftSectionContent = {
      text: "Կից փաստաթղթեր չկան [MISSING_INFORMATION: attachments]",
      sourceIds: [],
    };
    return {
      id: makeSectionId(draftId, "attachments"),
      draftId,
      versionId: vId,
      sectionType: "attachments",
      title: "Կից փաստաթղթեր",
      content,
      reviewStatus: "VERIFIED",
      stale: false,
      warnings: plan.sections.find((s) => s.sectionType === "attachments")
        ?.warnings ?? [],
      previousContent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const lines: string[] = ["Կից փաստաթղթեր՝"];
  const sourceIds: string[] = [];
  refs.forEach((r, i) => {
    const label = r.displayName ?? r.documentId ?? r.sourceId;
    const page = r.page ? `, էջ ${r.page}` : "";
    lines.push(`${i + 1}. ${label}${page} [${r.sourceId}]`);
    sourceIds.push(r.sourceId);
  });
  const content: DraftSectionContent = {
    text: lines.join("\n"),
    sourceIds,
  };
  return {
    id: makeSectionId(draftId, "attachments"),
    draftId,
    versionId: vId,
    sectionType: "attachments",
    title: "Կից փաստաթղթեր",
    content,
    reviewStatus: "VERIFIED",
    stale: false,
    warnings: plan.sections.find((s) => s.sectionType === "attachments")
      ?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — Verified chronology table (mechanical)
// ---------------------------------------------------------------------------

export function assembleChronologyTableSection(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  versionId?: string,
): DraftSection {
  const vId = versionId ?? defaultVersionId();
  const events = ctx.chronology;
  if (events.length === 0) {
    const content: DraftSectionContent = {
      text: "Հաստատված ժամանակագրություն չկա [MISSING_INFORMATION: chronology]",
      sourceIds: [],
    };
    return {
      id: makeSectionId(draftId, "procedural_history"),
      draftId,
      versionId: vId,
      sectionType: "procedural_history",
      title: "Վարույթի պատմություն",
      content,
      reviewStatus: "VERIFIED",
      stale: false,
      warnings: plan.sections.find((s) => s.sectionType === "procedural_history")
        ?.warnings ?? [],
      previousContent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  const headers = ["Ամսաթիվ", "Իրադարձություն", "Աղբյուր"];
  const rows: string[][] = [];
  const sourceIds: string[] = [];
  for (const e of events) {
    const dateLabel = e.date ?? e.originalDateText ?? "(ամսաթիվը բացակայում է)";
    const refLabel =
      e.evidenceRefs[0]?.displayName ??
      e.evidenceRefs[0]?.documentId ??
      "[աղբյուրը բացակայում է]";
    rows.push([dateLabel, e.title, `${refLabel} [${e.sourceId}]`]);
    sourceIds.push(e.sourceId);
  }
  const content: DraftSectionContent = {
    text: "Վարույթի պատմություն՝ հաստատված փաստաթղթերից հավաքված ժամանակագրություն։",
    sourceIds,
    table: { headers, rows },
  };
  return {
    id: makeSectionId(draftId, "procedural_history"),
    draftId,
    versionId: vId,
    sectionType: "procedural_history",
    title: "Վարույթի պատմություն",
    content,
    reviewStatus: "VERIFIED",
    stale: false,
    warnings: plan.sections.find((s) => s.sectionType === "procedural_history")
      ?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — Reference list (mechanical) — legislation + cassation + concourt + echr
// ---------------------------------------------------------------------------

export function assembleReferenceListSection(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  versionId?: string,
): DraftSection {
  const vId = versionId ?? defaultVersionId();
  const lines: string[] = ["Օգտագործված աղբյուրներ՝"];
  const sourceIds: string[] = [];

  if (ctx.legislation.length > 0) {
    lines.push("Օրենսդրություն՝");
    for (const l of ctx.legislation) {
      lines.push(`- ${l.citation} [${l.sourceId}]`);
      sourceIds.push(l.sourceId);
    }
  }
  if (ctx.cassationCases.length > 0) {
    lines.push("Վճռաբեկության դատարանի նախադեպեր՝");
    for (const c of ctx.cassationCases) {
      lines.push(`- ${c.citation} [${c.sourceId}]`);
      sourceIds.push(c.sourceId);
    }
  }
  if (ctx.conCourtCases.length > 0) {
    lines.push("Սահմանադրության դատարանի նախադեպեր՝");
    for (const c of ctx.conCourtCases) {
      lines.push(`- ${c.citation} [${c.sourceId}]`);
      sourceIds.push(c.sourceId);
    }
  }
  if (ctx.echrCases.length > 0) {
    lines.push("ՄԻԵՎ նախադեպեր՝");
    for (const e of ctx.echrCases) {
      lines.push(`- ${e.citation} [${e.sourceId}]`);
      sourceIds.push(e.sourceId);
    }
  }
  if (sourceIds.length === 0) {
    lines.push("[MISSING_INFORMATION: no legal authorities in context]");
  }

  const content: DraftSectionContent = {
    text: lines.join("\n"),
    sourceIds,
  };
  // Reuse the "applicable_law" section type for the reference list (§13 —
  // "reference list" is the mechanical counterpart of the AI-driven
  // applicable_law section).
  return {
    id: makeSectionId(draftId, "applicable_law"),
    draftId,
    versionId: vId,
    sectionType: "applicable_law",
    title: "Կիրառելի իրավունք (մեխանիկական ցուցակ)",
    content,
    reviewStatus: "VERIFIED",
    stale: false,
    warnings: plan.sections.find((s) => s.sectionType === "applicable_law")
      ?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — assembleDeterministicSections: returns ALL mechanical sections for
// the plan (header, procedural_history, attachments, reference list). The
// AI drafter is NOT called for any of these.
// ---------------------------------------------------------------------------

export async function assembleDeterministicSections(
  draftId: string,
  plan: DocumentPlan,
  ctx: DraftingContext,
): Promise<DraftSection[]> {
  const out: DraftSection[] = [];
  // §13 — only emit the mechanical sections the plan asks for.
  const wanted = new Set<SectionType>([
    "header",
    "procedural_history",
    "attachments",
    "applicable_law",
  ]);
  for (const s of plan.sections) {
    if (!wanted.has(s.sectionType)) continue;
    if (s.sectionType === "header") {
      out.push(assembleHeaderSection(draftId, ctx, plan));
    } else if (s.sectionType === "procedural_history") {
      out.push(assembleChronologyTableSection(draftId, ctx, plan));
    } else if (s.sectionType === "attachments") {
      out.push(assembleAttachmentsSection(draftId, ctx, plan));
    } else if (s.sectionType === "applicable_law") {
      // §13 — applicable_law gets BOTH a mechanical reference list AND a
      // free-form AI argument section (handled elsewhere). The mechanical
      // one is produced here.
      out.push(assembleReferenceListSection(draftId, ctx, plan));
    }
  }
  return out;
}
