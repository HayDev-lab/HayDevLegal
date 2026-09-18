// src/lib/legal-search/security/qa-guard.ts
// QA endpoint guard (Phase 4.1 §9–§10).
//
// The routes under /api/test/* (gold-set, resolution-gold-set) are developer
// harnesses: they call the live federated engine against curated queries and
// reveal internal metrics. They MUST NOT be reachable from production.
//
// Behaviour (§9–§10):
//   1. If LEGAL_QA_ENABLED is falsy (the production default), the guard
//      returns 404 — the route is hidden; we do not even acknowledge it
//      exists. This is safer than 401 (no information leak).
//   2. If enabled, the guard requires:
//        Authorization: Bearer <LEGAL_QA_TOKEN>
//      to match the configured server-side secret. A missing/invalid
//      token returns 401. The token is NEVER logged and NEVER sent to
//      the frontend.
//   3. Constant-time token comparison to avoid timing oracles.
//
// Usage:
//   export const GET = withQaGuard(async (req) => { ... });
//   export const POST = withQaGuard(async (req) => { ... });

import { NextRequest, NextResponse } from "next/server";

/**
 * Read the QA config at call time (avoids any ESM-binding issues with the
 * Turbopack hot-reload cycle for newly-added config exports). The values
 * are cheap (two env lookups) and only read inside the wrapped handler.
 */
function readQaConfig(): { enabled: boolean; token: string } {
  const en = process.env.LEGAL_QA_ENABLED;
  const enabled =
    en === undefined
      ? false // production default — routes are hidden
      : en === "1" || en.toLowerCase() === "true" || en.toLowerCase() === "yes";
  const tok = process.env.LEGAL_QA_TOKEN ?? "";
  return { enabled, token: tok };
}

/**
 * Constant-time string comparison (timing-safe). Returns true when the
 * two strings are byte-equal. The length comparison is also masked.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Compare lengths through a mask so the loop count does not leak length.
  const aLen = a.length;
  const bLen = b.length;
  let mismatch = aLen ^ bLen;
  const max = Math.max(aLen, bLen);
  for (let i = 0; i < max; i++) {
    const ac = i < aLen ? a.charCodeAt(i) : 0;
    const bc = i < bLen ? b.charCodeAt(i) : 0;
    mismatch |= ac ^ bc;
  }
  return mismatch === 0;
}

export type QaGuardedHandler = (req: NextRequest, ctx: { params: unknown }) => Promise<Response> | Response;

/**
 * Higher-order guard for QA-only API routes. Wraps a handler so the route:
 *   - returns 404 when QA is disabled (the production default);
 *   - returns 401 when QA is enabled but the bearer token is missing/invalid;
 *   - otherwise forwards to the wrapped handler.
 *
 * The token comparison is constant-time. The token itself is never logged
 * and never appears in any response body.
 */
export function withQaGuard<TCtx = unknown>(
  handler: (req: NextRequest, ctx: TCtx) => Promise<Response> | Response,
): (req: NextRequest, ctx: TCtx) => Promise<Response> {
  return async (req: NextRequest, ctx: TCtx): Promise<Response> => {
    const { enabled, token: expected } = readQaConfig();
    if (!enabled) {
      // Route is hidden in production — return 404 with a generic body so
      // the existence of the route is not leaked.
      return NextResponse.json(
        { error: "not found" },
        { status: 404 },
      );
    }

    // QA is enabled: require a valid bearer token.
    const auth = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const presented = m ? m[1].trim() : "";

    if (!expected || !presented || !timingSafeEqual(presented, expected)) {
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401 },
      );
    }

    return handler(req, ctx);
  };
}
