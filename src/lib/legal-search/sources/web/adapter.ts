// src/lib/legal-search/sources/web/adapter.ts
// General web adapter — live web search via z-ai-web-dev-sdk's web_search
// function, with guarded document fetch for the top hits.
//
// Authority = GENERAL WEB (lowest): web results supplement the official
// sources; they never outrank them (spec §17).

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  LegalSourceAdapter,
  FetchedDocument,
  SourceStatus,
} from "../../types";
import { classifyError } from "../source-adapter";
import { AUTHORITY, POLICY, TIMEOUTS } from "../../config";
import { fetchGuarded, readBodyCapped } from "../../security/url-policy";
import { extractMainText, truncatePassage } from "../../security/content-sanitizer";

import { invokeWebSearch, type WebSearchItem } from "../web-search-client";

/** Prefer official Armenian legal domains in web results. */
const PREFERRED_HOSTS = [
  "arlis.am",
  "concourt.am",
  "datalex.am",
  "court.am",
  "parliament.am",
  "gov.am",
  "minjust.am",
  "echr.coe.int",
  "armenpress.am",
  "factor.am",
];

function hostBoost(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (PREFERRED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 0.15;
  } catch {
    // ignore
  }
  return 0;
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();

  // Web search is a DEEP-mode supplement (spec §23).
  if (query.mode !== "deep") {
    return {
      outcome: { status: "UNSUPPORTED", detail: "հասանելի է խորը որոնման ռեժիմում", durationMs: 0, resultCount: 0 },
      results: [],
    };
  }

  // Use the best multilingual (EN) variant + Armenian original.
  const en =
    query.understanding.multilingual?.find((v) => v.lang === "en")?.text ??
    query.raw;

  try {
    const timeoutMs = Math.max(2_000, Math.min(TIMEOUTS.sourceMs, context.deadline - Date.now()));

    // Shared rate-limit-aware queue: parallel SDK calls trigger 429.
    const [hyRes, enRes] = await Promise.allSettled([
      invokeWebSearch(query.raw, 6, timeoutMs),
      invokeWebSearch(en, 4, timeoutMs),
    ]);

    const items: WebSearchItem[] = [];
    for (const r of [hyRes, enRes]) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        items.push(...(r.value as WebSearchItem[]));
      }
    }

    if (items.length === 0) {
      const failed = hyRes.status === "rejected" && enRes.status === "rejected";
      const timedOut = [hyRes, enRes].some(
        (r) => r.status === "rejected" && String((r as PromiseRejectedResult).reason).includes("__timeout__"),
      );
      return {
        outcome: {
          status: timedOut ? "TIMEOUT" : failed ? "ERROR" : "EMPTY",
          detail: timedOut ? "վեբ որոնումը ժամանակահատվածից դուրս ելավ" : "արդյունքներ չկան",
          durationMs: Date.now() - start,
          resultCount: 0,
        },
        results: [],
      };
    }

    // Dedup by URL, map to results.
    const seen = new Set<string>();
    const results: LegalSearchResult[] = [];
    for (const item of items) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const boost = hostBoost(item.url);
      results.push({
        sourceId: "web",
        sourceName: "Վեբ",
        sourceType: "web",
        authority: AUTHORITY.generalWeb,
        title: truncatePassage(item.name ?? item.url, 180),
        url: item.url,
        date: item.date || undefined,
        temporalStatus: "unknown",
        excerpt: truncatePassage(item.snippet ?? "", 500),
        relevance: boost,
        retrievedAt: new Date().toISOString(),
        externalId: undefined,
        meta: { host: item.host_name ?? "" },
      });
    }

    return {
      outcome: { status: "SUCCESS", durationMs: Date.now() - start, resultCount: results.length },
      results,
    };
  } catch (err) {
    const cls = classifyError(err);
    return { outcome: { ...cls, durationMs: Date.now() - start, resultCount: 0 }, results: [] };
  }
}

async function fetchDocument(
  result: LegalSearchResult,
  context: SearchContext,
): Promise<{ status: SourceStatus; document?: FetchedDocument }> {
  try {
    const res = await fetchGuarded(result.url, {
      timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.documentMs, context.deadline - Date.now())),
      headers: { "User-Agent": POLICY.userAgent, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) return { status: "ERROR" };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return { status: "UNSUPPORTED" };
    }
    const { text: raw } = await readBodyCapped(res, 1024 * 1024);
    const text = extractMainText(raw, { maxChars: 60_000 });
    if (!text || text.length < 100) return { status: "EMPTY" };
    return {
      status: "SUCCESS",
      document: {
        url: result.url,
        text,
        kind: ct.includes("html") ? "html" : "text",
        fetchedAt: new Date().toISOString(),
        bytes: text.length,
      },
    };
  } catch {
    return { status: "ERROR" };
  }
}

export const webAdapter: LegalSourceAdapter = {
  id: "web",
  name: "Վեբ — ընդհանուր աղբյուրներ",
  authority: AUTHORITY.generalWeb,
  sourceType: "web",
  supports: (query) => query.mode === "deep",
  search,
  fetchDocument,
};
