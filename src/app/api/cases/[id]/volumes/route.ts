// src/app/api/cases/[id]/volumes/route.ts
// Phase 5 §17 — Volume CRUD.

import { NextRequest, NextResponse } from "next/server";
import { createVolume, listVolumes } from "@/lib/case-workspace/volumes/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const volumes = await listVolumes(id);
    return NextResponse.json({ volumes });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list volumes", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { title?: string; number?: number; order?: number };
    if (!body.title || body.title.trim().length === 0) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    const v = await createVolume(id, {
      title: body.title.trim().slice(0, 240),
      number: typeof body.number === "number" ? body.number : undefined,
      order: typeof body.order === "number" ? body.order : undefined,
    });
    return NextResponse.json({ volume: v }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to create volume", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
