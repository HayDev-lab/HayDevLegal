// src/app/api/health/route.ts
// Health / status endpoint for the federated legal search service — v2
// (Phase 3 §61): per-source SEARCH and DOCUMENT health reported separately,
// plus session-store diagnostics (no cookie values — §27).

import { NextResponse } from "next/server";
import { allAdapters } from "@/lib/legal-search/sources/source-registry";
import { healthSnapshot } from "@/lib/legal-search/engine/source-health";
import { sessionDiagnostics } from "@/lib/legal-search/sources/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = healthSnapshot();
  const adapters = allAdapters().map((a) => ({
    id: a.id,
    name: a.name,
    authority: a.authority,
    type: a.sourceType,
    canFetchDocuments: typeof a.fetchDocument === "function",
    searchHealth: health[`${a.id} search`]?.state ?? "UNKNOWN",
    documentHealth: health[`${a.id} document`]?.state ?? "UNKNOWN",
    documentHealthDetail: health[`${a.id} document`]?.detail,
  }));

  return NextResponse.json({
    status: "ok",
    service: "armenian-legal-search",
    architecture: "live-federated-legal-search",
    phase: "3 — full-document resolution",
    ts: new Date().toISOString(),
    components: {
      arlis: "configured",
      ai: "configured",
      datalex: "configured (search public · document captcha-gated with interactive resume)",
      constitutionalCourt: "configured",
      judiciary: "configured (cassation precedents via Datalex + exact case lookup)",
      hudoc: "configured (native API cloudflare-gated · official-domain web discovery active)",
      web: "configured",
      localLaws: "configured",
      documentResolver: "configured (universal 2.0 ladder + identity verification)",
      sessionStore: sessionDiagnostics(),
    },
    sources: adapters,
    interactiveResolve: {
      bootstrap: "GET /api/resolve?doc=<source>:<externalId>",
      captcha: "GET /api/resolve/captcha?token=...",
      resume: "POST /api/resolve { token, captchaText, query }",
    },
  });
}
