// src/lib/legal-search/sources/hudoc/client.ts
// HUDOC / ECtHR low-level client (Phase 3 §5-§20).
//
// Fallback ladder (§17), tried in order:
//   1. native search API  POST hudoc.echr.coe.int/app/query/results
//   2. document endpoint  GET  hudoc.echr.coe.int/app/conversion/docx/html/body
//   3. official ECHR discovery (ks./www.echr.coe.int)
//   4. official-domain WEB discovery (search engine, site: queries)
//   5. canonical deep link for the user
//   6. metadata-only
// Only after all of the above may the adapter report RESTRICTED — and only
// when the cause is genuinely an access restriction (§18).
//
// Live-verified in this egress: steps 1-3 are behind a Cloudflare JS
// challenge (HTTP 403, "Just a moment..."). That is classified as
// CLOUDFLARE_CHALLENGE — NOT as "document not found" and NOT silently as
// RESTRICTED. Step 4 WORKS and yields real HUDOC metadata (case name,
// application number, articles, holdings summary) with canonical links.
// The native API code path stays implemented and live-tested: in an egress
// without the Cloudflare block it starts working unchanged (§19 contract
// tests verify graceful degradation when the schema/endpoint changes).

import { POLICY, RESOLUTION } from "../../config";
import { fetchGuarded, readBodyCapped } from "../../security/url-policy";
import { extractMainText } from "../../security/content-sanitizer";
import {
  HudocQueryBuilder,
  type HudocQuery,
  type ConventionArticle,
} from "./query-builder";

const HUDOC_BASE = "https://hudoc.echr.coe.int";
const API_RESULTS = `${HUDOC_BASE}/app/query/results`;
const DOC_CONVERSION = `${HUDOC_BASE}/app/conversion/docx/html/body`;

// ---------------------------------------------------------------------------
// Result model (§12-§13)
// ---------------------------------------------------------------------------

export type HudocDocumentType =
  | "JUDGMENT"
  | "DECISION"
  | "COMMITTEE"
  | "GRAND_CHAMBER"
  | "COMMUNICATED_CASE"
  | "LEGAL_SUMMARY"
  | "OTHER";

export interface HudocDocument {
  /** HUDOC item id, e.g. "001-204811". */
  itemId: string;
  caseName: string;
  applicationNumbers: string[];
  respondent?: string;
  decisionDate?: string;
  documentType?: HudocDocumentType;
  importance?: number;
  articles?: string[];
  keywords?: string[];
  ecli?: string;
  language?: string;
  canonicalUrl: string;
  fullText?: string;
  /** Metadata-grade summary (web discovery snippet). */
  snippet?: string;
}

export type HudocOutcome =
  | { kind: "ok"; documents: HudocDocument[]; totalcount?: number; via: "api" | "web_discovery" }
  | { kind: "empty" }
  | { kind: "cloudflare_challenge" }
  | { kind: "access_restricted" }
  | { kind: "invalid_response"; detail: string }
  | { kind: "server_error"; detail: string }
  | { kind: "timeout" }
  | { kind: "error"; detail: string };

// ---------------------------------------------------------------------------
// Native API (steps 1-2). Cloudflare may gate it from this egress — that is
// an honest CLOUDFLARE_CHALLENGE outcome, never a fabricated result.
// ---------------------------------------------------------------------------

type HudocApiResult = {
  itemid?: string;
  columns?: Record<string, unknown>;
  documentcollectionid?: string[];
  externals?: Array<{ _id?: string; value?: string }>;
};

/** Fields we request from the API (a subset of the site's own RESULT_FIELDS). */
const API_SELECT = [
  "itemid",
  "docname",
  "doctype",
  "appno",
  "extractedappno",
  "conclusion",
  "importance",
  "originatingbody",
  "typedescription",
  "kpdateastext",
  "documentcollectionid",
  "documentcollectionid2",
  "languageisocode",
  "respondent",
  "ecli",
  "sclappnos",
].join(",");

/** Map a doctype code (HEJUD / HFJUD / HJUDARM / PR / ...) to our model (§13). */
function mapDoctype(doctype: string, collections: string[]): HudocDocumentType {
  const dt = (doctype ?? "").toUpperCase();
  if (dt === "PR") return "OTHER"; // press release
  if (dt.includes("GRAND")) return "GRAND_CHAMBER";
  if (collections.some((x) => /GRANDCHAMBER/i.test(x))) return "GRAND_CHAMBER";
  if (dt.includes("COM")) return "COMMITTEE";
  if (collections.some((x) => /COMMITTEE/i.test(x))) return "COMMITTEE";
  if (dt.includes("JUD")) return "JUDGMENT";
  if (dt.includes("DEC") || dt.includes("RES")) return "DECISION";
  if (dt.includes("COMM")) return "COMMUNICATED_CASE";
  if (collections.some((x) => /DECISION/i.test(x))) return "DECISION";
  if (collections.some((x) => /COMMUNICATED/i.test(x))) return "COMMUNICATED_CASE";
  return "OTHER";
}

/**
 * Language preference rank (§14): official English (HE*) first, official
 * French (HF*) second, then any translation.
 */
function languageRank(doctype: string): number {
  const dt = (doctype ?? "").toUpperCase();
  if (dt.startsWith("HE")) return 0;
  if (dt.startsWith("HF")) return 1;
  return 2;
}

function mapApiRow(row: HudocApiResult): HudocDocument | null {
  const c = row.columns ?? {};
  const itemId = String(c.itemid ?? row.itemid ?? "").trim();
  if (!/^00\d-\d+$/.test(itemId)) return null;
  const str = (k: string): string | undefined => {
    const v = c[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const appnos = (str("appno") ?? str("extractedappno") ?? "")
    .split(/[;,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const collections = String(c.documentcollectionid2 ?? c.documentcollectionid ?? "")
    .split(/[;,]\s*/)
    .filter(Boolean);

  return {
    itemId,
    caseName: str("docname") ?? `HUDOC ${itemId}`,
    applicationNumbers: appnos,
    respondent: str("respondent"),
    decisionDate: str("kpdateastext"),
    documentType: mapDoctype(str("doctype") ?? "", collections),
    importance: Number(c.importance ?? 0) || undefined,
    keywords: undefined,
    ecli: str("ecli"),
    language: str("languageisocode") ?? (str("doctype") ?? "").slice(0, 2).toUpperCase(),
    canonicalUrl: hudocCanonicalUrl(itemId),
  };
}

/**
 * §14 language dedup: the same case appears as EN / FR / translation rows.
 * Keep the best-language row per primary application number.
 */
function dedupByLanguage(documents: HudocDocument[]): HudocDocument[] {
  const byAppno = new Map<string, HudocDocument>();
  const orphans: HudocDocument[] = [];
  for (const doc of documents) {
    const key = doc.applicationNumbers[0] ?? doc.itemId;
    if (!key) {
      orphans.push(doc);
      continue;
    }
    const existing = byAppno.get(key);
    if (!existing) {
      byAppno.set(key, doc);
      continue;
    }
    // Prefer the better language rank; keep richer metadata.
    if (languageRank(String(doc.language)) < languageRank(String(existing.language))) {
      byAppno.set(key, doc);
    }
  }
  return [...byAppno.values(), ...orphans];
}

/** Canonical HUDOC deep link (§49 — URLs come from the resolver, never the LLM). */
export function hudocCanonicalUrl(itemId: string, language = "eng"): string {
  return `${HUDOC_BASE}/${language}?i=${itemId}`;
}

function classifyHttp(status: number, body: string): HudocOutcome {
  if (status === 403) {
    return /just a moment|cloudflare|challenge/i.test(body)
      ? { kind: "cloudflare_challenge" }
      : { kind: "access_restricted" };
  }
  if (status === 404) return { kind: "empty" };
  if (status === 429) return { kind: "server_error", detail: "rate limited" };
  if (status >= 500) return { kind: "server_error", detail: `HTTP ${status}` };
  return { kind: "invalid_response", detail: `HTTP ${status}` };
}

/**
 * Native HUDOC search (§5) — LIVE-VERIFIED contract:
 *   GET /app/query/results?query=...&select=...&sort=...&start=...&length=...
 * Response: {resultcount, results:[{itemid, columns:{...}}], message}.
 * Parses defensively (§19 — fail gracefully when the schema changes again).
 */
export async function searchHudocApi(
  builder: HudocQueryBuilder,
  opts: { start?: number; length?: number; timeoutMs?: number } = {},
): Promise<HudocOutcome> {
  const filter = builder.toApiFilter();
  const timeoutMs = opts.timeoutMs ?? RESOLUTION.hudocTimeoutMs;
  const url =
    `${API_RESULTS}?query=${encodeURIComponent(filter)}` +
    `&select=${encodeURIComponent(API_SELECT)}` +
    `&sort=${encodeURIComponent("importance Desc")}` +
    `&start=${opts.start ?? 0}&length=${opts.length ?? 10}`;
  try {
    const res = await fetchGuarded(url, {
      method: "GET",
      timeoutMs,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "User-Agent": POLICY.userAgent,
        Referer: `${HUDOC_BASE}/eng`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const { text } = await readBodyCapped(res, 1024 * 1024);
    if (!res.ok) return classifyHttp(res.status, text);

    let parsed: { results?: HudocApiResult[]; resultcount?: number };
    try {
      parsed = JSON.parse(text) as { results?: HudocApiResult[]; resultcount?: number };
    } catch {
      return { kind: "invalid_response", detail: "non-JSON body" };
    }
    if (!Array.isArray(parsed.results)) return { kind: "invalid_response", detail: "no results array" };

    const documents = dedupByLanguage(
      parsed.results.map(mapApiRow).filter((d): d is HudocDocument => d !== null),
    );
    if (documents.length === 0) return { kind: "empty" };
    return { kind: "ok", documents, totalcount: parsed.resultcount, via: "api" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "AbortError") return { kind: "timeout" };
    return { kind: "error", detail: msg.slice(0, 120) };
  }
}

/**
 * Native HUDOC document fetch (§11): /app/conversion/docx/html/body.
 * Returns the sanitized main text of the judgment.
 */
export async function fetchHudocDocumentApi(
  itemId: string,
  opts: { timeoutMs?: number } = {},
): Promise<
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "cloudflare_challenge" }
  | { kind: "access_restricted" }
  | { kind: "empty" }
  | { kind: "server_error"; detail: string }
  | { kind: "timeout" }
> {
  const timeoutMs = opts.timeoutMs ?? RESOLUTION.hudocTimeoutMs;
  try {
    const url = `${DOC_CONVERSION}?library=ECHR&id=${encodeURIComponent(itemId)}`;
    const res = await fetchGuarded(url, {
      timeoutMs,
      headers: {
        Accept: "text/html,*/*",
        "User-Agent": POLICY.userAgent,
        Referer: `${HUDOC_BASE}/eng?i=${itemId}`,
      },
    });
    const { text } = await readBodyCapped(res, RESOLUTION.pdfMaxBytes);
    if (!res.ok) {
      const cls = classifyHttp(res.status, text);
      if (cls.kind === "empty") return { kind: "empty" };
      if (cls.kind === "server_error") return cls;
      if (cls.kind === "cloudflare_challenge") return { kind: "cloudflare_challenge" };
      if (cls.kind === "access_restricted") return { kind: "access_restricted" };
      return { kind: "empty" };
    }
    const main = extractMainText(text, { maxChars: 120_000 });
    if (!main || main.length < 200) return { kind: "empty" };
    return { kind: "ok", text: main, bytes: main.length };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { kind: "timeout" };
    return { kind: "server_error", detail: String(err).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Web discovery (ladder step 4) — official-domain discovery via the
// z-ai web_search. Parses REAL HUDOC result links + snippets into
// metadata-grade HudocDocuments. Never fabricates: every field is extracted
// from the actual search result.
// ---------------------------------------------------------------------------

import { invokeWebSearch, type WebSearchItem } from "../web-search-client";

/** Exported for contract tests (§19): parse one web-search item into a HudocDocument. */
export function parseHudocWebItemForTest(item: {
  url: string;
  name: string;
  snippet: string;
  host_name?: string;
  date?: string;
}): HudocDocument | null {
  return parseHudocWebItem(item as WebSearchItem);
}

function parseHudocWebItem(item: WebSearchItem): HudocDocument | null {
  let itemId = "";
  let language = "eng";
  try {
    const u = new URL(item.url);
    if (!/hudoc\.echr\.coe\.int$/i.test(u.hostname.replace(/^www\./, ""))) return null;
    const i = u.searchParams.get("i") ?? "";
    const pathMatch = u.pathname.match(/^\/(eng|fre|ita|ger|russ?)[^-]?/i);
    if (pathMatch) language = pathMatch[1].toLowerCase() === "fre" ? "fre" : "eng";
    // /eng?i=001-204811 and /eng-press?i=003-... are both valid deep links.
    const m = i.match(/^(00\d-\d+(?:-\d+)?)$/);
    if (m) itemId = m[1];
    else return null;
  } catch {
    return null;
  }

  const title = (item.name ?? "").replace(/\s*[-–—]\s*HUDOC.*$/i, "").trim();
  const snippet = (item.snippet ?? "").trim();

  // Application numbers: "application (no. 11275/07)" / "(no. 11275/07)"
  const appnos = Array.from(snippet.matchAll(/\b(?:no\.?\s*)?(\d{4,5}\/\d{2})\b/g))
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);

  // Articles: "Art 5 § 1 (c) • ..." style HUDOC snippet lines
  const articles = Array.from(snippet.matchAll(/\bArt\s?(\d{1,2})\s?(?:§\s?(\d{1,2}))?/gi))
    .map((m) => (m[2] ? `${m[1]}§${m[2]}` : m[1]))
    .filter((v, i, a) => a.indexOf(v) === i);

  const isPress = /eng-press/i.test(item.url);
  const documentType: HudocDocumentType = isPress
    ? "OTHER"
    : /judgment/i.test(title + snippet)
      ? /grand chamber/i.test(title + snippet)
        ? "GRAND_CHAMBER"
        : "JUDGMENT"
      : /decision/i.test(title + snippet)
        ? "DECISION"
        : "OTHER";

  // Decision date from snippet "2022-05-10" / "10 May 2022"
  const dateMatch = snippet.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? snippet.match(/\b(\d{1,2}\s+\w+\s+\d{4})\b/);

  return {
    itemId,
    caseName: title || `HUDOC ${itemId}`,
    applicationNumbers: appnos,
    respondent: /armenia/i.test(snippet) ? "ARM" : undefined,
    decisionDate: dateMatch?.[1] ?? item.date,
    documentType,
    articles,
    language,
    canonicalUrl: hudocCanonicalUrl(itemId, language),
    snippet: snippet.slice(0, 600),
  };
}

/**
 * Official-domain WEB discovery of HUDOC documents (§17 step 4, §65-§66).
 * Uses targeted queries (exact identifiers first) and parses only real
 * hudoc.echr.coe.int results.
 */
export async function searchHudocViaWebDiscovery(
  builder: HudocQueryBuilder,
  opts: { timeoutMs?: number; maxResults?: number } = {},
): Promise<HudocOutcome> {
  const timeoutMs = opts.timeoutMs ?? RESOLUTION.hudocTimeoutMs;
  const maxResults = opts.maxResults ?? RESOLUTION.webDiscoveryResults;
  const queries = builder.toWebDiscoveryQueries();
  if (queries.length === 0) return { kind: "empty" };

  try {
    // Serialized through the shared rate-limit-aware queue (live-verified:
    // parallel SDK invocations trigger HTTP 429 and silently degrade results).
    // Queries run SEQUENTIALLY with early exit — the search backend is
    // non-deterministic, so variant 2/3 rescues variant 1 misses.
    const byId = new Map<string, HudocDocument>();
    let anyResponse = false;
    let elapsed = 0;

    for (const { query } of queries.slice(0, 3)) {
      const remainingBudget = timeoutMs - elapsed;
      if (remainingBudget < 1_500) break;
      const t0 = Date.now();
      const items = await invokeWebSearch(query, maxResults, remainingBudget);
      elapsed += Date.now() - t0;
      if (process.env.HUDOC_DEBUG === "1") {
        console.error(
          `[hudoc-discovery] q="${query.slice(0, 60)}" -> ${Array.isArray(items) ? items.length : "null"} items in ${Date.now() - t0}ms (budget left ${timeoutMs - elapsed}ms)`,
        );
      }
      if (!Array.isArray(items)) continue;
      anyResponse = true;
      for (const item of items) {
        if (!item?.url) continue;
        const doc = parseHudocWebItem(item);
        if (!doc) continue;
        const existing = byId.get(doc.itemId);
        if (existing) {
          // Merge: keep the richer metadata.
          if (existing.applicationNumbers.length < doc.applicationNumbers.length) {
            existing.applicationNumbers = doc.applicationNumbers;
          }
          if (!existing.articles?.length && doc.articles?.length) existing.articles = doc.articles;
          if (!existing.snippet || existing.snippet.length < (doc.snippet?.length ?? 0)) {
            existing.snippet = doc.snippet;
          }
          if (!existing.decisionDate && doc.decisionDate) existing.decisionDate = doc.decisionDate;
        } else {
          byId.set(doc.itemId, doc);
        }
      }
      if (byId.size >= Math.min(3, maxResults)) break; // early exit on success
    }

    const documents = Array.from(byId.values()).slice(0, maxResults);
    if (documents.length === 0) {
      if (!anyResponse) return { kind: "error", detail: "web discovery unavailable (rate limit or timeout)" };
      return { kind: "empty" };
    }
    return { kind: "ok", documents, via: "web_discovery" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", detail: msg.slice(0, 120) };
  }
}

/**
 * Full HUDOC search with the §17 fallback ladder:
 * native API first, web discovery when the API is unreachable.
 */
export async function searchHudoc(
  query: HudocQuery,
  opts: { timeoutMs?: number; maxResults?: number } = {},
): Promise<HudocOutcome> {
  const builder = new HudocQueryBuilder(query);
  const api = await searchHudocApi(builder, { length: opts.maxResults ?? 10, timeoutMs: opts.timeoutMs });
  if (api.kind === "ok" || api.kind === "empty") return api;
  // API unreachable/challenged -> official-domain web discovery.
  return searchHudocViaWebDiscovery(builder, opts);
}

/** Metadata lookup for one itemId (search API narrowed by itemid). */
export async function getHudocMetadata(
  itemId: string,
  opts: { timeoutMs?: number } = {},
): Promise<HudocOutcome> {
  const api = await searchHudocApi(
    new HudocQueryBuilder({ keyword: itemId }),
    { length: 5, timeoutMs: opts.timeoutMs },
  );
  if (api.kind === "ok") {
    const doc = api.documents.find((d) => d.itemId === itemId);
    if (doc) return { kind: "ok", documents: [doc], via: "api" };
    return { kind: "empty" };
  }
  return api;
}

/** Convention article helper re-export for the adapter. */
export { normalizeConventionArticle, extractConventionArticle, isApplicationNumber, extractApplicationNumber } from "./query-builder";
export type { ConventionArticle, HudocQuery };
