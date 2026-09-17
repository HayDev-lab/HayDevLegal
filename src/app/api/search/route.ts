// src/app/api/search/route.ts
// LIVE FEDERATED LEGAL SEARCH endpoint (v2).
//
// POST /api/search  { query: string, mode?: "quick" | "deep" }
// -> FederatedSearchResponse:
//    - results  — top evidence mapped to the legacy LegalSource shape
//    - evidence — structured E1..En pack for /api/answer
//    - trace    — which sources were checked, with statuses
//    - warnings — temporal / restricted / partial notices
//
// Retrieval stays authoritative and independent of the LLM (spec §1, §22).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { federatedSearch } from "@/lib/legal-search/engine/search-engine";
import type { FederatedSearchResponse } from "@/lib/legal-search/types";
import type { SearchResponse } from "@/lib/legal/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_QUERY_LEN = 400;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let body: { query?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Սխալ հարցման մարմին։" }, { status: 400 });
  }

  const rawQuery = typeof body.query === "string" ? body.query.trim() : "";
  if (!rawQuery) {
    return NextResponse.json({ error: "Հարցումը դատարկ է։" }, { status: 400 });
  }
  if (rawQuery.length > MAX_QUERY_LEN) {
    return NextResponse.json({ error: "Հարցումը չափազանց երկար է։" }, { status: 400 });
  }

  const mode = body.mode === "deep" ? "deep" : "quick";

  try {
    const result = await federatedSearch(rawQuery, { mode });
    const response: FederatedSearchResponse = {
      ...result,
      retrieval: { ...result.retrieval, durationMs: Date.now() - t0 },
      requestId: randomUUID(),
    };
    // 200 even on empty results — empty is a legitimate UI state.
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/search] fatal:", err);
    return NextResponse.json(
      { error: "Որոնումը ժամանակավորապես անհասանելի է։" },
      { status: 502 },
    );
  }
}

export async function GET() {
  const doc: Partial<SearchResponse> & Record<string, unknown> = {
    service: "armenian-legal-search",
    endpoint: "/api/search",
    method: "POST",
    body: { query: "string", mode: '"quick" | "deep" (default quick)' },
    response: {
      results: "LegalSource[] (top evidence, legacy-compatible)",
      evidence: "LegalEvidence[] (E1..En pack for /api/answer)",
      trace: "sources checked with statuses",
      warnings: "temporal / restricted / partial notices",
    },
  };
  return NextResponse.json(doc);
}
