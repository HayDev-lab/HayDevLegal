// src/app/api/resolve/captcha/route.ts
// Captcha image proxy (Phase 3 §25, Phase 4.1 §13-§14).
//
// The user sees the source's challenge image through our server; the
// image is fetched with the TOKEN-BOUND dedicated session so the challenge
// and the later solution belong to the same session. We NEVER solve it.
//
// Security: the URL is a FIXED datalex.am endpoint (no user input in the
// URL), fetched via fetchGuarded (SSRF policy). Tokens are validated and
// bounded in the resume store (§27).
//
// Phase 4.1 §13-§14: when a `?sessionId=` UUID is supplied AND we have a
// stored solved-CAPTCHA session for it (USER_SESSION scope), serve the
// captcha from that stored session's cookies (the "replay" path). When
// no sessionId is supplied, fall back to the token-bound bootstrap cookies
// (legacy first-solve path).

import { NextRequest, NextResponse } from "next/server";
import { getResumeToken } from "@/lib/legal-search/engine/resume-store";
import { datalexCaptchaImageUrl } from "@/lib/legal-search/sources/datalex/client";
import { getSession } from "@/lib/legal-search/sources/session-store";
import { fetchGuarded } from "@/lib/legal-search/security/url-policy";
import { POLICY } from "@/lib/legal-search/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const t = getResumeToken(token);
  if (!t) {
    return NextResponse.json({ error: "session expired" }, { status: 410 });
  }

  // Phase 4.1 §13-§14 — replay path: prefer cookies from a stored
  // solved-CAPTCHA session when a valid sessionId UUID is provided.
  const sessionId = req.nextUrl.searchParams.get("sessionId") ?? "";
  const storedSession =
    sessionId && SESSION_ID_RE.test(sessionId)
      ? getSession("datalex", "USER_SESSION", sessionId)
      : undefined;
  const cookies = storedSession?.cookies ?? t.cookies;

  try {
    // Fixed endpoint — SSRF-safe by construction, still guarded.
    const res = await fetchGuarded(datalexCaptchaImageUrl(), {
      timeoutMs: 8_000,
      headers: {
        "User-Agent": POLICY.userAgent,
        Accept: "image/*",
        Cookie: cookies,
        Referer: "https://datalex.am/?app=AppCaseSearch",
      },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "captcha unavailable" }, { status: 502 });
    }
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "captcha too large" }, { status: 502 });
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "captcha too large" }, { status: 502 });
    }
    return new Response(buf, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "image/gif",
        "cache-control": "no-store, max-age=0",
      },
    });
  } catch {
    return NextResponse.json({ error: "captcha unavailable" }, { status: 502 });
  }
}
