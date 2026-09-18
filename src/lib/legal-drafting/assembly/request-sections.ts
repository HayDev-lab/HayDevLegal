// src/lib/legal-drafting/assembly/request-sections.ts
// Phase 6 §21 — Deterministic "requested_relief" assembler.
//
// §21 — Relief comes ONLY from:
//   1. The user-selected goal
//   2. The document type (the spec's procedural constraints)
//   3. The verified procedural context (proceeding type, court)
//
// The AI cannot invent extra remedies. This assembler renders a numbered
// prayer-for-relief that cites the goal verbatim and surfaces the document
// type's procedural constraints inline. If the goal is missing, the section
// is flagged [MISSING_INFORMATION] — never fabricated.

import { randomUUID } from "node:crypto";
import { getDocumentTypeSpec } from "../registry/document-types";
import type {
  DocumentPlan,
  DocumentType,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
} from "../types";

// ---------------------------------------------------------------------------
// §21 — assembleRequestSection
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "requested_relief" section.
 * Mechanical; no AI call. The relief is rendered from:
 *   - the plan's `requestedRelief` (which equals the user-provided goal)
 *   - the document type's `proceduralConstraints`
 *   - the captured procedural context (court / proceeding type)
 *
 * §21 — Relief is rendered in Armenian (default draft language). Each
 * numbered item is a single sentence derived from the goal + constraints.
 * The AI drafter is NOT permitted to invent extra remedies here — the
 * deterministic section IS the relief.
 */
export function assembleRequestSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  docType: DocumentType,
  goal: string,
  draftId = "draft-request-section",
  versionId = "version-1",
): DraftSection {
  const requestPlan = plan.sections.find(
    (s) => s.sectionType === "requested_relief",
  );
  const spec = getDocumentTypeSpec(docType);
  const paragraphs: string[] = ["Խնդրագիր (§21)՝"];
  const sourceIds: string[] = [];

  // §21 — relief from goal. If goal missing → flag, never invent.
  if (!goal || goal.trim().length === 0) {
    paragraphs.push(
      "[MISSING_INFORMATION: document goal not provided — relief cannot be drafted]",
    );
  } else {
    paragraphs.push(`1. ${goal}`);
  }

  // §21 — procedural context. Captured, never invented.
  const court = ctx.court ?? "[MISSING_INFORMATION: court]";
  const proceedingType =
    ctx.proceedingType ?? "[MISSING_INFORMATION: procedural stage]";
  paragraphs.push(
    `2. Դիմումը ներկայացվում է ${court} (${proceedingType} վարույթի փուլում):`,
  );

  // §21 — document-type procedural constraints.
  if (spec.proceduralConstraints.length > 0) {
    paragraphs.push("3. Վարույթային սահմանափակումներ՝");
    spec.proceduralConstraints.forEach((c, i) => {
      paragraphs.push(`   3.${i + 1}. ${c}`);
    });
  }

  // §21 — captured case identity (for the prayer-for-relief footer).
  if (ctx.caseNumber) {
    paragraphs.push(
      `4. Գործի համար — ${ctx.caseNumber} (ըստ փաստաթղթերի փաստարկության):`,
    );
    // No source id — caseNumber comes from CaseWorkspace identity (§11).
  } else {
    paragraphs.push(
      "4. Գործի համար — [MISSING_INFORMATION: case number not captured]",
    );
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-requested_relief-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "requested_relief",
    title: "Խնդրագիր",
    content,
    reviewStatus:
      !goal || goal.trim().length === 0 ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: requestPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
