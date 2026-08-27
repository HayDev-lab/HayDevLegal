// src/lib/arlis/arlis-search.ts
// High-level ARLIS retrieval orchestrator.
//
// Pipeline (per spec §5):
//   raw query
//     -> normalize + parse
//     -> build ARLIS query variants
//     -> for each variant, arlisSearch()
//     -> merge candidates
//     -> rank + dedup
//     -> top 4
//     -> (optional) fetch article text for grounding
//     -> assign S1..S4 ids
//
// This is the authoritative retrieval layer. The LLM never retrieves.

import type { LegalQuery, LegalSource } from "@/lib/legal/types";
import { parseLegalQuery, buildArlisQueries } from "@/lib/legal/query-parser";
import { arlisSearch, arlisActDetail } from "./arlis-client";
import { parseSearchHtml, extractArticle, type RawCandidate } from "./arlis-parser";
import { rankAndDedupe, assignCitationIds } from "./arlis-ranker";

export type RetrievalResult = {
  query: string;
  normalizedQuery: string;
  parsed: LegalQuery;
  results: LegalSource[];
  ok: boolean;
  error?: string;
  durationMs: number;
};

const FALLBACK_QUERIES = [
  // if everything else fails, try a couple of generic legal keywords
];

/**
 * Run the full ARLIS retrieval pipeline for a user query.
 * Always returns up to TOP_N results (4 by default per spec §1, §49).
 */
export async function retrieveLegalSources(
  rawQuery: string,
  opts: { topN?: number; fetchArticleText?: boolean } = {},
): Promise<RetrievalResult> {
  const topN = opts.topN ?? 4;
  const fetchArticleText = opts.fetchArticleText ?? true;
  const start = Date.now();

  const parsed = parseLegalQuery(rawQuery);
  const variants = buildArlisQueries(parsed);

  let allCandidates: RawCandidate[] = [];
  let lastError: string | undefined;
  let anySuccess = false;

  // Try each variant until we get candidates. ARLIS returns no-results for
  // some phrasings (e.g. single body words), so we iterate.
  // We never stop early on the FIRST variant when we have an actTitle+article
  // query, because the bare-act-title variant (which surfaces the primary
  // code) must always run.
  const mustRunAll = !!(parsed.actTitle && parsed.article);
  for (const v of variants) {
    try {
      const resp = await arlisSearch(v);
      anySuccess = true;
      const cands = parseSearchHtml(resp.html ?? "");
      if (cands.length > 0) {
        allCandidates = allCandidates.concat(cands);
        if (!mustRunAll && allCandidates.length >= 8) break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // continue to next variant
    }
  }

  // If we got nothing but at least one variant succeeded (no-results),
  // that's a legitimate empty result, not an error.
  if (allCandidates.length === 0 && !anySuccess) {
    return {
      query: rawQuery,
      normalizedQuery: parsed.normalized,
      parsed,
      results: [],
      ok: false,
      error: lastError ?? "ARLIS-ի որոնումը ժամանակավորապես անհասանելի է։",
      durationMs: Date.now() - start,
    };
  }

  // Rank + dedup
  const ranked = rankAndDedupe(allCandidates, parsed);
  let top = ranked.slice(0, topN).map((r) => r.source);

  // Enrich top results with article body text for grounding.
  if (fetchArticleText && parsed.article) {
    top = await Promise.all(
      top.map(async (s) => {
        if (!s.actId) return s;
        try {
          const html = await arlisActDetail(s.actId);
          const art = extractArticle(html, parsed.article!);
          if (art) {
            s.fullRetrievedText = art.body;
            s.excerpt =
              s.excerpt || art.title
                ? `${s.excerpt}\n${art.title}\n${art.body.slice(0, 600)}`
                : s.excerpt;
          }
        } catch {
          // enrichment is best-effort; keep the source without full text
        }
        return s;
      }),
    );
  } else if (fetchArticleText) {
    // No specific article: still fetch a short body excerpt for grounding,
    // so the AI has real text from the act rather than just metadata.
    top = await Promise.all(
      top.map(async (s) => {
        if (!s.actId || s.fullRetrievedText) return s;
        try {
          const html = await arlisActDetail(s.actId);
          // Grab the first substantial article text from the act as a representative excerpt.
          const re = /Հոդված\s*\d{1,4}\s*[.\u0589:]?[\s\S]{200,4000}?(?=Հոդված\s*\d{1,4})/u;
          const m = html.match(re);
          if (m) {
            const text = m[0]
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (text.length > 80) {
              s.fullRetrievedText = text.slice(0, 2000);
            }
          }
        } catch {
          // best-effort
        }
        return s;
      }),
    );
  }

  // Assign S1..S4 citation IDs
  assignCitationIds(top, topN);

  return {
    query: rawQuery,
    normalizedQuery: parsed.normalized,
    parsed,
    results: top,
    ok: true,
    durationMs: Date.now() - start,
  };
}
