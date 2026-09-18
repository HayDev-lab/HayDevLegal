// src/app/api/cases/[id]/evidence/route.ts
// Phase 5 §11, §17 — Evidence matrix.

import { NextRequest, NextResponse } from "next/server";
import { buildEvidenceMatrix } from "@/lib/case-workspace/evidence/evidence-matrix";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const links = await db.caseEvidenceLink.findMany({ where: { caseId: id } });
    return NextResponse.json({ links });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list evidence links", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const matrix = await buildEvidenceMatrix(id);
    return NextResponse.json(matrix, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to build evidence matrix", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
