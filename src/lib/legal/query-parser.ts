// src/lib/legal/query-parser.ts
// Parses a normalized Armenian legal query into structured fields.
//
// Detection priority:
//   1. case number (ՎԴ/XXXX/XXXX.XX or ենթ/XXXX patterns)
//   2. exact article (ՔԴՕ 108 / հոդված 108 / 108 հոդված / հոդված 108.3)
//   3. act title via abbreviation or known phrase
//   4. date-sensitivity flags ("գործող", "նախկին", "XXXX թվականին", "XX.XX.XXXX դրությամբ")
//   5. keyword set + questionType guess

import type { LegalQuery, QuestionType } from "./types";
import { normalizeQuery, tokenize } from "./normalizer";
import { lookupAbbreviation } from "./abbreviations";

const ARTICLE_RE = /հոդված\s*(\d{1,4})(?:\s*[.\u0589:])?\s*(?:մաս\s*(\d{1,3}))?(?:\s*կետ\s*(\d{1,3}))?/iu;
const ARTICLE_REVERSE_RE = /(\d{1,4})\s*հոդված/u;
const CASE_NUMBER_RE = /([Ա-Ֆա-ֆA-Za-z]+\/?\d{2,5}\/\d{2,4}(?:\.\d{1,2})?)/u;
const DATE_RE = /(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})\s*(?:դրությամբ|թվականին)?/u;
const YEAR_RE = /(\d{4})\s*թվական(?:ին|ի)?/u;
const HISTORICAL_RE = /(նախկին\s+խմբագրությամբ|նախկին\s+տարբերակով|հին\s+խմբագրությամբ|նախկին\s+տեքստով|նախկին\s+խմբագրություն)/u;
const CURRENT_RE = /(գործող\s+խմբագրությամբ|գործող\s+օրենսդրությամբ|ընթացիկ\s+խմբագրությամբ|գործունակ\s+տարբերակով|գործող\s+տարբերակով|գործող\s+օրենք|գործունակ\s+ակտ|ընթացիկ\s+տարբերակ)/u;
const DEFINITION_RE = /(ինչ\s+է|ինչն\s+է|իմաստը|սահմանում\s+է|սահմանման\s+մասին)/u;
const PROCEDURE_RE = /(կարգը|կարգավորությունը|դատավարության\s+կարգ|ընթացակարգը|պրոցեդուրա)/u;
const CASE_LAW_RE = /(Վճռաբեկ\s+դատարան|վճռաբեկ\s+դատարան|դատական\s+նախադեպ|դատական\s+պրակտիկա|Սահմանադրական\s+դատարան|ՄԻԵՎԴ|Մարդու\s+իրավունքների\s+եվրոպական\s+դատարան)/u;

/** Parse a raw user query into a structured LegalQuery. */
export function parseLegalQuery(raw: string): LegalQuery {
  const { normalized, matchedAbbreviations } = normalizeQuery(raw);

  const result: LegalQuery = {
    raw,
    normalized,
    keywords: tokenize(normalized),
    wantsCurrentLaw: false,
    wantsHistoricalLaw: false,
    questionType: "unknown",
  };

  if (!normalized) return result;

  // ---- Date sensitivity
  // Use regex for multi-word phrases, and token-based check for standalone words
  // (JS \b doesn't work with Armenian Unicode, so we check the keyword set).
  const histM = normalized.match(HISTORICAL_RE);
  const currM = normalized.match(CURRENT_RE);
  const hasHistoricalToken = result.keywords.includes("նախկին") || result.keywords.includes("հին");
  const hasCurrentToken = result.keywords.includes("գործող") || result.keywords.includes("ընթացիկ") || result.keywords.includes("գործունակ");
  result.wantsHistoricalLaw = !!histM || hasHistoricalToken;
  result.wantsCurrentLaw = !!currM || hasCurrentToken;

  const dateM = normalized.match(DATE_RE);
  if (dateM) result.date = dateM[1];
  else {
    const yearM = normalized.match(YEAR_RE);
    if (yearM) result.date = yearM[1];
  }

  // ---- Case number
  const caseM = normalized.match(CASE_NUMBER_RE);
  if (caseM) {
    result.caseNumber = caseM[1];
    result.questionType = "case_law";
  }

  // ---- Article
  const artM = normalized.match(ARTICLE_RE);
  const artRevM = !artM ? normalized.match(ARTICLE_REVERSE_RE) : null;
  if (artM || artRevM) {
    result.article = (artM ?? artRevM)![1];
    if (artM?.[2]) result.part = artM[2];
    if (artM?.[3]) result.point = artM[3];
    if (result.questionType === "unknown") result.questionType = "exact_article";
  }

  // ---- Act title / type via abbreviation
  for (const abbr of matchedAbbreviations) {
    result.actTitle = abbr.full;
    result.actType = abbr.actType;
    break; // first match wins
  }

  // ---- Question type heuristics (only if not yet classified)
  if (result.questionType === "unknown") {
    if (CASE_LAW_RE.test(normalized)) result.questionType = "case_law";
    else if (DEFINITION_RE.test(normalized)) result.questionType = "definition";
    else if (PROCEDURE_RE.test(normalized)) result.questionType = "procedure";
    else if (result.actTitle || result.article) result.questionType = "legal_rule";
    else result.questionType = "legal_rule";
  }

  return result;
}

/**
 * Build the ARLIS `simple_text` query string from a parsed LegalQuery.
 *
 * Strategy:
 *  - If an article is present AND we know the act title, send "{actTitle} {article} հոդված".
 *    ARLIS matches act titles well; appending the article number helps surface
 *    the right act even when the article text isn't indexed separately.
 *  - If only an abbreviation-mapped act title is known, send the full title.
 *  - Otherwise send the normalized query verbatim.
 *
 * We also return fallback query variants the adapter can try if the first
 * ARLIS call returns no results.
 */
export function buildArlisQueries(q: LegalQuery): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (s: string | undefined) => {
    if (!s) return;
    const t = s.trim();
    if (!t) return;
    if (seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    variants.push(t);
  };

  if (q.actTitle && q.article) {
    // ARLIS matches act titles well; the combined "{title} {article}" query
    // tends to surface decisions ABOUT that article rather than the code
    // itself. So try the bare act title FIRST, then the combined variants.
    push(q.actTitle);
    push(`${q.actTitle} հոդված ${q.article}`);
    push(`${q.actTitle} ${q.article}`);
  } else if (q.actTitle) {
    push(q.actTitle);
  } else if (q.article) {
    push(q.article);
    push(`հոդված ${q.article}`);
  }
  // Always try the normalized query as a final variant
  push(q.normalized);
  // And a keyword-joined variant
  if (q.keywords.length > 1) {
    push(q.keywords.slice(0, 8).join(" "));
  }
  return variants;
}

/** Re-export for convenience */
export { lookupAbbreviation };
