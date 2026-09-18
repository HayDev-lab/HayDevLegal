// src/lib/legal-search/sources/hudoc/adapter.ts
// HUDOC / ECtHR adapter — v2 (Phase 3 §4-§20).
//
// Pipeline: query -> HUDOC search (native API first, official-domain web
// discovery as fallback) -> HudocDocument metadata -> canonical deep link ->
// document endpoint attempt -> passages -> Evidence Pack.
//
// Error classification (§18): a Cloudflare challenge on the browser UI/API
// is NOT a terminal "HUDOC unavailable" state. The adapter still returns
// every real piece of metadata it can obtain (via web discovery), always
// with canonical deep links, and only marks the FULL TEXT as restricted.
// RESTRICTED is reserved for genuine access restriction.

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  LegalSourceAdapter,
  SourceStatus,
  FetchedDocument,
} from "../../types";
import { AUTHORITY, RESOLUTION } from "../../config";
import {
  searchHudoc,
  fetchHudocDocumentApi,
  hudocCanonicalUrl,
  type HudocDocument,
  type HudocOutcome,
} from "./client";
import {
  HudocQueryBuilder,
  extractApplicationNumber,
  extractConventionArticle,
  normalizeConventionArticle,
  type HudocQuery as HudocQueryInput,
} from "./query-builder";

/** Build a HUDOC deep link for a free-text query (opened by the user). */
export function buildHudocDeepLink(queryText: string, respondent?: string): string {
  const state: Record<string, string[]> = {};
  if (queryText) state.contentsitename = [queryText];
  if (respondent) state.respondent = [respondent];
  if (!queryText && respondent) state.respondent = [respondent];
  const fragment = encodeURIComponent(JSON.stringify(state));
  return `https://hudoc.echr.coe.int/eng#${fragment}`;
}

function documentTypeLabel(doc: HudocDocument): string {
  switch (doc.documentType) {
    case "JUDGMENT":
      return "Դատավճիռ";
    case "GRAND_CHAMBER":
      return "Մեծ պալատի դատավճիռ";
    case "DECISION":
      return "Որոշում";
    case "COMMITTEE":
      return "Կոմիտեի որոշում";
    case "COMMUNICATED_CASE":
      return "Հաղորդված գործ";
    case "LEGAL_SUMMARY":
      return "Իրավական ամփոփում";
    default:
      return "ՄԻԵՎԴ փաստաթուղթ";
  }
}

function docToResult(doc: HudocDocument, viaApi: boolean): LegalSearchResult {
  const appno = doc.applicationNumbers[0];
  const title = `${doc.caseName}${appno ? ` (no. ${appno})` : ""}`.slice(0, 200);
  const articlesText = (doc.articles ?? []).length > 0 ? ` · ${(doc.articles ?? []).join(", ")}` : "";

  // Metadata-grade excerpt: ONLY what was actually observed (§18 — no fabrication).
  const excerpt = [
    `${documentTypeLabel(doc)}${articlesText}`,
    doc.decisionDate ? `Ամսաթիվ՝ ${doc.decisionDate}` : "",
    doc.snippet ? doc.snippet.slice(0, 400) : "",
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 600);

  return {
    sourceId: "hudoc",
    sourceName: "HUDOC — ՄԻԵՎԴ",
    sourceType: "echr",
    authority: AUTHORITY.officialHudoc,
    title,
    url: doc.canonicalUrl,
    court: "Եվրոպական դատարան (ՄԻԵՎԴ)",
    caseNumber: appno,
    date: doc.decisionDate,
    temporalStatus: "unknown",
    excerpt: excerpt || title,
    relevance: 0,
    retrievedAt: new Date().toISOString(),
    externalId: doc.itemId,
    metadataVerified: true,
    fullTextVerified: false,
    resolvedVia: viaApi ? "DIRECT_API" : "WEB_DISCOVERY",
    meta: {
      itemId: doc.itemId,
      documentType: doc.documentType ?? "OTHER",
      importance: doc.importance ?? 0,
      language: doc.language ?? "eng",
      respondent: doc.respondent ?? "",
    },
  };
}

/** Choose the HUDOC query for a user question (exact refs override, §8-§10). */
function buildQueryFor(query: LegalSearchQuery): { raw: HudocQueryInput; builder: HudocQueryBuilder } {
  const raw = query.raw;

  // 1. Exact application number wins (§8).
  const appno =
    extractApplicationNumber(raw) ??
    query.understanding.exactReferences.caseNumbers.find((c) => /^\d{4,5}\/\d{2}$/.test(c));
  if (appno) {
    return { raw: { applicationNumber: appno, respondent: "ARM" }, builder: HudocQueryBuilder.exactApplication(appno) };
  }

  // 2. Convention article (§9-§10) — Armenia respondent as retrieval signal.
  const articleRef =
    normalizeConventionArticle(raw.match(/article\s+\d+(?:\s*§\s*\d+)?/i)?.[0] ?? "") ??
    extractConventionArticle(raw);
  if (articleRef) {
    return {
      raw: { article: articleRef, respondent: "ARM" },
      builder: HudocQueryBuilder.articleForRespondent(articleRef, "ARM"),
    };
  }

  // 3. Semantic keyword from the strongest English multilingual variant (§11).
  const en =
    query.understanding.multilingual?.find((v) => v.lang === "en")?.text ??
    query.understanding.concepts.map((c) => c.en).find(Boolean) ??
    query.raw;
  const keyword = en.split(/\s+/).slice(0, 8).join(" ");
  return {
    raw: { keyword, respondent: "ARM" },
    builder: HudocQueryBuilder.keywordForRespondent(keyword, "ARM"),
  };
}

function outcomeFor(outcome: HudocOutcome, results: LegalSearchResult[], start: number, deepLink: string): {
  outcome: SourceSearchOutcome;
  results: LegalSearchResult[];
} {
  switch (outcome.kind) {
    case "ok": {
      const viaApi = outcome.via === "api";
      return {
        outcome: {
          status: "SUCCESS",
          detail: viaApi
            ? `${outcome.documents.length} գործ (HUDOC API)`
            : `${outcome.documents.length} գործ (մետատվյալներ՝ պաշտոնական դոմենի որոնում)`,
          durationMs: Date.now() - start,
          resultCount: results.length,
        },
        results,
      };
    }
    case "empty":
      return {
        outcome: { status: "EMPTY", detail: "համապատասխան գործ չի գտնվել", durationMs: Date.now() - start, resultCount: 0 },
        results: [],
      };
    case "cloudflare_challenge":
      return {
        outcome: {
          status: "RESTRICTED",
          detail:
            "HUDOC-ի API-ն ավտոմատ մուտքից պաշտպանված է (Cloudflare)։ Կարող եք բացել որոնումը HUDOC-ում ձեր բրաուզերով։",
          fallbackUrl: deepLink,
          durationMs: Date.now() - start,
          resultCount: 0,
          accessState: "RESTRICTED",
        },
        results: [],
      };
    case "access_restricted":
      return {
        outcome: {
          status: "RESTRICTED",
          detail: "HUDOC-ը սահմանափակել է մուտքը։",
          fallbackUrl: deepLink,
          durationMs: Date.now() - start,
          resultCount: 0,
          accessState: "RESTRICTED",
        },
        results: [],
      };
    case "timeout":
      return {
        outcome: { status: "TIMEOUT", detail: "HUDOC-ը չպատասխանեց ժամանակին", durationMs: Date.now() - start, resultCount: 0 },
        results: [],
      };
    default:
      return {
        outcome: {
          status: "ERROR",
          detail: `HUDOC սխալ՝ ${outcome.detail ?? "անհայտ"}`.slice(0, 160),
          fallbackUrl: deepLink,
          durationMs: Date.now() - start,
          resultCount: 0,
        },
        results: [],
      };
  }
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();
  const { raw: hudocQuery } = buildQueryFor(query);
  const deepLink = buildHudocDeepLink(
    query.understanding.multilingual?.find((v) => v.lang === "en")?.text ?? query.raw,
    "ARM",
  );

  const timeoutMs = Math.max(
    2_000,
    Math.min(RESOLUTION.hudocTimeoutMs * 2, context.deadline - Date.now()),
  );

  const outcome = await searchHudoc(hudocQuery, { timeoutMs, maxResults: 10 });

  const results =
    outcome.kind === "ok" ? outcome.documents.map((d) => docToResult(d, outcome.via === "api")) : [];

  return outcomeFor(outcome, results, start, deepLink);
}

async function fetchDocument(
  result: LegalSearchResult,
  context: SearchContext,
): Promise<{ status: SourceStatus; document?: FetchedDocument }> {
  const itemId = result.externalId ?? result.meta?.itemId;
  if (!itemId || !/^00\d-\d+$/.test(String(itemId))) return { status: "ERROR" };

  const res = await fetchHudocDocumentApi(String(itemId), {
    timeoutMs: Math.max(2_000, Math.min(RESOLUTION.hudocTimeoutMs, context.deadline - Date.now())),
  });
  switch (res.kind) {
    case "ok":
      return {
        status: "SUCCESS",
        document: {
          url: hudocCanonicalUrl(String(itemId)),
          text: res.text,
          kind: "html",
          fetchedAt: new Date().toISOString(),
          bytes: res.bytes,
        },
      };
    case "cloudflare_challenge":
    case "access_restricted":
      // Honest restriction of the FULL TEXT only; metadata stays valid (§23).
      return { status: "RESTRICTED" };
    default:
      return { status: "ERROR" };
  }
}

export const hudocAdapter: LegalSourceAdapter = {
  id: "hudoc",
  name: "HUDOC — ՄԻԵՎԴ գործեր",
  authority: AUTHORITY.officialHudoc,
  sourceType: "echr",
  // Sequential web-discovery variants (§17 ladder) need a wider window
  // than a single API call — the orchestrator race honours this multiplier.
  timeoutMultiplier: 2,
  supports: (query) =>
    query.mode === "deep" ||
    /ՄԻԵՎԴ|Մարդու իրավունքների եվրոպական|Եվրոպական դատարան|ECHR|ECtHR|HUDOC|եվրոպական կոնվենցիա|Article\s+\d+|^\d{4,5}\/\d{2}$/i.test(
      query.raw,
    ),
  search,
  fetchDocument,
};
