// src/lib/legal-search/sources/constitutional-court/client.ts
// Low-level client for the Constitutional Court of Armenia (concourt.am).
//
// Transport contract (observed live):
//  1. GET /decisions/advanced-search -> session cookie + Symfony CSRF token
//  2. GET /decisions/advanced-search?advanced_decision_search[decision_text][0][type]=N
//         &advanced_decision_search[decision_text][0][description]=<text>
//         &advanced_decision_search[_token]=<token>
//     -> server-rendered result page with `mainDecision` blocks
//  3. Each block: dates, decision number (ՍԴՈ-N / SDV-N), title,
//     matched text passages, and a canonical PDF link.
//  4. Decision PDFs are publicly downloadable (no captcha).

import { POLICY } from "../../config";
import { fetchGuarded, readBodyCapped } from "../../security/url-policy";

const BASE = "https://concourt.am";
const SEARCH_URL = `${BASE}/decisions/advanced-search`;

export type CcDecision = {
  /** Publication date (Armenian display string). */
  publicationDate?: string;
  /** Decision date (Armenian display string). */
  decisionDate?: string;
  /** Decision number, e.g. "ՍԴՈ-1842" / "SDV-1842". */
  number?: string;
  /** Case title / subject (usually uppercase). */
  title?: string;
  /** Matched text passages from the decision body. */
  passages: string[];
  /** Canonical PDF path on concourt.am. */
  pdfUrl?: string;
};

type Session = { cookie: string; token: string; fetchedAt: number };
let session: Session | null = null;
const SESSION_TTL_MS = 25 * 60 * 1000;

// Fire-and-forget warm-up: the CSRF bootstrap is fetched once at module load
// so the first real search skips it.
void ensureSession(10_000).catch(() => {});

async function ensureSession(timeoutMs: number): Promise<Session> {
  if (session && Date.now() - session.fetchedAt < SESSION_TTL_MS) return session;
  const res = await fetchGuarded(SEARCH_URL, {
    timeoutMs,
    headers: { "User-Agent": POLICY.userAgent, Accept: "text/html" },
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const cookie = (raw.match(/(?:^|;\s*)([A-Za-z0-9_]+=[^;]+)/) ?? [])[1] ?? "";
  const { text: html } = await readBodyCapped(res);
  const token = (html.match(/name="advanced_decision_search\[_token\]" value="([^"]+)"/) ?? [])[1] ?? "";
  if (!token) throw new Error("ConCourt session bootstrap failed (no CSRF token)");
  session = { cookie, token, fetchedAt: Date.now() };
  return session;
}

/**
 * Search Constitutional Court decisions by text.
 * matchType: 1=word-root, 2=all words, 3=any word, 5=exact.
 */
export async function concourtSearch(
  text: string,
  opts: { matchType?: 1 | 2 | 3 | 5; timeoutMs?: number; page?: number } = {},
): Promise<{ decisions: CcDecision[]; page: number }> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const s = await ensureSession(timeoutMs);
  const params = new URLSearchParams();
  params.set("advanced_decision_search[decision_text][0][type]", String(opts.matchType ?? 1));
  params.set("advanced_decision_search[decision_text][0][description]", text);
  params.set("advanced_decision_search[_token]", s.token);
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));

  const res = await fetchGuarded(`${SEARCH_URL}?${params.toString()}`, {
    timeoutMs,
    headers: {
      "User-Agent": POLICY.userAgent,
      Accept: "text/html",
      ...(s.cookie ? { Cookie: s.cookie } : {}),
      Referer: SEARCH_URL,
    },
  });
  if (!res.ok) throw new Error(`ConCourt HTTP ${res.status}`);
  const { text: html } = await readBodyCapped(res, 2 * 1024 * 1024);
  const decisions = parseDecisionBlocks(html);
  return { decisions, page: opts.page ?? 1 };
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&laquo;": "«",
  "&raquo;": "»",
};

function decodeEntities(s: string): string {
  return s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
}

function cleanText(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse server-rendered `mainDecision` blocks into structured decisions. */
export function parseDecisionBlocks(html: string): CcDecision[] {
  if (!html) return [];
  const out: CcDecision[] = [];
  const blocks = html.split(/class="mainDecision"/).slice(1);
  for (const block of blocks) {
    // Take up to the next block boundary conservatively.
    const seg = block.slice(0, 12_000);

    const pdfMatch = seg.match(/href="(\/decision\/[^"]+\.pdf)"/i);
    const pdfUrl = pdfMatch ? `${BASE}${pdfMatch[1]}` : undefined;

    // All textual cells in order.
    const cellRe = />([^<>]{4,300})</g;
    const texts: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(seg)) !== null) {
      const t = cleanText(m[1]);
      if (t && !/^\d+\s*(սեպ|հոկ|նոյ|դեկ|հուն|փետ|մար|ապր|մայ|հուլ|օգ)եմ?բ?ե?ր?ի?/i.test(t)) {
        texts.push(t);
      }
    }

    const dateRe = /^(\d{1,2}\s+[ա-ֆ]+\s+\d{4})թ?\.?$/i;
    const dates = texts.filter((t) => dateRe.test(t));
    const numberMatch = seg.match(/>(ՍԴՈ\s*[-–—]?\s*\d+|SDV\s*[-–—]?\s*\d+|ՍԴՎ\s*[-–—]?\s*\d+)</i);

    // Title: first ALL-CAPS-ish text longer than 12 chars.
    const title =
      texts.find(
        (t) =>
          t.length > 12 &&
          t === t.toUpperCase() &&
          /[Ա-Ֆ]{2,}/.test(t) &&
          !dateRe.test(t),
      ) ?? undefined;

    // Passages: remaining substantial texts (exclude dates/number/title).
    const skip = new Set([title, numberMatch?.[1], ...dates].filter(Boolean) as string[]);
    const passages = texts
      .filter((t) => !skip.has(t) && t.length > 40 && !dateRe.test(t))
      .slice(0, 4);

    out.push({
      publicationDate: dates[0],
      decisionDate: dates[dates.length > 1 ? 1 : 0],
      number: numberMatch ? cleanText(numberMatch[1]) : undefined,
      title,
      passages,
      pdfUrl,
    });
  }
  return out.filter((d) => d.pdfUrl || d.passages.length > 0 || d.number);
}

/** Download a decision PDF and return its bytes (for pdftotext extraction). */
export async function concourtFetchPdf(
  pdfUrl: string,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetchGuarded(pdfUrl, {
    timeoutMs,
    headers: { "User-Agent": POLICY.userAgent, Accept: "application/pdf,*/*" },
  });
  if (!res.ok) throw new Error(`ConCourt PDF HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { bytes: buf, contentType: res.headers.get("content-type") ?? "application/pdf" };
}
