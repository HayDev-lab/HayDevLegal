// src/app/api/resolve/route.ts
// Interactive source-confirmation (CAPTCHA) + document resolution resume
// flow (Phase 3 §25, §63-§64).
//
//   GET  /api/resolve?doc=<source>:<externalId>
//        -> { documentId, token, captchaUrl }   (dedicated session bootstrap)
//   POST /api/resolve { token, captchaText, query? }
//        -> { status: "resolved", url, passages[], textPreview }
//           { status: "captcha_required" } | { status: "error" }
//
// The captcha image itself is served by /api/resolve/captcha (own route).
//
// SECURITY (§27, §63, §69):
//   - the HUMAN user solves the challenge; we never bypass it;
//   - source session cookies live ONLY server-side (token-bound);
//   - tokens are random, TTL-bounded, count-bounded, attempt-bounded;
//   - all outbound fetches go through fetchGuarded (SSRF policy);
//   - a normal search NEVER blocks on this flow.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { TIMEOUTS, POLICY } from "@/lib/legal-search/config";
import { bootstrapDatalexSession, datalexShowCase, datalexCaseUrl } from "@/lib/legal-search/sources/datalex/client";
import { getSession } from "@/lib/legal-search/sources/session-store";
import { extractMainText } from "@/lib/legal-search/security/content-sanitizer";
import { understandQuery } from "@/lib/legal-search/engine/query-understanding";
import { extractPassages } from "@/lib/legal-search/engine/passage-extractor";
import {
  createResumeToken,
  getResumeToken,
  dropResumeToken,
  parseDocumentRef,
} from "@/lib/legal-search/engine/resume-store";
import type { LegalSearchResult } from "@/lib/legal-search/types";
import { rateLimit } from "@/lib/legal-search/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Phase 4.1 §13-§14 — UUID v4 format check for the optional replay sessionId.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const doc = req.nextUrl.searchParams.get("doc") ?? "";
  const parsed = parseDocumentRef(doc);
  if (!parsed) {
    return NextResponse.json({ error: "invalid document reference" }, { status: 400 });
  }

  try {
    // Dedicated session so concurrent users never share one challenge (§25).
    const { cookies } = await bootstrapDatalexSession(10_000);
    const appName = parsed.source === "judiciary" ? "AppPrecedentCaseSearch" : "AppCaseSearch";
    const t = createResumeToken({
      source: parsed.source,
      caseExternalId: parsed.externalId,
      appName,
      canonicalUrl: datalexCaseUrl(parsed.externalId, appName),
      cookies,
    });

    return NextResponse.json({
      documentId: doc,
      token: t.token,
      captchaUrl: `/api/resolve/captcha?token=${t.token}`,
    });
  } catch (err) {
    console.error("[/api/resolve] bootstrap failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Աղբյուրի սեսիան հնարավոր չեղավ ստեղծել։ Փորձեք ավելի ուշ։" },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  // Phase 4.1 §11-§12 — rate-limit the resume POST (resolve category,
  // 30/min default). The bootstrap GET is intentionally unthrottled: it
  // only opens a Datalex session and returns a token, no source traffic.
  const rl = await rateLimit("resolve")(req);
  if (!rl.ok) {
    return NextResponse.json(
      { status: "error", error: "Չափազանց շատ հարցում։ Փորձեք ավելի ուշ։", retryAfterMs: rl.retryAfterMs },
      {
        status: rl.status,
        headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  let body: { token?: unknown; captchaText?: unknown; query?: unknown; sessionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const captchaText = typeof body.captchaText === "string" ? body.captchaText.trim().slice(0, 12) : "";
  const query = typeof body.query === "string" ? body.query.slice(0, 400) : "";

  // Phase 4.1 §13-§14 — per-request/per-user session id. Accept a replay id
  // from the client (UUID format) or mint a fresh one. Solved-CAPTCHA
  // sessions are stored under USER_SESSION scope with this key — never on
  // the shared global bucket — so concurrent users never share a challenge.
  const sessionIdRaw = typeof body.sessionId === "string" ? body.sessionId : "";
  const sessionId = SESSION_ID_RE.test(sessionIdRaw) ? sessionIdRaw : randomUUID();

  const t = getResumeToken(token);
  if (!t) {
    return NextResponse.json({ status: "error", error: "Սեսիան սպառվել է։ Փակեք և կրկին բացեք պատուհանը։" }, { status: 410 });
  }

  // Phase 4.1 §13-§14 — when the client replayed a valid sessionId and we
  // already have a solved-CAPTCHA session for it, reuse the cookies + key
  // directly (no captcha prompt needed — "solve once, view many" path).
  const storedSession = sessionIdRaw
    ? getSession("datalex", "USER_SESSION", sessionIdRaw)
    : undefined;
  const replayKey = storedSession?.captchaKey ?? "";
  const cookies = storedSession?.cookies ?? t.cookies;

  if (!replayKey && !/^[A-Za-z0-9]{3,10}$/.test(captchaText)) {
    return NextResponse.json({ status: "captcha_required", error: "Մուտքագրեք պատկերի տեքստը։" });
  }
  if (++t.attempts > 5) {
    dropResumeToken(token);
    return NextResponse.json({ status: "error", error: "Չափազանց շատ փորձ։ Կրկին բացեք պատուհանը։" }, { status: 429 });
  }

  // Prefer the stored captchaKey (replay) over the freshly submitted one.
  const submitCaptcha = replayKey || captchaText;

  try {
    const res = await datalexShowCase({
      caseExternalId: t.caseExternalId,
      appName: t.appName,
      captchaText: submitCaptcha,
      cookies,
      timeoutMs: TIMEOUTS.documentMs,
      // Storage of the solved session happens inside datalexShowCase under
      // USER_SESSION:{sessionId} when this call succeeds. The legacy global
      // bucket is never polluted.
      sessionId,
    });

    if (res.kind === "captcha_required") {
      // Stored key went stale — the source wants a fresh challenge.
      return NextResponse.json({ status: "captcha_required", error: "Տեքստը սխալ է։ Փորձեք կրկին։" });
    }
    if (res.kind !== "full_text") {
      return NextResponse.json({
        status: "error",
        error: res.kind === "not_found" ? "Գործը չի գտնվել։" : "Աղբյուրի սխալ։",
      });
    }

    // Success — the solved session is now stored under
    // USER_SESSION:{sessionId}. Drop the resume token.
    dropResumeToken(token);

    const text = extractMainText(res.html, { maxChars: 120_000 });
    if (!text || text.length < 100) {
      return NextResponse.json({ status: "error", error: "Փաստաթուղթը դատարկ է։" });
    }

    // Extract passages against the original query when provided (§35-§36).
    let passages: string[] = [];
    if (query) {
      const understanding = understandQuery(query);
      const queryTokens = new Set(understanding.parsed.keywords.filter((k) => k.length >= 3));
      const phrases = understanding.concepts.map((c) => c.hy);
      const temp: LegalSearchResult = {
        sourceId: t.source,
        sourceName: t.source === "judiciary" ? "Վճռաբեկ դատարան" : "Datalex",
        sourceType: t.source === "judiciary" ? "cassation" : "case_law",
        authority: t.source === "judiciary" ? 90 : 75,
        title: "Դատական գործ",
        url: t.canonicalUrl,
        temporalStatus: "unknown",
        excerpt: "",
        relevance: 0,
        retrievedAt: new Date().toISOString(),
        metadataVerified: true,
      };
      passages = extractPassages(temp, text, queryTokens, phrases, 3);
    }

    return NextResponse.json({
      status: "resolved",
      url: t.canonicalUrl,
      // Returned so subsequent /api/resolve calls can replay this solved
      // session for other cases without re-prompting for a captcha.
      sessionId,
      fullTextVerified: true,
      passages,
      textPreview: text.slice(0, 1500),
      bytes: text.length,
    });
  } catch (err) {
    console.error("[/api/resolve] resume failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ status: "error", error: "Աղբյուրը չպատասխանեց։" }, { status: 502 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS" } });
}

// Keep POLICY referenced for the captcha proxy module parity check.
void POLICY;
