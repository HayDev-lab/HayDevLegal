// src/lib/legal-drafting/verification/citation-firewall.ts
// Phase 6 — §17 — Citation firewall.
//
// Every citation appearing in the draft MUST map to a sourceId in the
// SourceIdMap. The SourceIdMap is the canonical bridge between:
//   - Internal source ids (F1, CE4, L2, C3, CC1, E5, A2) used by the AI while
//     drafting (§10).
//   - Human-readable citations rendered at export time (§28: "normal export
//     renders human-readable legal citations, NOT debug IDs").
//
// This firewall verifies:
//   1) Every internal source id cited in a section's `content.sourceIds`
//      array appears as a key in the SourceIdMap (so the export can render
//      it).
//   2) Every human-readable citation token found in the section body (e.g.
//      "Article 215", "հոդված 215", "статья 215", "Decision KD/2207") matches
//      a SourceIdMap entry's `citation` field — i.e. the drafter did NOT
//      invent article / case numbers that aren't grounded in a verified
//      source.
//   3) Article numbers, case numbers, and dates inside the cited authority's
//      human-readable form match the underlying source's stored citation
//      (the SourceIdMap is the source of truth — the draft cannot
//      paraphrase it differently).
//
// CRITICAL — §17: "Every citation in the draft must map to a sourceId in the
//                  SourceIdMap."
// CRITICAL — §28: "Normal export renders human-readable legal citations, NOT
//                  debug IDs (F1/C2 etc.)."

import type {
  DraftSection,
  SectionWarning,
  SourceIdMap,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// Human-readable citation extractors (§17 — article numbers, case numbers,
// dates). These patterns are intentionally broad — the firewall errs on the
// side of flagging suspicious-looking citations rather than missing them.
// ---------------------------------------------------------------------------

// Article number patterns: "Article 215", "Art. 215", "հոդված 215",
// "статья 215", "Art. 215.1", "հոդված 215.1"
const ARTICLE_PATTERNS = [
  /\barticle\s+(\d+(?:\.\d+)*)\b/gi,
  /\bart\.?\s+(\d+(?:\.\d+)*)\b/gi,
  /\bհոդված\s+(\d+(?:\.\d+)*)\b/gi,
  /\bстатья\s+(\d+(?:\.\d+)*)\b/gi,
  /\bст\.?\s+(\d+(?:\.\d+)*)\b/gi,
];

// Case-number patterns: "Decision NKD/2207", "Վճիռ KD/2207", "Решение NКД-2207"
// Cassation/ConCourt decisions often look like "ՆՈԴ/2207" or "НКД/2207".
const CASE_NUMBER_PATTERNS = [
  /\b(?:decision|վճիռ|решение|judgment|ruling)\s+([A-ZԱՖՐա-ֆА-Яа-я]{2,5}[/\-]\d{2,6}(?:[/\-]\d{2,4})?)\b/gi,
  /\b([A-ZԱՖՐա-ֆА-Яа-я]{2,5}[/\-]\d{2,6}(?:[/\-]\d{2,4})?)\b/g,
];

// Date patterns: ISO or Armenian-style "15.03.2023" / "2023-03-15"
const DATE_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}|\d{1,2}\s+(?:հոկտեմբերի|նոյեմբերի|դեկտեմբերի|հունվարի|փետրվարի|մարտի|ապրիլի|մայիսի|հունիսի|հուլիսի|օգոստոսի|սեպտեմբերի),?\s+\d{4})\b/gi;

// Quotation marks (Armenian « », Russian « », English " ", German „ ".
const QUOTATION_MARK_PAIRS: Array<[string, string]> = [
  ["«", "»"],
  ["„", "“"],
  ['"', '"'],
  ["“", "”"],
  ["‘", "’"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract article numbers mentioned in a section body. */
function extractArticleNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const re of ARTICLE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.add(m[1]);
    }
  }
  return Array.from(out);
}

/** Extract case-number tokens mentioned in a section body. */
function extractCaseNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const re of CASE_NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.add(m[1]);
    }
  }
  return Array.from(out);
}

/** Extract date tokens mentioned in a section body. */
function extractDates(text: string): string[] {
  const out = new Set<string>();
  DATE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_PATTERN.exec(text)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out);
}

/** Extract any text inside matched quotation marks. */
function extractQuotedText(text: string): string[] {
  const out: string[] = [];
  for (const [open, close] of QUOTATION_MARK_PAIRS) {
    let i = 0;
    while (i < text.length) {
      const startIdx = text.indexOf(open, i);
      if (startIdx < 0) break;
      const endIdx = text.indexOf(close, startIdx + 1);
      if (endIdx < 0) break;
      out.push(text.slice(startIdx + 1, endIdx));
      i = endIdx + 1;
    }
  }
  return out;
}

/** Internal source id regex (§10). */
const INTERNAL_SOURCE_ID_RE =
  /^(F|CE|L|C|CC|E|A)(\d+)$/;

/** True if the token is an internal source id. */
function isInternalSourceId(sid: string): boolean {
  return INTERNAL_SOURCE_ID_RE.test(sid);
}

/** Normalize a citation string for fuzzy comparison. */
function normalizeCitation(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:()\[\]]/g, "")
    .trim();
}

/**
 * §17 — Verify citations in the draft.
 *
 * Walks every section and verifies that:
 *   - Every internal source id cited in `content.sourceIds` appears as a key
 *     in the SourceIdMap.
 *   - Every human-readable citation token (article, case number, date) found
 *     in the section body matches some SourceIdMap entry's `citation` field
 *     (so the drafter did not invent article / case numbers).
 *
 * Returns a VerificationResult plus a list of inline warnings to surface in
 * the drafting UI (§24).
 */
export async function verifyCitations(
  sections: DraftSection[],
  sourceIdMap: SourceIdMap,
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  // Build the set of valid internal source ids + the set of normalized
  // human-readable citations present in the map.
  const validSourceIds = new Set(Object.keys(sourceIdMap ?? {}));
  const normalizedCitations = new Set<string>();
  for (const entry of Object.values(sourceIdMap ?? {})) {
    if (entry?.citation) {
      normalizedCitations.add(normalizeCitation(entry.citation));
    }
  }

  for (const section of sections) {
    const text = section.content?.text ?? "";
    const sourceIds = section.content?.sourceIds ?? [];

    // 1) Internal source ids must be in the SourceIdMap.
    for (const sid of sourceIds) {
      if (isInternalSourceId(sid) && !validSourceIds.has(sid)) {
        assertions.push({
          type: "CITATION_IN_CONTEXT",
          passed: false,
          detail: `Section "${section.title}" cites internal source id ${sid} which is not present in the SourceIdMap. The export cannot render it as a human-readable citation (§28).`,
          sourceId: sid,
        });
      } else if (isInternalSourceId(sid)) {
        assertions.push({
          type: "CITATION_IN_CONTEXT",
          passed: true,
          detail: `${sid} is present in the SourceIdMap.`,
          sourceId: sid,
        });
      }
    }

    // 2) Article numbers mentioned in body must match a map entry's citation.
    //    This is a fuzzy comparison: we look for the article number anywhere
    //    inside a normalized citation string.
    const articleNumbers = extractArticleNumbers(text);
    for (const num of articleNumbers) {
      const matched = Array.from(normalizedCitations).some((c) =>
        c.includes(normalizeCitation(num)) || c.includes(num),
      );
      if (!matched) {
        assertions.push({
          type: "CITATION_ARTICLE_MATCH",
          passed: false,
          detail: `Section "${section.title}" cites article ${num} which does not match any authority in the SourceIdMap. The AI may not invent article numbers (§14). Insert [SUPPORT_REQUIRED] or relink to a verified authority.`,
        });
      } else {
        assertions.push({
          type: "CITATION_ARTICLE_MATCH",
          passed: true,
          detail: `Article ${num} matches an authority citation in the SourceIdMap.`,
        });
      }
    }

    // 3) Case numbers mentioned in body must match a map entry.
    const caseNumbers = extractCaseNumbers(text);
    for (const cn of caseNumbers) {
      const matched = Array.from(normalizedCitations).some((c) =>
        c.includes(normalizeCitation(cn)),
      );
      if (!matched) {
        assertions.push({
          type: "CITATION_CASE_MATCH",
          passed: false,
          detail: `Section "${section.title}" cites case number "${cn}" which does not match any precedent in the SourceIdMap. The AI may not invent case numbers (§14, §17). Insert [SUPPORT_REQUIRED] or relink to a verified precedent.`,
        });
      } else {
        assertions.push({
          type: "CITATION_CASE_MATCH",
          passed: true,
          detail: `Case number "${cn}" matches a precedent citation in the SourceIdMap.`,
        });
      }
    }

    // 4) Dates mentioned in body must match a map entry's date.
    //    (Most cited authorities carry a date. An invented date is a fabrication.)
    const dates = extractDates(text);
    if (dates.length > 0 && normalizedCitations.size > 0) {
      for (const d of dates) {
        // Look for the date token in any normalized citation.
        const matched = Array.from(normalizedCitations).some((c) =>
          c.includes(normalizeCitation(d)),
        );
        if (!matched) {
          assertions.push({
            type: "CITATION_DATE_MATCH",
            passed: false,
            detail: `Section "${section.title}" mentions date ${d} which does not appear in any authority citation in the SourceIdMap. The AI may not invent dates (§14). Insert [SUPPORT_REQUIRED] or relink to a verified authority.`,
          });
        } else {
          assertions.push({
            type: "CITATION_DATE_MATCH",
            passed: true,
            detail: `Date ${d} matches an authority citation.`,
          });
        }
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}

/**
 * Helper exposed for the export layer: returns the human-readable citation
 * for an internal source id (or null when no map entry exists). Used at
 * export time to convert internal ids to readable citations (§10, §28).
 */
export function renderCitation(
  sourceId: string,
  sourceIdMap: SourceIdMap,
): string | null {
  const entry = sourceIdMap?.[sourceId];
  if (!entry || !entry.citation) return null;
  return entry.citation;
}

/**
 * Helper exposed for the quote-firewall: returns the SourceIdMap entry for a
 * source id (or null). The quote firewall needs the entry to look up the
 * underlying source's verbatim passages.
 */
export function lookupSourceEntry(
  sourceId: string,
  sourceIdMap: SourceIdMap,
): SourceIdMap[string] | null {
  return sourceIdMap?.[sourceId] ?? null;
}

/**
 * Helper exposed for the review model: produces inline §24 warnings derived
 * from the citation firewall's verdicts.
 */
export function citationWarnings(
  sections: DraftSection[],
  sourceIdMap: SourceIdMap,
): SectionWarning[] {
  const warnings: SectionWarning[] = [];
  const validSourceIds = new Set(Object.keys(sourceIdMap ?? {}));
  for (const section of sections) {
    const sourceIds = section.content?.sourceIds ?? [];
    for (const sid of sourceIds) {
      if (isInternalSourceId(sid) && !validSourceIds.has(sid)) {
        warnings.push({
          type: "INVENTED_CITATION",
          detail: `Section "${section.title}" cites ${sid} which is not in the SourceIdMap.`,
          sourceId: sid,
        });
      }
    }
  }
  return warnings;
}

// Re-export quoted-text extractor for the quote firewall (§18).
export { extractQuotedText };
