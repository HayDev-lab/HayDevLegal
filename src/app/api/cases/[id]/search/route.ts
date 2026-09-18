// src/app/api/cases/[id]/search/route.ts
// Phase 5 §13, §17 — Case material full-text search (NO RAG, NO vector DB).

import { NextRequest, NextResponse } from "next/server";
import { searchCase } from "@/lib/case-workspace/search/case-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const query = url.searchParams.get("q") ?? "";
    if (query.trim().length === 0) {
      return NextResponse.json({ error: "q parameter required" }, { status: 400 });
    }
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1;
    const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50;
    const hits = await searchCase(id, query, { page, pageSize });
    return NextResponse.json(hits);
  } catch (err) {
    return NextResponse.json(
      { error: "failed to search", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
