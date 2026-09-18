// src/app/api/cases/[id]/chronology/route.ts
// Phase 5 §8, §17 — Chronology list + rebuild.

import { NextRequest, NextResponse } from "next/server";
import { buildChronologyForCase } from "@/lib/case-workspace/chronology/builder";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const events = await db.chronologyEvent.findMany({
      where: { caseId: id },
      orderBy: { date: "asc" },
    });
    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list chronology", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// Rebuild chronology from documents (deterministic — extracts dates + dedups).
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const result = await buildChronologyForCase(id);
    return NextResponse.json({ events: result.events, conflicts: result.conflicts }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to build chronology", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
