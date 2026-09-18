// src/app/api/cases/[id]/facts/route.ts
// Phase 5 §10, §17 — Fact matrix.

import { NextRequest, NextResponse } from "next/server";
import { buildFactMatrix } from "@/lib/case-workspace/facts/fact-matrix";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const facts = await db.caseFact.findMany({ where: { caseId: id } });
    return NextResponse.json({ facts });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list facts", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const result = await buildFactMatrix(id);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to build fact matrix", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
