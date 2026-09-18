// src/app/api/cases/[id]/contradictions/route.ts
// Phase 5 §12, §17 — Contradictions.

import { NextRequest, NextResponse } from "next/server";
import { detectContradictions } from "@/lib/case-workspace/evidence/contradictions";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const contradictions = await db.caseContradiction.findMany({ where: { caseId: id } });
    return NextResponse.json({ contradictions });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list contradictions", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const contradictions = await detectContradictions(id);
    return NextResponse.json({ contradictions }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to detect contradictions", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
