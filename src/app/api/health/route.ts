// src/app/api/health/route.ts
// Lightweight health check used by the footer status pill and ops.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "armenian-legal-search",
    ts: new Date().toISOString(),
    components: {
      arlis: "configured",
      ai: "configured",
    },
  });
}
