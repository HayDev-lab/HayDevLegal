// src/app/api/cases/[id]/drafts/[draftId]/generate/route.ts
// Phase 6 §13-15, §29 — Generate draft sections (deterministic + AI).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";
import { buildDraftingContext } from "@/lib/legal-drafting/planning/drafting-context";
import { buildDocumentPlan } from "@/lib/legal-drafting/planning/document-plan";
import { assembleDeterministicSections } from "@/lib/legal-drafting/assembly/deterministic-sections";
import { draftWithCodex } from "@/lib/legal-drafting/generation/codex-drafter";
import { draftWithFallback } from "@/lib/legal-drafting/generation/fallback-drafter";
import type { DraftSection } from "@/lib/legal-drafting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      mode?: "deterministic" | "codex" | "auto";
      selectedFactIds?: string[];
      selectedIssueIds?: string[];
    };
    const mode = body.mode ?? "auto";

    // §8 — Build bounded DraftingContext
    const { context: ctx2, sourceIdMap } = await buildDraftingContext(id, {
      selectedFactIds: body.selectedFactIds,
      selectedIssueIds: body.selectedIssueIds,
    });
    // §12 — Build plan
    const plan = await buildDocumentPlan(
      draftId,
      ctx2,
      draft.documentType as never,
      draft.goal ?? "general",
    );

    // §13 — Deterministic assembly (mechanical fields, no AI)
    const detSections = await assembleDeterministicSections(draftId, plan, ctx2);

    let allSections: DraftSection[] = detSections;
    let provider = "deterministic";
    let status = "DETERMINISTIC_ONLY";
    let errorDetail: string | undefined;

    if (mode === "codex" || mode === "auto") {
      // §15 — Codex CLI+ChatGPT PRIMARY for legal prose
      const codexResult = await draftWithCodex(draftId, ctx2, plan, "FULL_DOCUMENT_DRAFT" as never);
      if (codexResult.sections.length > 0 && codexResult.status === "SUCCESS") {
        allSections = mergeSections(detSections, codexResult.sections);
        provider = codexResult.provider ?? "codex-cli";
        status = "AI_DRAFTED";
      } else if (codexResult.status === "BLOCKED_EXTERNAL_QUOTA" || codexResult.status === "AUTH_REQUIRED" || codexResult.status === "RATE_LIMITED" || codexResult.status === "UNAVAILABLE") {
        errorDetail = `Codex ${codexResult.status}; deterministic draft used. ${codexResult.errorDetail ?? ""}`;
      } else {
        // Try fallback drafter (Z-AI/Ollama) only if configured
        try {
          const fbResult = await draftWithFallback(draftId, ctx2, plan, "FULL_DOCUMENT_DRAFT" as never);
          if (fbResult.sections.length > 0) {
            allSections = mergeSections(detSections, fbResult.sections);
            provider = fbResult.provider ?? "fallback";
            status = "AI_DRAFTED";
          }
        } catch {
          // Fallback also failed — use deterministic only
        }
      }
    }

    // Create new version + persist sections
    const latestVersion = await db.draftVersion.findFirst({
      where: { draftId },
      orderBy: { version: "desc" },
    });
    const newVersionNum = (latestVersion?.version ?? 0) + 1;

    const version = await db.draftVersion.create({
      data: {
        draftId,
        version: newVersionNum,
        content: JSON.stringify(allSections),
        createdBy: provider === "deterministic" ? "SYSTEM" : "AI",
        verificationStatus: "UNVERIFIED",
        sourceIdMap: JSON.stringify(sourceIdMap ?? {}),
      },
    });

    // Persist individual sections
    for (const section of allSections) {
      await db.draftSection.create({
        data: {
          draftId,
          versionId: version.id,
          sectionType: section.sectionType,
          title: section.title,
          content: JSON.stringify(section.content),
          reviewStatus: section.reviewStatus ?? "UNREVIEWED",
          stale: section.stale ?? false,
          warnings: JSON.stringify(section.warnings ?? []),
          previousContent: null,
        },
      });
    }

    // Update draft status
    const updated = await db.legalDraft.update({
      where: { id: draftId },
      data: {
        status: status === "DETERMINISTIC_ONLY" ? "NEEDS_REVIEW" : "DRAFTING",
        plan: JSON.stringify(plan),
        contextSummary: JSON.stringify({
          factCount: ctx2.facts.length,
          chronologyCount: ctx2.chronology.length,
          legislationCount: ctx2.legislation.length,
          cassationCount: ctx2.cassationCases.length,
          concourtCount: ctx2.conCourtCases.length,
          echrCount: ctx2.echrCases.length,
        }),
      },
    });

    return NextResponse.json({
      draft: updated,
      version,
      sections: allSections,
      provider,
      status,
      errorDetail,
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to generate draft", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// Merge deterministic mechanical sections with AI-generated prose sections.
function mergeSections(det: DraftSection[], ai: DraftSection[]): DraftSection[] {
  const aiTypes = new Set(ai.map((s) => s.sectionType));
  const result: DraftSection[] = [];
  for (const d of det) {
    if (aiTypes.has(d.sectionType)) {
      const aiSection = ai.find((s) => s.sectionType === d.sectionType);
      if (aiSection) {
        result.push(aiSection);
        continue;
      }
    }
    result.push(d);
  }
  for (const a of ai) {
    if (!result.some((r) => r.sectionType === a.sectionType)) {
      result.push(a);
    }
  }
  return result;
}
