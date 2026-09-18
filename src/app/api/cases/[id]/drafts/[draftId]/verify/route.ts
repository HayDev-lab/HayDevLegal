// src/app/api/cases/[id]/drafts/[draftId]/verify/route.ts
// Phase 6 §16-22, §29 — Run all verification firewalls.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";
import { buildDraftingContext } from "@/lib/legal-drafting/planning/drafting-context";
import { buildDocumentPlan } from "@/lib/legal-drafting/planning/document-plan";
import { runAllVerification } from "@/lib/legal-drafting/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const version = await db.draftVersion.findFirst({
      where: { draftId },
      orderBy: { version: "desc" },
    });
    if (!version) {
      return NextResponse.json({ error: "no version found" }, { status: 400 });
    }
    const sections = await db.draftSection.findMany({
      where: { versionId: version.id },
    });

    // Rebuild DraftingContext + plan for verification
    const { context: ctx2, sourceIdMap } = await buildDraftingContext(id, {});
    const plan = await buildDocumentPlan(
      draftId,
      ctx2,
      draft.documentType as never,
      draft.goal ?? "general",
    );

    // Run all verification firewalls (§16-22)
    const result = await runAllVerification(
      draftId,
      sections.map((s) => ({
        ...s,
        content: JSON.parse(s.content || "{}"),
        warnings: JSON.parse(s.warnings || "[]"),
      })) as never,
      ctx2 as never,
      plan as never,
      sourceIdMap,
      draft.goal ?? "general",
      draft.documentType as never,
    );

    // Update draft + version verification status
    const newStatus = result.passed ? "VERIFIED" : "NEEDS_REVIEW";
    await db.legalDraft.update({
      where: { id: draftId },
      data: { status: newStatus },
    });
    await db.draftVersion.update({
      where: { id: version.id },
      data: { verificationStatus: result.passed ? "VERIFIED" : "PARTIAL" },
    });

    return NextResponse.json({ result, draftStatus: newStatus });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to verify", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
