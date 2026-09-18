// src/lib/legal-drafting/assembly/legal-sections.ts
// Phase 6 §13 — Deterministic legal-authority list assembler.
//
// Per §13: the reference list of articles + case citations is produced
// mechanically. The internal source ids (L1, L2, C3, CC1, E5) are used here
// and map to human-readable citations only at export time (via the
// SourceIdMap).
//
// This is the AI-facing "applicable_law" payload that goes into the closed
// drafting prompt. The mechanical reference list (already produced by the
// deterministic assembler) is what the EXPORT renders; here we produce the
// structured legal-authority list that the AI drafter consults while drafting
// the prose applicable_law / precedents sections.

import { randomUUID } from "node:crypto";
import type {
  DocumentPlan,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
} from "../types";

// ---------------------------------------------------------------------------
// §13 — assembleLegalSection: applicable_law
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "applicable_law" section from ctx.legislation.
 * Mirrors §13 — mechanical; no AI call. The text lists each legislation
 * article with its internal source id (L1, L2…). Detailed prose is left to
 * the AI drafter (codex-drafter / fallback-drafter).
 */
export function assembleLegalSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  draftId = "draft-legal-section",
  versionId = "version-1",
): DraftSection {
  const legalPlan = plan.sections.find((s) => s.sectionType === "applicable_law");
  const legislation = ctx.legislation;
  const paragraphs: string[] = ["Կիրառելի օրենսդրություն՝"];
  const sourceIds: string[] = [];

  if (legislation.length === 0) {
    paragraphs.push(
      "[SUPPORT_REQUIRED: no governing legislation in the closed context]",
    );
  } else {
    for (const l of legislation) {
      paragraphs.push(`(${l.sourceId}) ${l.citation}`);
      if (l.date) paragraphs.push(`   Ամսաթիվ — ${l.date}`);
      if (l.applicability)
        paragraphs.push(`   Կիրառելիություն — ${l.applicability}`);
      if (l.passages.length > 0) {
        for (const p of l.passages) {
          paragraphs.push(`   Մեջբերում — «${p}»`);
        }
      }
      sourceIds.push(l.sourceId);
    }
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-applicable_law-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "applicable_law",
    title: "Կիրառելի իրավունք",
    content,
    reviewStatus: legalPlan?.needsSupport ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: legalPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — assemblePrecedentSection: precedents (Cassation / ConCourt / ECHR)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "precedents" section from ctx.cassationCases,
 * ctx.conCourtCases, ctx.echrCases. Mechanical; no AI call. Each precedent
 * is listed with its internal source id (C1, CC1, E1…). Detailed prose is
 * left to the AI drafter.
 *
 * §20 — distinguishing factors are surfaced inline so the AI drafter can
 * address them.
 */
export function assemblePrecedentSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  draftId = "draft-precedent-section",
  versionId = "version-1",
): DraftSection {
  const precedentPlan = plan.sections.find(
    (s) => s.sectionType === "precedents",
  );
  const paragraphs: string[] = ["Նախադեպեր՝"];
  const sourceIds: string[] = [];

  if (
    ctx.cassationCases.length === 0 &&
    ctx.conCourtCases.length === 0 &&
    ctx.echrCases.length === 0
  ) {
    paragraphs.push(
      "[SUPPORT_REQUIRED: no Cassation / ConCourt / ECHR precedents in the closed context]",
    );
  } else {
    if (ctx.cassationCases.length > 0) {
      paragraphs.push("Վճռաբեկության դատարան՝");
      for (const c of ctx.cassationCases) {
        paragraphs.push(`(${c.sourceId}) ${c.citation}`);
        if (c.date) paragraphs.push(`   Ամսաթիվ — ${c.date}`);
        if (c.applicability)
          paragraphs.push(`   Կիրառելիություն — ${c.applicability}`);
        if (c.distinguishingFactors && c.distinguishingFactors.length > 0) {
          paragraphs.push(
            `   §20 Տարբենակից հանգամածքներ — ${c.distinguishingFactors.join("; ")}`,
          );
        }
        for (const p of c.passages) {
          paragraphs.push(`   Մեջբերում — «${p}»`);
        }
        sourceIds.push(c.sourceId);
      }
    }
    if (ctx.conCourtCases.length > 0) {
      paragraphs.push("Սահմանադրական դատարան՝");
      for (const c of ctx.conCourtCases) {
        paragraphs.push(`(${c.sourceId}) ${c.citation}`);
        if (c.date) paragraphs.push(`   Ամսաթիվ — ${c.date}`);
        if (c.applicability)
          paragraphs.push(`   Կիրառելիություն — ${c.applicability}`);
        if (c.distinguishingFactors && c.distinguishingFactors.length > 0) {
          paragraphs.push(
            `   §20 Տարբենակից հանգամածքներ — ${c.distinguishingFactors.join("; ")}`,
          );
        }
        for (const p of c.passages) {
          paragraphs.push(`   Մեջբերում — «${p}»`);
        }
        sourceIds.push(c.sourceId);
      }
    }
    if (ctx.echrCases.length > 0) {
      paragraphs.push("ՄԻԵՎ՝");
      for (const e of ctx.echrCases) {
        paragraphs.push(`(${e.sourceId}) ${e.citation}`);
        if (e.date) paragraphs.push(`   Ամսաթիվ — ${e.date}`);
        if (e.applicability)
          paragraphs.push(`   Կիրառելիություն — ${e.applicability}`);
        if (e.distinguishingFactors && e.distinguishingFactors.length > 0) {
          paragraphs.push(
            `   §20 Տարբենակից հանգամածքներ — ${e.distinguishingFactors.join("; ")}`,
          );
        }
        for (const p of e.passages) {
          paragraphs.push(`   Մեջբերում — «${p}»`);
        }
        sourceIds.push(e.sourceId);
      }
    }
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-precedents-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "precedents",
    title: "Նախադեպեր",
    content,
    reviewStatus: precedentPlan?.needsSupport ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: precedentPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §13 — assembleLegalIssuesSection
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "legal_issues" section. Mechanical; no AI call.
 * Lists each selected legal issue with its internal fact/authority source ids.
 */
export function assembleLegalIssuesSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  draftId = "draft-legal-issues-section",
  versionId = "version-1",
): DraftSection {
  const issuePlan = plan.sections.find(
    (s) => s.sectionType === "legal_issues",
  );
  const paragraphs: string[] = ["Իրավական հարցեր՝"];
  const sourceIds: string[] = [];

  const allowedIssueIds = new Set(issuePlan?.sourceIds ?? []);
  const issues =
    allowedIssueIds.size === 0
      ? ctx.legalIssues
      : ctx.legalIssues.filter(
          (i) => allowedIssueIds.has(i.issueId) || allowedIssueIds.size === 0,
        );

  if (issues.length === 0) {
    paragraphs.push(
      "[MISSING_INFORMATION: no legal issues selected for this draft]",
    );
  } else {
    for (const issue of issues) {
      paragraphs.push(
        `- ${issue.issueStatement} [${issue.issueId}]`,
      );
      paragraphs.push(
        `   Փաստեր — ${issue.factSourceIds.length > 0 ? issue.factSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}`,
      );
      paragraphs.push(
        `   Օրենսդրություն — ${issue.legislationSourceIds.length > 0 ? issue.legislationSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}`,
      );
      paragraphs.push(
        `   Նախադեպեր — ${issue.precedentSourceIds.length > 0 ? issue.precedentSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}`,
      );
      sourceIds.push(
        ...issue.factSourceIds,
        ...issue.legislationSourceIds,
        ...issue.precedentSourceIds,
      );
    }
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-legal_issues-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "legal_issues",
    title: "Իրավական հարցեր",
    content,
    reviewStatus: issuePlan?.needsSupport ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: issuePlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
