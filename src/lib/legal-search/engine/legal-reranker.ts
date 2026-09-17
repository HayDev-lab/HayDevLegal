// src/lib/legal-search/engine/legal-reranker.ts
// Legal reranking (spec §16-§17).
//
// finalScore = exactReference + lexicalRelevance + semanticConceptRelevance
//            + authority + temporalRelevance + citationQuality
//
// All weights are centralized in config.ts. Ranking is deterministic and
// transparent — the LLM never ranks.

import { tokenize } from "@/lib/legal/normalizer";
import { RANK_WEIGHTS, RANK_SUB } from "../config";
import type { LegalSearchResult, QueryUnderstanding, SearchMode } from "../types";
import { bestPassage } from "./passage-extractor";

function resultDate(r: LegalSearchResult): string | undefined {
  return r.date ?? r.adoptionDate ?? r.effectiveDate;
}

/**
 * Score a single result for a query understanding.
 * Returns the raw weighted score (unbounded) and a 0..1 normalized relevance.
 */
export function scoreResult(
  r: LegalSearchResult,
  u: QueryUnderstanding,
  mode: SearchMode,
): { score: number; relevance: number } {
  const p = u.parsed;
  let score = 0;

  // ---- exactReference (spec §10) -------------------------------------------
  if (p.caseNumber && r.caseNumber) {
    const norm = (s: string) => s.toUpperCase().replace(/\s+/g, "");
    if (norm(p.caseNumber) === norm(r.caseNumber)) score += RANK_WEIGHTS.exactReference;
    else if (norm(r.caseNumber).includes(norm(p.caseNumber))) score += RANK_WEIGHTS.exactReference * 0.6;
  }
  if (p.article) {
    const passage = (bestPassage(r) || "").toLowerCase();
    const title = r.title.toLowerCase();
    const hasArticle =
      passage.includes(`հոդված ${p.article}`) ||
      passage.includes(`հոդված${p.article}`) ||
      title.includes(`հոդված ${p.article}`) ||
      r.article === p.article;
    if (hasArticle) score += RANK_WEIGHTS.exactReference * 0.9;
  }
  if (p.actTitle) {
    const t = r.title.toLowerCase();
    const a = p.actTitle.toLowerCase();
    if (t === a) score += RANK_WEIGHTS.exactReference * 0.8;
    else if (t.includes(a)) score += RANK_WEIGHTS.exactReference * 0.55;
  }

  // ---- lexicalRelevance -------------------------------------------------------
  const queryTokens = new Set(p.keywords.filter((k) => k.length >= 3));
  const titleTokens = new Set(tokenize(r.title));
  let titleOverlap = 0;
  for (const t of queryTokens) if (titleTokens.has(t)) titleOverlap++;
  score += Math.min((titleOverlap / Math.max(2, queryTokens.size)) * RANK_SUB.titleTokenOverlap, RANK_SUB.titleTokenOverlap);

  const body = `${r.title} ${bestPassage(r)}`.toLowerCase();
  let bodyHits = 0;
  for (const t of queryTokens) if (t.length >= 3 && body.includes(t)) bodyHits++;
  score += Math.min((bodyHits / Math.max(2, queryTokens.size)) * RANK_SUB.bodyKeywordMatch, RANK_SUB.bodyKeywordMatch);

  const normQuery = p.normalized.toLowerCase();
  if (normQuery.length > 10 && body.includes(normQuery.slice(0, 60))) {
    score += RANK_SUB.exactPhraseMatch;
  }

  // ---- semanticConceptRelevance (spec §8-§9) -----------------------------------
  const conceptPhrases = u.concepts.map((c) => c.hy).flatMap((hy) => {
    // Concept keys + their short forms are matched in the passage.
    const parts = hy.split(/\s+/);
    return parts.length > 2 ? [hy, parts.slice(-2).join(" ")] : [hy];
  });
  let conceptHits = 0;
  for (const phrase of conceptPhrases) {
    if (phrase.length >= 5 && body.includes(phrase.toLowerCase())) conceptHits++;
  }
  const conceptRatio = conceptPhrases.length > 0 ? conceptHits / conceptPhrases.length : 0;
  score += conceptRatio * RANK_WEIGHTS.semanticConceptRelevance;

  if (u.concepts.length > 0 && mode === "deep") {
    // In deep mode, concept coverage matters more relative to raw lexicals.
    const titleConcept = u.concepts.some((c) => r.title.toLowerCase().includes(c.hy.slice(0, 12)));
    if (titleConcept) score += RANK_SUB.conceptInTitle * 0.5;
  }

  // ---- authority (spec §17) -----------------------------------------------------
  score += (r.authority / 100) * RANK_WEIGHTS.authority;

  // ---- temporalRelevance (spec §18) ----------------------------------------------
  if (r.temporalStatus === "current") score += RANK_SUB.currentStatusBonus;
  else if (r.temporalStatus === "historical") score += RANK_SUB.historicalPenalty;
  if (p.wantsHistoricalLaw && r.temporalStatus === "historical") {
    // User explicitly wants a historical version — flip the penalty.
    score += -RANK_SUB.historicalPenalty + RANK_SUB.currentStatusBonus;
  }

  // ---- citationQuality (spec §20, §27) ---------------------------------------------
  if (r.url && /^https:\/\//.test(r.url)) score += RANK_SUB.hasCanonicalUrl;
  const passageText = bestPassage(r);
  if (passageText && passageText.length > 120) score += RANK_SUB.hasPassageText;
  if (r.caseNumber) score += RANK_SUB.hasCaseNumber;
  if (resultDate(r)) score += RANK_SUB.hasDate;

  // Normalize: scores are roughly bounded by the sum of component maxima.
  const maxScore =
    RANK_WEIGHTS.exactReference +
    RANK_WEIGHTS.lexicalRelevance +
    RANK_WEIGHTS.semanticConceptRelevance +
    RANK_WEIGHTS.authority +
    RANK_WEIGHTS.temporalRelevance +
    RANK_WEIGHTS.citationQuality;
  const relevance = Math.max(0, Math.min(1, score / maxScore));

  return { score, relevance };
}

/**
 * Rerank all candidates: score -> sort -> cap.
 * Guarantees source diversity: no single source fills more than ~60% of
 * the kept set (cross-check requirement, spec §23 DEEP).
 */
export function rerank(
  candidates: LegalSearchResult[],
  u: QueryUnderstanding,
  mode: SearchMode,
  keep: number,
): LegalSearchResult[] {
  const scored = candidates.map((r) => {
    const { score, relevance } = scoreResult(r, u, mode);
    r.relevance = relevance;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || b.r.authority - a.r.authority);

  const maxPerSource = mode === "deep" ? Math.max(3, Math.ceil(keep * 0.6)) : Math.max(2, Math.ceil(keep * 0.75));
  const perSource = new Map<string, number>();
  const out: LegalSearchResult[] = [];
  for (const { r } of scored) {
    const n = perSource.get(r.sourceId) ?? 0;
    if (n >= maxPerSource) continue;
    perSource.set(r.sourceId, n + 1);
    out.push(r);
    if (out.length >= keep) break;
  }
  // If diversity cap starved the list, top it up with leftovers.
  if (out.length < Math.min(keep, scored.length)) {
    for (const { r } of scored) {
      if (out.includes(r)) continue;
      out.push(r);
      if (out.length >= keep) break;
    }
  }
  return out;
}
