// src/app/api/resolve/captcha/route.ts
// Captcha image proxy (Phase 3 §25).
//
// The user sees the source's challenge image through our server; the
// image is fetched with the TOKEN-BOUND dedicated session so the challenge
// and the later solution belong to the same session. We NEVER solve it.
//
// Security: the URL is a FIXED datalex.am endpoint (no user input in the
// URL), fetched via fetchGuarded (SSRF policy). Tokens are validated and
// bounded in the resume store (§27).

import { NextRequest, NextResponse } from "next/server";
import { getResumeToken } from "@/lib/legal-search/engine/resume-store";
import { datalexCaptchaImageUrl } from "@/lib/legal-search/sources/datalex/client";
import { fetchGuarded } from "@/lib/legal-search/security/url-policy";
import { POLICY } from "@/lib/legal-search/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 256 * 1024;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const t = getResumeToken(token);
  if (!t) {
    return NextResponse.json({ error: "session expired" }, { status: 410 });
  }

  try {
    // Fixed endpoint — SSRF-safe by construction, still guarded.
    const res = await fetchGuarded(datalexCaptchaImageUrl(), {
      timeoutMs: 8_000,
      headers: {
        "User-Agent": POLICY.userAgent,
        Accept: "image/*",
        Cookie: t.cookies,
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
