// src/app/api/cases/[id]/drafts/[draftId]/route.ts
// Phase 6 §29 — Get/update/archive a single draft.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const versions = await db.draftVersion.findMany({
      where: { draftId },
      orderBy: { version: "desc" },
    });
    const sections = await db.draftSection.findMany({
      where: { draftId },
      orderBy: { sectionType: "asc" },
    });
    return NextResponse.json({ draft, versions, sections });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to get draft", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const body = (await req.json()) as Partial<{
      title: string;
      status: string;
      language: string;
      targetCourtOrAuthority: string;
      proceduralStage: string;
      goal: string;
      requestedRelief: string;
      parties: string[];
      jurisdiction: string;
      caseNumber: string;
    }>;
    const updated = await db.legalDraft.update({
      where: { id: draftId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
        ...(body.targetCourtOrAuthority !== undefined ? { targetCourtOrAuthority: body.targetCourtOrAuthority } : {}),
        ...(body.proceduralStage !== undefined ? { proceduralStage: body.proceduralStage } : {}),
        ...(body.goal !== undefined ? { goal: body.goal } : {}),
        ...(body.requestedRelief !== undefined ? { requestedRelief: body.requestedRelief } : {}),
        ...(body.parties !== undefined ? { parties: JSON.stringify(body.parties) } : {}),
        ...(body.jurisdiction !== undefined ? { jurisdiction: body.jurisdiction } : {}),
        ...(body.caseNumber !== undefined ? { caseNumber: body.caseNumber } : {}),
      },
    });
    return NextResponse.json({ draft: updated });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to update draft", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // Archive first; hard delete only if already ARCHIVED
    if (draft.status !== "ARCHIVED") {
      const archived = await db.legalDraft.update({
        where: { id: draftId },
        data: { status: "ARCHIVED" },
      });
      return NextResponse.json(
        { draft: archived, message: "draft archived; delete again to permanently remove" },
        { status: 202 },
      );
    }
    await db.legalDraft.delete({ where: { id: draftId } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to delete draft", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
