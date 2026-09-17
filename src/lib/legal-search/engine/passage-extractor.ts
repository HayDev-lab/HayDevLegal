// src/lib/legal-search/engine/passage-extractor.ts
// Relevant passage extraction (spec §15).
//
// Pipeline: (document text, already sanitized) -> structural split ->
// score passages against the query -> top passages.
// We never send whole HTML to the model — only focused legal passages.

import { tokenize } from "@/lib/legal/normalizer";
import { truncatePassage } from "../security/content-sanitizer";
import { STAGES } from "../config";
import type { LegalSearchResult } from "../types";

/** Split text into structural passages (paragraph/article aware). */
export function splitPassages(text: string): string[] {
  if (!text) return [];
  // Prefer article boundaries when present (Հոդված N).
  const byArticle = text.split(/(?=\n?\s*Հոդված\s*\d{1,4}\s*[.։:])/u);
  const out: string[] = [];
  for (const chunk of byArticle) {
    const c = chunk.trim();
    if (!c) continue;
    if (c.length <= 2400) {
      out.push(c);
      continue;
    }
    // Split long chunks further on blank lines / sentence groups.
    const paras = c.split(/\n{2,}|\n(?=\s*[Ա-ՖA-Z0-9«])/);
    let buf = "";
    for (const para of paras) {
      const p = para.trim();
      if (!p) continue;
      if ((buf + "\n" + p).length > 2000 && buf) {
        out.push(buf);
        buf = p;
      } else {
        buf = buf ? `${buf}\n${p}` : p;
      }
    }
    if (buf) out.push(buf);
  }
  // Filter noise: too short or too numeric.
  return out.filter((p) => {
    const words = p.split(/\s+/);
    if (words.length < 6) return false;
    const digits = (p.match(/\d/g) ?? []).length;
    return digits / Math.max(1, p.length) < 0.3;
  });
}

/**
 * Score a passage against query tokens + concepts.
 * Deterministic lexical + concept overlap (no embeddings — spec §7).
 * Phase 3 §43 (Passage Extractor 2.0): additionally weighs exact reference
 * matches, heading structure, term proximity, query intent and court
 * reasoning indicators.
 */

/** Court reasoning indicators (§36) — "the court held/reasoned that..." */
const REASONING_MARKERS_HY = [
  "դատարանը գտնում է",
  "դատարանը եկել է եզրակացության",
  "ղեկավարվելով",
  "ելնելով",
  "հիմնավորված է",
  "ապացուցված է",
  "իրավական դիրքորոշում",
  "նախադեպային նշանակություն",
  "վճռաբեկ դատարանի դիրքորոշում",
];
const REASONING_MARKERS_EN = [
  "the court finds",
  "the court held",
  "held that",
  "it follows that",
  "the court considers",
  "reasoned that",
];

/** Heading-like passage starts (structure signal, §43). */
const HEADING_RE =
  /^\s*(ՀՈԴՎԱԾ\s*\d|Հոդված\s*\d|ԳԼՈՒԽ|ԲԱԺԻՆ|ԴԱՏԱՐԱՆԻ|ՎՃՌԻ ՄԱՍ|THE COURT|PROCEDURE|FACTS|THE LAW|RELEVANT)/iu;

/** Query intent keyword classes (§43 "query intent"). */
const INTENT_RULE = /կարգ|կանոն|իրավունք|պարտականություն|սահմանվում է|սահմանում/i;
const INTENT_PRACTICE = /դատարան|պրակտիկ|նախադեպ|վճիռ|որոշում|գործ/i;

function countMatches(lower: string, markers: string[]): number {
  let n = 0;
  for (const m of markers) if (lower.includes(m)) n++;
  return n;
}

export function scorePassage(
  passage: string,
  queryTokens: Set<string>,
  conceptPhrases: string[],
  opts: {
    /** Exact reference asked for (case number / article) — §43 exact reference. */
    exactReference?: string;
    /** Query intent hint: rule vs practice. */
    intent?: "rule" | "practice";
    /** Source authority 0..100 (§43 source authority). */
    authority?: number;
  } = {},
): number {
  if (!passage) return 0;
  const lower = passage.toLowerCase();
  const passageTokens = new Set(tokenize(passage));

  // Token overlap (query terms).
  let overlap = 0;
  for (const t of queryTokens) {
    if (t.length < 3) continue;
    if (passageTokens.has(t)) overlap += 1;
    else if (lower.includes(t)) overlap += 0.5;
  }
  const tokenScore = queryTokens.size > 0 ? overlap / Math.max(3, queryTokens.size) : 0;

  // Concept phrase presence (strong signal).
  let conceptHits = 0;
  for (const phrase of conceptPhrases) {
    const ph = phrase.toLowerCase();
    if (ph.length >= 4 && lower.includes(ph)) conceptHits += 1;
  }
  const conceptScore = conceptPhrases.length > 0 ? conceptHits / conceptPhrases.length : 0;

  // §43: exact reference match — decisive signal.
  let exactRefScore = 0;
  if (opts.exactReference) {
    const ref = opts.exactReference.toLowerCase().replace(/\s+/g, "");
    if (ref && lower.replace(/\s+/g, "").includes(ref)) exactRefScore = 1;
  }

  // §43: heading detection (structural position).
  const headingScore = HEADING_RE.test(passage) ? 1 : 0;

  // §43: term proximity — min window covering >= 2 distinct query terms.
  let proximityScore = 0;
  if (queryTokens.size >= 2) {
    const positions: number[] = [];
    for (const t of queryTokens) {
      if (t.length < 4) continue;
      const idx = lower.indexOf(t);
      if (idx >= 0) positions.push(idx);
    }
    if (positions.length >= 2) {
      positions.sort((a, b) => a - b);
      const window = positions[positions.length - 1] - positions[0];
      proximityScore = window > 0 && window <= 1200 ? Math.min(1, 1200 / window) : 0.15;
    }
  }

  // §43: query intent alignment.
  let intentScore = 0.5; // neutral
  if (opts.intent === "rule") intentScore = INTENT_RULE.test(passage) ? 1 : 0.35;
  else if (opts.intent === "practice") intentScore = INTENT_PRACTICE.test(passage) ? 1 : 0.35;

  // §36/§43: court reasoning indicators.
  const reasoningHits = countMatches(lower, REASONING_MARKERS_HY) + countMatches(lower, REASONING_MARKERS_EN);
  const reasoningScore = Math.min(1, reasoningHits * 0.5);

  // §43: source authority (normalized 0..1).
  const authorityScore = opts.authority !== undefined ? opts.authority / 100 : 0.5;

  // Position prior: passages near the top of a legal document are often
  // the operative part; slight boost only.
  const lengthPenalty = passage.length > 2200 ? 0.85 : 1;

  // Weighted blend — exact reference and concepts dominate; structural and
  // reasoning signals refine. Weights live here ONLY (centralized scoring).
  const blended =
    exactRefScore * 0.30 +
    tokenScore * 0.18 +
    conceptScore * 0.20 +
    headingScore * 0.05 +
    proximityScore * 0.07 +
    intentScore * 0.05 +
    reasoningScore * 0.10 +
    authorityScore * 0.05;

  return Math.min(1, blended * lengthPenalty);
}

/**
 * Extract top passages for a result from its fetched document text.
 * Sets `passages` and returns them.
 */
export function extractPassages(
  result: LegalSearchResult,
  documentText: string,
  queryTokens: Set<string>,
  conceptPhrases: string[],
  max = 3,
): string[] {
  const passages = splitPassages(documentText);
  if (passages.length === 0) return [];

  // §43 — exact reference signal for this document (its own case number or
  // the article the user asked about).
  const exactReference = result.caseNumber ?? result.article;
  // §43 — query intent: case-law documents score practice-oriented passages.
  const intent: "rule" | "practice" =
    result.sourceType === "case_law" || result.sourceType === "cassation" ||
    result.sourceType === "constitutional_court" || result.sourceType === "echr"
      ? "practice"
      : "rule";

  const scored = passages.map((p) => ({
    text: truncatePassage(p, STAGES.passageMaxChars),
    score: scorePassage(p, queryTokens, conceptPhrases, {
      exactReference,
      intent,
      authority: result.authority,
    }),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Keep order of appearance for readability, only top-scored.
  const top = scored
    .filter((s) => s.score > 0.08)
    .slice(0, max)
    .map((s) => s.text);

  result.passages = top;
  return top;
}

/** Best single passage for an evidence item. */
export function bestPassage(result: LegalSearchResult): string {
  if (result.passages && result.passages.length > 0) return result.passages[0];
  if (result.fullText) return truncatePassage(result.fullText, STAGES.passageMaxChars);
  return truncatePassage(result.excerpt, STAGES.passageMaxChars);
}
