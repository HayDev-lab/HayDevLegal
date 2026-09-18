// src/app/api/cases/[id]/issues/route.ts
// Phase 5 §13, §17 — Legal issue links.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const issues = await db.legalIssueLink.findMany({ where: { caseId: id } });
    return NextResponse.json({ issues });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list issues", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
