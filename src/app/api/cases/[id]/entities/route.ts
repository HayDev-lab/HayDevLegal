// src/app/api/cases/[id]/entities/route.ts
// Phase 5 §9, §17 — Entity registry.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const entities = await db.caseEntity.findMany({ where: { caseId: id } });
    return NextResponse.json({ entities });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list entities", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
