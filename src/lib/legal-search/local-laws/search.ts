// src/lib/local-laws/search.ts
// Deterministic NO-RAG search over the curated local corpus (spec §6-§7).
//
// Retrieval ladder (all deterministic, no LLM, no vector store):
//   1. ACT RESOLUTION     — Armenian abbreviation aliases (ՔԴՕ, ՔՕ, ՍԱ …) with
//                           strict word boundaries, act-title phrases, stem and
//                           Levenshtein-1 fuzzy fallbacks.
//   2. EXACT ARTICLE      — "հոդված 179" / parsed article refs resolved against
//                           the resolved act(s); bare article numbers resolve
//                           across all acts, ranked by lexical support.
//   3. LEXICAL + CONCEPT  — inverted-index token scoring (exact word form +
//                           5-char prefix inflection fallback), concept phrase
//                           containment, title hits, resolved-act boost.
//
// Everything is grounded: results are actual corpus articles with their real
// bodies — nothing is generated or approximated.

import type { LegalSearchQuery } from "@/lib/legal-search/types";
import { expandAbbreviations } from "@/lib/legal/abbreviations";
import { tokenize } from "@/lib/legal/normalizer";
import {
  loadLocalCorpus,
  type LocalLawAct,
  type LocalLawArticle,
  type LocalLawCorpus,
} from "./loader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalLawMatch = {
  act: LocalLawAct;
  article: LocalLawArticle;
  /** Deterministic relevance 0..1 (exact refs ~0.95+, lexical capped lower). */
  relevance: number;
  /** Why this matched (for trace/debugging). */
  signals: string[];
};

// ---------------------------------------------------------------------------
// Act resolution (aliases, titles, fuzzy)
// ---------------------------------------------------------------------------

/** Armenian word boundary: JS \b does NOT work with Armenian Unicode. */
function boundaryRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\u0530-\\u058fa-z0-9])${escaped}(?![\\u0530-\\u058fa-z0-9])`, "iu");
}

/** Classic bounded Levenshtein (≤1 for this use case). */
function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return true;
}

/**
 * Armenian inflection stem match: two word forms are the same stem when they
 * share a prefix of at least max(5, 2/3 of the shorter form).
 *   "սահմանադրության" ~ "սահմանադրություն" (dative -ան vs nominative -ուն)
 *   "օրենսգրքի"       ~ "օրենսգիրք"        (genitive -ի inserted)
 * but "դատավարության" !~ "դատական"            (different words).
 */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  let common = 0;
  while (common < minLen && a[common] === b[common]) common++;
  return common >= Math.max(5, Math.ceil((2 / 3) * minLen));
}

const ARM_STOPWORDS = new Set([
  "և", "է", "են", "էր", "եմ", "ես", "ենք", "եք", "եի", "եին", "ի", "ա", "ում",
  "որ", "որը", "որոնք", "մասին", "ինչ", "ինչպես", "եթե", "կամ", "նաև", "դե",
  "եղել", "լինել", "կա", "կան", "կար", "չի", "չեն", "չէ", "պիտի", "պետք",
  "համար", "դեպքում", "տվյալ", "վերաբերյալ", "համաձայն", "սույն", "այդ", "այս",
  "մեջ", "հետ", "մի", "որպես", "առաջ", "հետո", "ապա", "բայց", "որտեղ", "երբ",
  "what", "the", "and", "for", "with", "how", "does", "is", "are",
]);

/** Resolve which corpus acts the query targets. Returns category -> strength. */
function resolveActs(query: LegalSearchQuery, corpus: LocalLawCorpus): Map<string, number> {
  const hits = new Map<string, number>();
  const bump = (category: string, strength: number) => {
    hits.set(category, Math.max(hits.get(category) ?? 0, strength));
  };

  // 1. Canonical abbreviation aliases (strict token equality — the historic
  //    "ԴՕ substring-matched ՔԴՕ" bug is impossible by construction).
  const rawLower = query.raw.toLowerCase();
  const { matched } = expandAbbreviations(query.raw);
  const rawTokens = new Set(tokenize(rawLower));
  for (const entry of matched) {
    for (const act of corpus.acts) {
      const metaTitle = act.shortTitle.toLowerCase();
      const entryFull = entry.full.toLowerCase();
      if (metaTitle === entryFull || metaTitle.includes(entryFull)) {
        bump(act.category, 5);
      }
    }
  }
  for (const act of corpus.acts) {
    for (const piece of act.searchText.split(" | ")) {
      if (piece.length >= 2 && piece.length <= 6 && !piece.includes(" ")) {
        // Short abbreviation-like alias: token-exact only.
        if (rawTokens.has(piece)) bump(act.category, 5);
      }
    }
  }

  // 2. Phrase aliases with word boundaries (lowercased).
  for (const act of corpus.acts) {
    for (const piece of act.searchText.split(" | ")) {
      if (piece.includes(" ")) {
        if (boundaryRegex(piece).test(rawLower)) bump(act.category, 4);
      }
    }
  }

  // 3. Act titles from the parser / exact references.
  const titleHints = new Set<string>();
  const parsed = query.understanding.parsed;
  if (parsed?.actTitle) titleHints.add(parsed.actTitle);
  for (const t of query.understanding.exactReferences.actTitles) titleHints.add(t);
  if (titleHints.size > 0) {
    for (const act of corpus.acts) {
      const actLower = act.searchText;
      for (const hint of titleHints) {
        const hintLower = hint.toLowerCase();
        if (actLower.includes(hintLower) || hintLower.includes(act.shortTitle.toLowerCase())) {
          bump(act.category, 4);
        }
      }
    }
  }

  // 4. Stem + fuzzy fallback on distinctive title tokens ( Armenian
  //    inflection: "օրենսգրքի" vs "օրենսգիրք", "սահմանադրության" vs
  //    "սահմանադրություն"; typos: "սահմանադրությին").
  const distinctiveTokens = tokenize(rawLower).filter(
    (t) => t.length >= 6 && !ARM_STOPWORDS.has(t) && !/^\d+$/.test(t),
  );
  for (const act of corpus.acts) {
    const titleTokens = tokenize(act.searchText).filter((t) => t.length >= 6);
    let best = 0;
    for (const qt of distinctiveTokens) {
      for (const tt of titleTokens) {
        if (sameStem(qt, tt)) best = Math.max(best, 3);
        else if (withinEditDistance1(qt, tt)) best = Math.max(best, 2);
      }
    }
    if (best > 0) bump(act.category, best);
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Query terms
// ---------------------------------------------------------------------------

function articleNumbers(query: LegalSearchQuery): string[] {
  const nums = new Set<string>();
  const push = (v: string | undefined) => {
    if (!v) return;
    const m = v.match(/\d{1,4}/);
    if (m) nums.add(m[0]);
  };
  push(query.understanding.parsed?.article);
  for (const a of query.understanding.exactReferences.articles) push(a);
  // "հոդված 179" / "հոդված 179-րդ" (number AFTER the word)…
  const re = /հոդված\s*(\d{1,4})(?:\s*[-−–]?\s*րդ)?/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query.raw)) !== null) nums.add(m[1]);
  // …and "179-րդ հոդված" / "179 հոդված" (number BEFORE the word).
  const reBefore = /(\d{1,4})(?:\s*[-−–]?\s*րդ)?\s*հոդված/giu;
  while ((m = reBefore.exec(query.raw)) !== null) nums.add(m[1]);
  return Array.from(nums);
}

/**
 * Standalone 1-4 digit numbers in the raw query, guarded against:
 *   - case numbers (digits adjacent to "/", e.g. ՎԴ/0008/05/23, 11275/07)
 *   - hyphenated compounds (ՀՕ-227-Ն law numbers, "179-րդ" ordinals)
 *   - part/point references (մաս 2, կետ 3)
 *   - years (2022 թվական)
 * Only consulted when an act was already resolved by alias/title — this is
 * the "ՔԴՕ 179" citation convention (act abbreviation + article number).
 */
function bareArticleNumbers(raw: string): string[] {
  const out: string[] = [];
  const re = /\d{1,4}/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const i = m.index;
    const num = m[0];
    const before = raw.slice(Math.max(0, i - 14), i).toLowerCase();
    const after = raw.slice(i + num.length, i + num.length + 10).toLowerCase();
    if (/\d$|\/$/.test(before)) continue;
    if (/^[\d\/]/.test(after)) continue;
    if (/-$/.test(before) || /^[-\u2010-\u2015]/.test(after)) continue;
    if (/(մաս|կետ|պունկտ|թվական|թ\.)\s*$/.test(before)) continue;
    if (/^\s*(թվական|թ\.)/.test(after)) continue;
    out.push(num);
  }
  return out.slice(0, 3);
}

function lexicalTokens(query: LegalSearchQuery): string[] {
  const tokens = new Set<string>();
  for (const t of tokenize(query.raw)) {
    if (t.length < 3 || /^\d+$/.test(t) || ARM_STOPWORDS.has(t)) continue;
    tokens.add(t);
  }
  for (const v of query.variants) {
    if (v.lang !== "hy") continue;
    for (const t of tokenize(v.text)) {
      if (t.length < 3 || /^\d+$/.test(t) || ARM_STOPWORDS.has(t)) continue;
      tokens.add(t);
    }
  }
  return Array.from(tokens).slice(0, 40);
}

function conceptPhrases(query: LegalSearchQuery): string[] {
  const phrases = new Set<string>();
  for (const c of query.understanding.concepts) {
    if (c.hy) phrases.add(c.hy.toLowerCase());
    for (const p of c.relatedPhrases ?? []) phrases.add(p.toLowerCase());
  }
  return Array.from(phrases).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type ScoreEntry = {
  idx: number;
  score: number;
  distinctTokens: number;
  conceptHits: number;
  titleHits: number;
  actBoost: boolean;
  signals: Set<string>;
};

function scoreLexical(
  corpus: LocalLawCorpus,
  tokens: string[],
  phrases: string[],
  actHits: Map<string, number>,
): Map<number, ScoreEntry> {
  const entries = new Map<number, ScoreEntry>();
  const get = (idx: number): ScoreEntry => {
    let e = entries.get(idx);
    if (!e) {
      e = {
        idx,
        score: 0,
        distinctTokens: 0,
        conceptHits: 0,
        titleHits: 0,
        actBoost: false,
        signals: new Set<string>(),
      };
      entries.set(idx, e);
    }
    return e;
  };

  for (const token of tokens) {
    const exact = corpus.bodyIndex.get(token);
    if (exact && exact.length > 0) {
      if (exact.length <= 400) {
        for (const idx of exact) {
          const e = get(idx);
          e.score += 1;
          e.distinctTokens += 1;
        }
      }
      continue;
    }
    if (token.length >= 6) {
      const prefix = corpus.bodyPrefixIndex.get(token.slice(0, 5));
      if (prefix && prefix.length > 0 && prefix.length <= 600) {
        for (const idx of prefix) {
          const e = get(idx);
          e.score += 0.5;
          e.distinctTokens += 1;
          e.signals.add("inflection");
        }
      }
      continue;
    }
  }

  for (const token of tokens) {
    const titleHit = corpus.titleIndex.get(token);
    if (titleHit && titleHit.length > 0 && titleHit.length <= 200) {
      for (const idx of titleHit) {
        const e = get(idx);
        e.score += 2;
        e.titleHits += 1;
        e.signals.add("title");
      }
    }
  }

  // Concept phrase containment — only on the shortlist (score > 0) to bound
  // the includes() scans.
  if (phrases.length > 0) {
    const shortlist = Array.from(entries.values()).filter((e) => e.score > 0);
    for (const e of shortlist) {
      const art = corpus.flat[e.idx];
      const titleText = `${art.titleLower} ${art.actIdx >= 0 ? corpus.acts[art.actIdx].shortTitle.toLowerCase() : ""}`;
      for (const phrase of phrases) {
        if (phrase.length < 4) continue;
        if (titleText.includes(phrase)) {
          e.score += 4;
          e.conceptHits += 1;
          e.signals.add("concept-title");
        } else if (art.bodyLower.includes(phrase)) {
          e.score += 3;
          e.conceptHits += 1;
          e.signals.add("concept-body");
        }
      }
    }
  }

  // Resolved-act boost.
  if (actHits.size > 0) {
    for (const e of entries.values()) {
      const act = corpus.acts[corpus.flat[e.idx].actIdx];
      const strength = actHits.get(act.category) ?? 0;
      if (strength >= 2) {
        e.score += 2;
        e.actBoost = true;
        e.signals.add("act-alias");
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public search API
// ---------------------------------------------------------------------------

/**
 * Search the curated local corpus for the given federated query.
 * Deterministic, fail-closed (empty corpus -> no matches).
 */
export async function searchLocalLaws(
  query: LegalSearchQuery,
  limit = 12,
): Promise<LocalLawMatch[]> {
  const corpus = await loadLocalCorpus();
  if (corpus.acts.length === 0) return [];

  const actHits = resolveActs(query, corpus);
  let nums = articleNumbers(query);

  // "ՔԴՕ 179" convention: a standalone number right after a resolved act
  // alias/title IS the article number.
  if (nums.length === 0) {
    const strongest = Math.max(0, ...Array.from(actHits.values()));
    if (strongest >= 4) nums = bareArticleNumbers(query.raw);
  }

  const tokens = lexicalTokens(query);
  const phrases = conceptPhrases(query);

  // Meaningful tokens for bare-number lexical support (generic reference
  // words like "հոդված"/"article" must NOT count as support; short tokens
  // like "գործ" substring-match unrelated words like "գործողություն").
  const GENERIC_REF_WORDS = new Set(["հոդված", "article", "մաս", "կետ", "պունկտ"]);
  const supportTokens = tokens.filter((t) => t.length >= 5 && !GENERIC_REF_WORDS.has(t));

  /** Distinct lexical/concept hits of the query inside ONE article. */
  const lexicalSupport = (art: LocalLawArticle): number => {
    let hits = 0;
    for (const t of supportTokens) {
      if (art.bodyLower.includes(t) || art.titleLower.includes(t)) hits++;
    }
    for (const p of phrases) {
      if (p.length >= 4 && (art.bodyLower.includes(p) || art.titleLower.includes(p))) hits++;
    }
    return hits;
  };

  const out = new Map<string, LocalLawMatch>();

  // --- Ladder 2: exact article references ---------------------------------
  if (nums.length > 0) {
    const targetActs =
      actHits.size > 0
        ? Array.from(actHits.keys())
            .map((c) => corpus.acts.find((a) => a.category === c))
            .filter((a): a is LocalLawAct => !!a)
        : corpus.acts;
    for (const num of nums.slice(0, 3)) {
      for (const act of targetActs) {
        const art = act.byNum.get(num);
        if (!art || art.num === "0") continue;
        const strength = actHits.get(act.category);
        if (strength) {
          // Act resolved (alias/title) + article number -> canonical hit.
          out.set(`${act.category}#${num}`, {
            act,
            article: art,
            relevance: 0.98,
            signals: ["alias+article", `հոդված ${num}`],
          });
        } else {
          // Bare article number with NO act hint (e.g. an English "Article 5"
          // parse): only surface the article from acts where THIS article
          // has real lexical/concept support — never flood every act.
          const support = lexicalSupport(art);
          if (support >= 1) {
            out.set(`${act.category}#${num}`, {
              act,
              article: art,
              relevance: 0.88,
              signals: ["article-number+lexical", `հոդված ${num}`],
            });
          }
        }
      }
    }
  }

  // --- Ladder 3: lexical + concept ----------------------------------------
  const scored = scoreLexical(corpus, tokens, phrases, actHits);
  const candidates = Array.from(scored.values())
    .filter((e) => {
      if (e.score < 2) return false;
      return e.distinctTokens >= 2 || e.conceptHits >= 1 || e.titleHits >= 1;
    })
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  for (const e of candidates) {
    if (out.size >= limit) break;
    const art = corpus.flat[e.idx];
    const act = corpus.acts[art.actIdx];
    const key = `${act.category}#${art.num}`;
    if (out.has(key)) continue;
    // Lexical matches stay strictly below the exact-reference band
    // (0.90 bare article / 0.98 alias+article) — no fake confidence.
    const relevance = Math.min(0.85, e.score / 8);
    if (relevance < 0.15) continue;
    out.set(key, {
      act,
      article: art,
      relevance,
      signals: Array.from(e.signals),
    });
  }

  // Exact references first, then score order.
  return Array.from(out.values())
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}
