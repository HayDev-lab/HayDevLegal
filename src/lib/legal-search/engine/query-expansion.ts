// src/lib/legal-search/engine/query-expansion.ts
// Semantic query expansion (spec §9-§11).
//
// "Semantic search" here means: understand the legal meaning of the question
// and build several well-formed retrieval queries — NOT a vector database.
//
// Rules:
//  - EXACT REFERENCES OVERRIDE semantic expansion (§10): when the query has
//    an article / case number / act title, those variants come first.
//  - explosion is limited: 3-8 variants (quick), up to 12 (deep).
//  - multilingual variants (EN/RU) are generated for non-Armenian sources
//    (HUDOC deep links, web search) by translating the legal CONCEPT,
//    not by literal machine translation of the whole question.

import type { QueryUnderstanding, ExpandedQuery } from "../types";
import { POLICY } from "../config";
import { buildArlisQueries } from "@/lib/legal/query-parser";

function pushVariant(
  list: ExpandedQuery[],
  seen: Set<string>,
  text: string | undefined,
  origin: ExpandedQuery["origin"],
  lang: ExpandedQuery["lang"],
  weight: number,
): void {
  if (!text) return;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 3) return;
  const key = `${lang}:${t.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ text: t, origin, lang, weight });
}

/**
 * Build Armenian retrieval variants + multilingual variants.
 */
export function expandQuery(u: QueryUnderstanding, mode: "quick" | "deep"): QueryUnderstanding {
  const limit = mode === "deep" ? POLICY.maxDeepExpandedQueries : POLICY.maxExpandedQueries;
  const variants: ExpandedQuery[] = [];
  const seen = new Set<string>();

  const p = u.parsed;

  // ---- 1. Exact references FIRST (spec §10) -------------------------------
  const arlisQueries = buildArlisQueries(p); // existing, well-tuned variants
  arlisQueries.forEach((q, i) => {
    pushVariant(variants, seen, q, i === 0 && p.actTitle ? "act_title" : "article", "hy", i);
  });

  // Exact case number as its own variant (Datalex exact search).
  if (p.caseNumber) {
    pushVariant(variants, seen, p.caseNumber, "article", "hy", -1);
  }

  // ---- 2. Concept-based Armenian variants (§9) -----------------------------
  const concepts = u.concepts;
  if (!u.hasExactReference || mode === "deep") {
    // Primary concept phrase: "պատշաճ ծանուցում դատական նիստ" style combos.
    if (concepts.length > 0) {
      pushVariant(variants, seen, concepts[0].hy, "concept", "hy", 1);
      // Pair the first two concepts when both exist.
      if (concepts.length > 1) {
        pushVariant(
          variants,
          seen,
          `${concepts[0].hy} ${concepts[1].hy}`,
          "concept",
          "hy",
          2,
        );
      }
      // Related phrases of the top concepts.
      for (const c of concepts.slice(0, 2)) {
        for (const phrase of (c.relatedPhrases ?? []).slice(0, 2)) {
          pushVariant(variants, seen, phrase, "concept", "hy", 3);
        }
      }
    }
  }

  // ---- 3. Keyword fallback ---------------------------------------------------
  const keywords = p.keywords.filter((k) => k.length >= 4).slice(0, 6);
  if (keywords.length >= 2) {
    pushVariant(variants, seen, keywords.join(" "), "original", "hy", 4);
  }
  // The original query itself (normalized).
  pushVariant(variants, seen, p.normalized, "original", "hy", 5);

  // ---- 4. Subquestions (deep mode, from LLM decomposition §24) --------------
  if (mode === "deep" && u.subquestions) {
    for (const sq of u.subquestions.slice(0, POLICY.maxSubquestions)) {
      // Subquestions are full sentences — extract the core words for search.
      const core = sq
        .replace(/[?։.]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .slice(0, 5)
        .join(" ");
      pushVariant(variants, seen, core || sq, "subquestion", "hy", 6);
      // Also the full subquestion (sources like ConCourt handle long text).
      pushVariant(variants, seen, sq.slice(0, 90), "subquestion", "hy", 7);
    }
  }

  // ---- 5. Multilingual variants (§11) — concept translation, not literal ----
  const multilingual: ExpandedQuery[] = [];
  const mSeen = new Set<string>();
  if (concepts.length > 0) {
    for (const c of concepts.slice(0, 3)) {
      if (c.en) pushVariant(multilingual, mSeen, c.en, "multilingual", "en", c === concepts[0] ? 1 : 2);
      if (c.ru) pushVariant(multilingual, mSeen, c.ru, "multilingual", "ru", 3);
    }
    // Combined English phrase for HUDOC-style retrieval.
    const ens = concepts.map((c) => c.en).filter(Boolean) as string[];
    if (ens.length >= 2) {
      pushVariant(multilingual, mSeen, ens.slice(0, 3).join(" "), "multilingual", "en", 4);
    }
  }
  // Convention article references pass through to EN.
  const echrArticles = u.exactReferences.articles.filter((a) => a.includes("§") || Number(a) <= 18);
  for (const a of echrArticles.slice(0, 2)) {
    pushVariant(multilingual, mSeen, `Article ${a} Armenia`, "multilingual", "en", 0);
  }

  return {
    ...u,
    variants: variants.slice(0, limit),
    multilingual: multilingual.slice(0, 6),
  };
}
