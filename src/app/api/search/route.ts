// src/app/api/search/route.ts
// ARLIS retrieval endpoint.
//
// POST /api/search  { query: string }
// -> SearchResponse (top 4 ranked ARLIS sources, with parsed query)
//
// Per spec §1, §5, §31: retrieval is authoritative and independent of the LLM.
// The LLM is invoked separately by /api/answer using these sources as grounding.

import { NextRequest, NextResponse } from "next/server";
import { retrieveLegalSources } from "@/lib/arlis/arlis-search";
import { randomUUID } from "node:crypto";
import type { SearchResponse } from "@/lib/legal/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_LEN = 400;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { query?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Սխալ հարցման մարմին։" },
      { status: 400 },
    );
  }

  const rawQuery = typeof body.query === "string" ? body.query.trim() : "";
  if (!rawQuery) {
    return NextResponse.json(
      { error: "Հարցումը դատարկ է։" },
      { status: 400 },
    );
  }
  if (rawQuery.length > MAX_QUERY_LEN) {
    return NextResponse.json(
      { error: "Հարցումը չափազանց երկար է։" },
      { status: 400 },
    );
  }

  try {
    const result = await retrieveLegalSources(rawQuery, {
      topN: 4,
      fetchArticleText: true,
    });

    const response: SearchResponse = {
      query: result.query,
      normalizedQuery: result.normalizedQuery,
      parsed: result.parsed,
      results: result.results,
      retrieval: {
        ok: result.ok,
        durationMs: Date.now() - t0,
        error: result.error,
      },
      requestId: randomUUID(),
    };

    // 200 even on empty results — empty is a legitimate state for the UI.
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/search] fatal:", err);
    return NextResponse.json(
      {
        error: "ARLIS-ի որոնումը ժամանակավորապես անհասանելի է։",
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    service: "armenian-legal-search",
    endpoint: "/api/search",
    method: "POST",
    body: { query: "string" },
  });
}
