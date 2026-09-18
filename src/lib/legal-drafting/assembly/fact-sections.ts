// src/lib/legal-drafting/assembly/fact-sections.ts
// Phase 6 §9 — Deterministic factual narrative assembler.
//
// §9 — The draft language must reflect the fact status. NEVER write
// "established" for an ALLEGED fact. Status → language mapping:
//   DOCUMENT_VERIFIED → "հաստատված է"  (established)
//   USER_CONFIRMED   → "ըստ սահմանված կարգի հաստատված է"  (confirmed per procedure)
//   ALLEGED          → "ըստ մեղադրյալի պնդման"  (according to the defendant's claim)
//   DISPUTED         → "վիճարկելի է"  (disputed)
//   CONTRADICTED     → "հակասական է"  (contradictory)
//   UNKNOWN          → "հաստատման ենթակա չէ"  (cannot be confirmed)
//
// No AI calls. The narrative is built from the context's facts array.
// Internal source ids (F1, F2…, CE1…) are preserved in sourceIds so the
// verifier can confirm the AI (or this assembler) cited only context items.

import { randomUUID } from "node:crypto";
import type {
  DocumentPlan,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
  FactStatus,
} from "../types";

// ---------------------------------------------------------------------------
// §9 — Status → Armenian language phrase (mirrors case-workspace's
// Armenian-output vocabulary).
// ---------------------------------------------------------------------------

const STATUS_PHRASE: Record<FactStatus, string> = {
  DOCUMENT_VERIFIED: "հաստատված է",
  USER_CONFIRMED: "ըստ սահմանված կարգի հաստատված է",
  ALLEGED: "ըստ մեղադրյալի պնդման",
  DISPUTED: "վիճարկելի է",
  CONTRADICTED: "հակասական է",
  UNKNOWN: "հաստատման ենթակա չէ",
};

// Russian + English fallbacks for drafts in those languages.
const STATUS_PHRASE_RU: Record<FactStatus, string> = {
  DOCUMENT_VERIFIED: "установлено",
  USER_CONFIRMED: "подтверждено в установленном порядке",
  ALLEGED: "по утверждению обвиняемого",
  DISPUTED: "оспаривается",
  CONTRADICTED: "противоречиво",
  UNKNOWN: "не подлежит установлению",
};

const STATUS_PHRASE_EN: Record<FactStatus, string> = {
  DOCUMENT_VERIFIED: "is established",
  USER_CONFIRMED: "is confirmed per procedure",
  ALLEGED: "according to the defendant's claim",
  DISPUTED: "is disputed",
  CONTRADICTED: "is contradicted",
  UNKNOWN: "cannot be established",
};

function pickStatusPhrase(
  status: FactStatus,
  language: "hy" | "ru" | "en" = "hy",
): string {
  if (language === "ru") return STATUS_PHRASE_RU[status];
  if (language === "en") return STATUS_PHRASE_EN[status];
  return STATUS_PHRASE[status];
}

// ---------------------------------------------------------------------------
// §13 — assembleFactSection
// ---------------------------------------------------------------------------

/**
 * Build a deterministic factual narrative from verified facts (NO AI).
 * Each fact is rendered as one paragraph with the §9 status phrase prefixed.
 *
 * The plan's `sections` entry for `facts` controls which source ids are
 * emitted — the assembler respects `plan.sections[].sourceIds` for the facts
 * section (it does NOT emit facts the planner didn't select).
 */
export function assembleFactSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  language: "hy" | "ru" | "en" = "hy",
  draftId = "draft-fact-section",
  versionId = "version-1",
): DraftSection {
  const factsPlan = plan.sections.find((s) => s.sectionType === "facts");
  const allowedSourceIds = new Set(factsPlan?.sourceIds ?? []);
  const facts = ctx.facts.filter(
    (f) => allowedSourceIds.size === 0 || allowedSourceIds.has(f.sourceId),
  );

  const paragraphs: string[] = [];
  const sourceIds: string[] = [];

  if (facts.length === 0) {
    paragraphs.push("[MISSING_INFORMATION: no verified facts in context]");
  } else {
    paragraphs.push("Փաստեր՝");
    for (const f of facts) {
      const phrase = pickStatusPhrase(f.status, language);
      paragraphs.push(
        `(${f.sourceId}) ${f.proposition} — ${phrase} [${f.materiality} նշանակալիություն]`,
      );
      sourceIds.push(f.sourceId);
      // §9 — surface contradictions explicitly when the fact is disputed.
      if (f.status === "DISPUTED" || f.status === "CONTRADICTED") {
        paragraphs.push(
          `   ↳ Հակառակ ապացույցներ՝ ${f.contradictingEvidence.length > 0 ? f.contradictingEvidence.length + " փաստաթուղթ" : "չկան"}.`,
        );
      }
    }
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-facts-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "facts",
    title: "Փաստեր",
    content,
    reviewStatus: factsPlan?.missing ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: factsPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
