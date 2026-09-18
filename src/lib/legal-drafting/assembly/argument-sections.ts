// src/lib/legal-drafting/assembly/argument-sections.ts
// Phase 6 §8 / §20 — Deterministic argument-map assembler.
//
// §8 — The argument map (DraftingArgumentEntry[]) is the verified skeleton
// the AI drafter MUST consult. Each entry references internal source ids of
// supporting + counter authorities. The deterministic assembler renders
// this map into a structured section so the AI drafter has a clear spine.
//
// §20 — Counterarguments MUST surface serious adverse authority. The
// counterargument section lists every counter-authority id (from the
// argument map's counterAuthorities + the context's counterAuthorities +
// contradicted facts) — never invents new counter-authority.

import { randomUUID } from "node:crypto";
import type {
  DocumentPlan,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
} from "../types";

// ---------------------------------------------------------------------------
// §8 — assembleArgumentSection
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "arguments" section from ctx.argumentMap.
 * Mechanical; no AI call. Each argument entry is rendered with its
 * supporting + counter authority source ids (L1, C2, E5, etc.).
 *
 * If the context has no argument map, the section is flagged NEEDS_SUPPORT —
 * the AI drafter is then expected to build an argument spine from the
 * selected legal issues + authorities directly (per §14, the AI may
 * reorganize what's in the context; it cannot introduce new sources).
 */
export function assembleArgumentSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  draftId = "draft-argument-section",
  versionId = "version-1",
): DraftSection {
  const argPlan = plan.sections.find((s) => s.sectionType === "arguments");
  const paragraphs: string[] = ["Փաստարկություններ՝"];
  const sourceIds: string[] = [];

  if (ctx.argumentMap.length === 0) {
    paragraphs.push(
      "[SUPPORT_REQUIRED: no argument map in the closed context — drafter will construct from issues + authorities]",
    );
    // §8 — surface the selected legal issue + authority source ids so the
    // AI drafter has a clear spine even without a prebuilt argument map.
    for (const issue of ctx.legalIssues) {
      paragraphs.push(
        `- ${issue.issueStatement} — հիմք՝ ${issue.factSourceIds.length > 0 ? issue.factSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}, իրավունք՝ ${issue.legislationSourceIds.length > 0 ? issue.legislationSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}, նախադեպ՝ ${issue.precedentSourceIds.length > 0 ? issue.precedentSourceIds.join(", ") : "[SUPPORT_REQUIRED]"}`,
      );
      sourceIds.push(
        ...issue.factSourceIds,
        ...issue.legislationSourceIds,
        ...issue.precedentSourceIds,
      );
    }
  } else {
    for (const a of ctx.argumentMap) {
      paragraphs.push(`(${a.sourceId}) ${a.proposition}`);
      paragraphs.push(
        `   Աջակցող աղբյուրներ — ${a.supportingAuthorities.length > 0 ? a.supportingAuthorities.join(", ") : "[SUPPORT_REQUIRED]"}`,
      );
      paragraphs.push(
        `   Հակառակ աղբյուրներ — ${a.counterAuthorities.length > 0 ? a.counterAuthorities.join(", ") : "(չկան)"}`,
      );
      if (a.limitations.length > 0) {
        paragraphs.push(`   Սահմանափակումներ — ${a.limitations.join("; ")}`);
      }
      sourceIds.push(
        a.sourceId,
        ...a.supportingAuthorities,
        ...a.counterAuthorities,
      );
    }
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-arguments-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "arguments",
    title: "Փաստարկություններ",
    content,
    reviewStatus: argPlan?.needsSupport ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: argPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// §20 — assembleCounterargumentSection
// ---------------------------------------------------------------------------

/**
 * Build the deterministic "counterarguments" section. Mechanical; no AI call.
 *
 * §20 — Counterarguments must surface serious adverse authority. The list
 * is built from:
 *   - every argument-map entry's counterAuthorities
 *   - the context's top-level counterAuthorities list
 *   - every DISPUTED / CONTRADICTED fact in the context
 *
 * The section NEVER invents new counter-authority. If no counter-authority
 * exists, the section is flagged NEEDS_SUPPORT — never silently approved.
 */
export function assembleCounterargumentSection(
  ctx: DraftingContext,
  plan: DocumentPlan,
  draftId = "draft-counterargument-section",
  versionId = "version-1",
): DraftSection {
  const counterPlan = plan.sections.find(
    (s) => s.sectionType === "counterarguments",
  );
  const paragraphs: string[] = ["Հակափաստարկություններ (§20)՝"];
  const sourceIds: string[] = [];
  const seen = new Set<string>();

  // §20 — argument-map counter-authorities.
  for (const a of ctx.argumentMap) {
    for (const c of a.counterAuthorities) {
      if (seen.has(c)) continue;
      seen.add(c);
      paragraphs.push(
        `- Հակառակ աղբյուր ${c} (ըստ փաստարկության ${a.sourceId})`,
      );
      sourceIds.push(c);
    }
  }

  // §20 — context-level counter-authorities.
  for (const c of ctx.counterAuthorities) {
    if (seen.has(c)) continue;
    seen.add(c);
    paragraphs.push(`- Հակառակ աղբյուր ${c}`);
    sourceIds.push(c);
  }

  // §20 — DISPUTED / CONTRADICTED facts.
  for (const f of ctx.facts) {
    if (f.status !== "DISPUTED" && f.status !== "CONTRADICTED") continue;
    if (seen.has(f.sourceId)) continue;
    seen.add(f.sourceId);
    paragraphs.push(
      `- Վիճարկելի փաստ ${f.sourceId} — ${f.proposition}`,
    );
    sourceIds.push(f.sourceId);
  }

  // §20 — distinguishing factors (precedents distinguished in the context).
  for (const [sid, factors] of Object.entries(ctx.distinguishing)) {
    if (factors.length === 0) continue;
    if (seen.has(sid)) continue;
    seen.add(sid);
    paragraphs.push(
      `- Տարբենակից նախադեպ ${sid} — ${factors.join("; ")}`,
    );
    sourceIds.push(sid);
  }

  if (sourceIds.length === 0) {
    paragraphs.push(
      "[SUPPORT_REQUIRED: no counter-authority / contradicted fact in the closed context]",
    );
  }

  const content: DraftSectionContent = {
    text: paragraphs.join("\n"),
    sourceIds,
    paragraphs,
  };

  return {
    id: `${draftId}-counterarguments-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: "counterarguments",
    title: "Հակափաստարկություններ",
    content,
    reviewStatus: counterPlan?.needsSupport ? "NEEDS_SUPPORT" : "VERIFIED",
    stale: false,
    warnings: counterPlan?.warnings ?? [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
