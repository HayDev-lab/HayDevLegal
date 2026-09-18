// src/app/api/cases/[id]/drafts/route.ts
// Phase 6 §29 — Drafts CRUD (list + create).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const drafts = await db.legalDraft.findMany({
      where: { caseId: id },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({ drafts });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list drafts", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as {
      documentType?: string;
      title?: string;
      language?: string;
      targetCourtOrAuthority?: string;
      proceduralStage?: string;
      goal?: string;
      requestedRelief?: string;
      parties?: string[];
      jurisdiction?: string;
      caseNumber?: string;
    };
    if (!body.title || body.title.trim().length === 0) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (!body.documentType) {
      return NextResponse.json({ error: "documentType is required" }, { status: 400 });
    }
    const draft = await db.legalDraft.create({
      data: {
        caseId: id,
        documentType: body.documentType,
        title: body.title.trim().slice(0, 240),
        language: body.language ?? "hy",
        targetCourtOrAuthority: body.targetCourtOrAuthority ?? null,
        proceduralStage: body.proceduralStage ?? null,
        goal: body.goal ?? null,
        requestedRelief: body.requestedRelief ?? null,
        parties: JSON.stringify(body.parties ?? []),
        jurisdiction: body.jurisdiction ?? null,
        caseNumber: body.caseNumber ?? null,
      },
    });
    // Create initial version
    const version = await db.draftVersion.create({
      data: {
        draftId: draft.id,
        version: 1,
        content: "[]",
        createdBy: "SYSTEM",
        verificationStatus: "UNVERIFIED",
        sourceIdMap: "{}",
      },
    });
    return NextResponse.json({ draft, version }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to create draft", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
