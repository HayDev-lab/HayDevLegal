// src/lib/arlis/arlis-ranker.ts
// Deterministic ranking + deduplication of ARLIS candidates.
//
// Per spec §12, the FIRST FOUR results must be chosen by retrieval logic,
// NOT by the LLM. This module implements a transparent scoring model.
//
// Per spec §13, candidates are deduplicated by canonical URL / actId /
// content hash, so the same act never appears four times from four matching
// fragments. Different articles of the same Code MAY appear separately when
// they directly answer different aspects of the question.

import type { LegalQuery, LegalSource, SourceLabel } from "@/lib/legal/types";
import type { RawCandidate } from "./arlis-parser";
import { arlisActUrl, canonicalizeArlisUrl } from "@/lib/legal/url-security";
import { tokenize } from "@/lib/legal/normalizer";

// Scoring weights (per spec §12 — illustrative, tuned with tests).
const W = {
  exactActAndArticle: 100,
  exactArticle: 70,
  exactActTitle: 55,
  exactCaseNumber: 100,
  exactPhrase: 40,
  titleTokenMatch: 25,
  articleHeadingMatch: 25,
  bodyKeywordMatch: 15,
  currentStatus: 10,
  abbreviationMatch: 30,
  historicalStatusPenalty: -5,
} as const;

export type RankedCandidate = {
  source: LegalSource;
  rawScore: number;
};

/**
 * Convert raw ARLIS candidates into scored, deduplicated LegalSource objects.
 *
 * Two dedup passes:
 *  1. by actId / canonicalUrl (same ARLIS record)
 *  2. by normalized title (same legal act under different incorporations —
 *     e.g. act 6, 71551, 200705, 228566 are all "ՀՀ ՔՐԵԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ
 *     ՕՐԵՆՍԳԻՐՔ" at different incorporation dates). We keep only the first
 *     (highest-scoring) per title group, so the primary code appears once
 *     and secondary sources (Constitutional Court decisions, etc.) fill the
 *     remaining slots.
 */
export function rankAndDedupe(
  candidates: RawCandidate[],
  q: LegalQuery,
): RankedCandidate[] {
  // ---- Pass 1: dedup by actId / canonicalUrl — keep the highest-info candidate.
  const byKey = new Map<string, RawCandidate>();
  for (const c of candidates) {
    const key = c.actId ?? c.canonicalUrl ?? c.title;
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (c.excerpt.length > prev.excerpt.length)) {
      byKey.set(key, c);
    }
  }
  const pass1 = Array.from(byKey.values());

  // ---- Score every candidate
  const scored: RankedCandidate[] = pass1.map((c) => {
    const score = scoreCandidate(c, q);
    const source = toLegalSource(c, score, q);
    return { source, rawScore: score };
  });

  // ---- Sort by score desc, then by title asc, then by actId asc (lowest = canonical)
  scored.sort((a, b) => {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    const t = a.source.title.localeCompare(b.source.title, "hy");
    if (t !== 0) return t;
    const aId = parseInt(a.source.actId ?? "999999", 10);
    const bId = parseInt(b.source.actId ?? "999999", 10);
    return aId - bId;
  });

  // ---- Pass 2: dedup by normalized title — keep only the first per title.
  const seenTitles = new Set<string>();
  const deduped: RankedCandidate[] = [];
  for (const sc of scored) {
    const titleKey = sc.source.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    deduped.push(sc);
  }

  return deduped;
}

function scoreCandidate(c: RawCandidate, q: LegalQuery): number {
  let score = 0;
  const titleLower = c.title.toLowerCase();
  const excerptLower = c.excerpt.toLowerCase();
  const normalizedLower = q.normalized.toLowerCase();
  const titleTokens = new Set(tokenize(c.title));
  const queryTokens = new Set(q.keywords);

  // Does this candidate's title match the queried act title?
  const matchesActTitle = !!q.actTitle && (
    titleLower === q.actTitle.toLowerCase() ||
    titleLower.includes(q.actTitle.toLowerCase())
  );
  const exactActTitleMatch = !!q.actTitle && titleLower === q.actTitle.toLowerCase();

  // exact act title
  if (q.actTitle) {
    const actTitleLower = q.actTitle.toLowerCase();
    if (exactActTitleMatch) score += W.exactActTitle;
    else if (titleLower.includes(actTitleLower)) score += W.exactActTitle * 0.7;
  }

  // exact article — only boost if EITHER (a) this candidate IS the queried
  // act, OR (b) the candidate's excerpt/body actually contains "հոդված {N}".
  // This prevents Constitutional Court decisions that merely MENTION an
  // article number in their title from outranking the primary code.
  if (q.article) {
    const articleLower = `հոդված ${q.article}`;
    const hasArticleInExcerpt = excerptLower.includes(articleLower) ||
      excerptLower.includes(`հոդված${q.article}`);
    if (matchesActTitle && hasArticleInExcerpt) {
      score += W.exactActAndArticle;
    } else if (matchesActTitle) {
      // The act itself but we haven't fetched article text yet — still a strong
      // signal because this is the primary source that CONTAINS the article.
      score += W.exactActAndArticle * 0.85;
    } else if (hasArticleInExcerpt) {
      score += W.exactArticle * 0.5;
    }
  }

  // exact case number
  if (q.caseNumber) {
    if (excerptLower.includes(q.caseNumber.toLowerCase())) {
      score += W.exactCaseNumber;
    }
  }

  // exact phrase (multi-word query) — only for substantial phrases
  if (q.normalized.length > 8 && excerptLower.includes(normalizedLower)) {
    score += W.exactPhrase;
  }

  // abbreviation match (title contains the expanded act title)
  if (q.actTitle && titleLower.includes(q.actTitle.toLowerCase())) {
    score += W.abbreviationMatch;
  }

  // title token overlap
  let titleOverlap = 0;
  for (const t of queryTokens) {
    if (t.length < 2) continue;
    if (titleTokens.has(t)) titleOverlap++;
  }
  score += Math.min(titleOverlap * 8, W.titleTokenMatch);

  // body keyword match (approximate via excerpt)
  let bodyMatches = 0;
  for (const t of queryTokens) {
    if (t.length < 3) continue;
    if (excerptLower.includes(t)) bodyMatches++;
  }
  score += Math.min(bodyMatches * 5, W.bodyKeywordMatch);

  // current status bonus
  if (c.status) {
    const s = c.status.toLowerCase();
    if (s.includes("գործունակ") || s.includes("գործում է")) {
      score += W.currentStatus;
    } else if (s.includes("չի գործունակ") || s.includes("ուժը կորցրել է")) {
      score += W.historicalStatusPenalty;
    }
  }

  return score;
}

function toLegalSource(
  c: RawCandidate,
  score: number,
  q: LegalQuery,
): LegalSource {
  // Normalize canonical URL (force https, validate origin)
  let canonicalUrl = c.canonicalUrl;
  if (c.canonicalUrl) {
    const safe = canonicalizeArlisUrl(c.canonicalUrl);
    if (safe) canonicalUrl = safe;
  } else if (c.actId) {
    canonicalUrl = arlisActUrl(c.actId) ?? undefined;
  }
  // Fallback: build from actId
  if (!canonicalUrl && c.actId) {
    canonicalUrl = `https://arlis.am/hy/acts/${c.actId}/latest`;
  }

  const sourceLabel = inferSourceLabel(c, q);

  // Normalise score to 0..1 for the public field (bounded, monotonic).
  const relevanceScore = Math.max(0, Math.min(1, score / 100));

  return {
    id: "", // assigned later as S1..S4
    source: "ARLIS",
    title: c.title,
    canonicalUrl: canonicalUrl ?? "",
    actId: c.actId,
    actNumber: c.actNumber,
    article: q.article,
    part: q.part,
    point: q.point,
    status: c.status,
    adoptionDate: c.adoptionDate,
    effectiveDate: c.effectiveDate,
    excerpt: c.excerpt,
    retrievedAt: new Date().toISOString(),
    relevanceScore,
    sourceLabel,
  };
}

function inferSourceLabel(c: RawCandidate, q: LegalQuery): SourceLabel {
  const t = c.title.toLowerCase();
  if (q.actType === "casation" || t.includes("վճռաբեկ")) return "Վճռաբեկ դատարան";
  if (q.actType === "constitutional_court" || t.includes("սահմանադրական դատարան"))
    return "Սահմանադրական դատարան";
  if (q.actType === "echr" || t.includes("մարդու իրավունքների եվրոպական դատարան"))
    return "ՄԻԵՎԴ";
  if (t.includes("օրենսգիրք") || t.includes("օրենք") || t.includes("սահմանադրություն"))
    return "Օրենսդրություն";
  return "Իրավական ակտ";
}

/** Assign stable S1..S4 IDs to the top results (mutates the array). */
export function assignCitationIds(results: LegalSource[], max = 4): LegalSource[] {
  const top = results.slice(0, max);
  top.forEach((r, i) => {
    r.id = `S${i + 1}`;
  });
  return top;
}
