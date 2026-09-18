// src/app/api/cases/[id]/drafts/[draftId]/plan/route.ts
// Phase 6 §12, §29 — Build document plan from DraftingContext.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";
import { buildDraftingContext } from "@/lib/legal-drafting/planning/drafting-context";
import { buildDocumentPlan } from "@/lib/legal-drafting/planning/document-plan";

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
      selectedFactIds?: string[];
      selectedIssueIds?: string[];
    };
    // §8 — Build bounded DraftingContext (never whole case)
    const { context: ctx2, sourceIdMap } = await buildDraftingContext(id, {
      selectedFactIds: body.selectedFactIds,
      selectedIssueIds: body.selectedIssueIds,
    });
    // §12 — Build structured DocumentPlan
    const plan = await buildDocumentPlan(
      draftId,
      ctx2,
      draft.documentType as never,
      draft.goal ?? "general",
    );
    // Persist plan on the draft
    const updated = await db.legalDraft.update({
      where: { id: draftId },
      data: {
        plan: JSON.stringify(plan),
        contextSummary: JSON.stringify({
          factCount: ctx2.facts.length,
          chronologyCount: ctx2.chronology.length,
          legislationCount: ctx2.legislation.length,
          cassationCount: ctx2.cassationCases.length,
          concourtCount: ctx2.conCourtCases.length,
          echrCount: ctx2.echrCases.length,
          sourceIdMapSize: Object.keys(sourceIdMap ?? {}).length,
        }),
        status: "PLANNING",
      },
    });
    return NextResponse.json({ draft: updated, plan, contextSummary: updated.contextSummary });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to build plan", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
