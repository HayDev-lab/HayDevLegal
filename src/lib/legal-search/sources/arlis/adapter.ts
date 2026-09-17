// src/lib/legal-search/sources/arlis/adapter.ts
// ARLIS adapter — wraps the EXISTING, battle-tested ARLIS pipeline
// (src/lib/arlis/*) behind the federated LegalSourceAdapter contract.
// The existing pipeline is NOT modified; it is reused as-is.
//
// ARLIS provides: constitution, codes, laws, sub-legislative acts,
// incorporations, and normative-act statuses — the authoritative
// Armenian legislation source.

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  FetchedDocument,
  LegalSourceAdapter,
} from "../../types";
import { classifyError } from "../source-adapter";
import { AUTHORITY, STAGES, TIMEOUTS } from "../../config";
import { retrieveLegalSources } from "@/lib/arlis/arlis-search";
import { arlisActDetail } from "@/lib/arlis/arlis-client";
import { extractArticle } from "@/lib/arlis/arlis-parser";
import { extractMainText } from "../../security/content-sanitizer";
import { fetchGuarded, readBodyCapped } from "../../security/url-policy";
import { SOURCE_ORIGINS } from "../../config";

function toSearchResult(s: import("@/lib/legal/types").LegalSource): LegalSearchResult {
  const status = (s.status ?? "").toLowerCase();
  let temporalStatus: LegalSearchResult["temporalStatus"] = "unknown";
  if (status.includes("գործունակ") || status.includes("գործում է")) temporalStatus = "current";
  else if (status.includes("չի գործունակ") || status.includes("ուժը կորցրել")) temporalStatus = "historical";

  return {
    sourceId: "arlis",
    sourceName: "ARLIS",
    sourceType: "legislation",
    authority: AUTHORITY.officialLegislation,
    title: s.title,
    url: s.canonicalUrl,
    actNumber: s.actNumber,
    article: s.article,
    part: s.part,
    point: s.point,
    status: s.status,
    temporalStatus,
    adoptionDate: s.adoptionDate,
    effectiveDate: s.effectiveDate,
    excerpt: s.excerpt,
    fullText: s.fullRetrievedText,
    relevance: s.relevanceScore,
    retrievedAt: s.retrievedAt,
    externalId: s.actId,
    // Phase 3 §46: ARLIS grid rows are verified structured metadata.
    metadataVerified: true,
    fullTextVerified: !!s.fullRetrievedText,
    resolvedVia: "DIRECT_API",
  };
}

async function retrieveWithTimeout(
  raw: string,
  topN: number,
  context: SearchContext,
): Promise<Awaited<ReturnType<typeof retrieveLegalSources>>> {
  return Promise.race([
    retrieveLegalSources(raw, { topN, fetchArticleText: false }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("__timeout__")),
        Math.max(1_000, Math.min(TIMEOUTS.sourceMs, context.deadline - Date.now())),
      ),
    ),
  ]);
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();
  try {
    // Primary retrieval through the existing pipeline (exact references,
    // act titles, abbreviation expansion — all already handled there).
    const primary = await retrieveWithTimeout(
      query.raw,
      STAGES.candidatesPerSource,
      context,
    );

    let results = primary.results.map(toSearchResult);

    // Semantic fallback (spec §8-§9): when the raw natural-language question
    // matched poorly, try the strongest Armenian concept / expansion variants.
    const conceptVariants = query.variants
      .filter((v) => v.lang === "hy" && (v.origin === "concept" || v.origin === "subquestion"))
      .slice(0, 2);
    if (results.length < 4 && conceptVariants.length > 0 && Date.now() < context.deadline - 2_000) {
      try {
        const extra = await retrieveWithTimeout(
          conceptVariants[0].text,
          Math.min(8, STAGES.candidatesPerSource),
          context,
        );
        const existing = new Set(results.map((r) => r.externalId ?? r.url));
        for (const s of extra.results) {
          const mapped = toSearchResult(s);
          const key = mapped.externalId ?? mapped.url;
          if (!existing.has(key)) {
            existing.add(key);
            results.push(mapped);
          }
        }
      } catch {
        // best-effort enrichment
      }
    }

    if (results.length === 0) {
      return {
        outcome: {
          status: "EMPTY",
          detail: primary.ok ? "համապատասխան ակտ չի գտնվել" : "ARLIS-ը ժամանակավորապես անհասանելի է",
          durationMs: Date.now() - start,
          resultCount: 0,
        },
        results: [],
      };
    }

    return {
      outcome: {
        status: "SUCCESS",
        durationMs: Date.now() - start,
        resultCount: results.length,
      },
      results,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "__timeout__";
    const cls = classifyError(isTimeout ? new Error("__abort__") : err);
    return {
      outcome: { ...cls, durationMs: Date.now() - start, resultCount: 0 },
      results: [],
    };
  }
}

async function fetchDocument(
  result: LegalSearchResult,
  context: SearchContext,
): Promise<{ status: import("../../types").SourceStatus; document?: FetchedDocument }> {
  try {
    const actId = result.externalId;
    if (actId && /^\d+$/.test(actId)) {
      // Use the cached, retry-hardened existing client.
      const html = await Promise.race([
        arlisActDetail(actId),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("__timeout__")),
            Math.max(1_000, Math.min(TIMEOUTS.documentMs, context.deadline - Date.now())),
          ),
        ),
      ]);

      // Article-targeted extraction when we know the article.
      if (result.article) {
        const art = extractArticle(html, result.article);
        if (art) {
          const text = `${art.title}\n\n${art.body}`;
          return {
            status: "SUCCESS",
            document: {
              url: result.url,
              text,
              kind: "html",
              fetchedAt: new Date().toISOString(),
              bytes: text.length,
            },
          };
        }
      }
      const text = extractMainText(html);
      if (text) {
        return {
          status: "SUCCESS",
          document: {
            url: result.url,
            text,
            kind: "html",
            fetchedAt: new Date().toISOString(),
            bytes: text.length,
          },
        };
      }
    }

    // Fallback: guarded fetch of the canonical URL.
    const res = await fetchGuarded(result.url, {
      timeoutMs: Math.max(1_000, Math.min(TIMEOUTS.documentMs, context.deadline - Date.now())),
      allowedOrigins: [...SOURCE_ORIGINS.arlis],
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { text: html } = await readBodyCapped(res);
    const text = extractMainText(html);
    if (!text) return { status: "EMPTY" };
    return {
      status: "SUCCESS",
      document: {
        url: result.url,
        text,
        kind: "html",
        fetchedAt: new Date().toISOString(),
        bytes: text.length,
      },
    };
  } catch (err) {
    const cls = classifyError(err);
    return { status: cls.status };
  }
}

export const arlisAdapter: LegalSourceAdapter = {
  id: "arlis",
  name: "ARLIS — օրենսդրություն",
  authority: AUTHORITY.officialLegislation,
  sourceType: "legislation",
  supports: () => true,
  search,
  fetchDocument,
};
