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
//
// Phase 4.1 §11-§12 — application-level per-IP rate limit:
//   - quick mode → "quick_search" category (60/min default)
//   - deep mode  → "deep_search" category (10/min default, stricter because
//     deep mode fans out to ALL sources and runs the LLM understanding).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { federatedSearch } from "@/lib/legal-search/engine/search-engine";
import type { FederatedSearchResponse } from "@/lib/legal-search/types";
import type { SearchResponse } from "@/lib/legal/types";
import { rateLimit } from "@/lib/legal-search/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_QUERY_LEN = 400;

export async function POST(req: NextRequest) {
  // Phase 4.1 §12 — rate-limit BEFORE parsing the body so abusive clients
  // can't even spend body-parsing work once limited.
  const modePreview = req.nextUrl.searchParams.get("mode");
  // We can't tell quick/deep without reading the body; pick the bucket by
  // the querystring hint if present, otherwise default to the laxer quick
  // bucket (the body parse will then choose the right category for the
  // actual request). This avoids two rate-limit decrements per request.
  const anticipatedMode = modePreview === "deep" ? "deep_search" : "quick_search";
  const rl = await rateLimit(anticipatedMode)(req);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Չափազանց շատ հարցում։ Փորձեք ավելի ուշ։", retryAfterMs: rl.retryAfterMs },
      {
        status: rl.status,
        headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

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
