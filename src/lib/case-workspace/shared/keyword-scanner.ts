// src/lib/case-workspace/shared/keyword-scanner.ts
//
// Shared helper for case-insensitive, Unicode-aware keyword scanning across
// Armenian / Russian / English text. JavaScript's String.prototype.indexOf
// is case-sensitive and ignores word boundaries — this scanner wraps regex
// matching with Unicode property escapes so that Armenian / Cyrillic letters
// are properly recognized.

export interface KeywordHit {
  /** Start index in the original text (inclusive). */
  start: number;
  /** End index in the original text (exclusive). */
  end: number;
  /** The actual matched text (preserves original case). */
  match: string;
  /** The keyword that matched (lowercased). */
  keyword: string;
}

export interface ScanOptions {
  /**
   * When true, allow up to 4 trailing Armenian letters (definite article,
   * plural marker, grammatical case suffixes) after the keyword stem.
   * Useful for Armenian inflectional morphology (e.g. "դատարանը", "ձերբակալությունն").
   */
  allowArmenianSuffix?: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Consume up to 4 trailing Armenian letters (small + capital + ligature և).
const ARM_SUFFIX = `[\\u0530-\\u0587]{0,4}`;

/**
 * Scan text for any of the provided keywords (case-insensitive, Unicode-aware,
 * word-boundary guarded). Returns hits in source order.
 */
export function scanKeywords(
  text: string,
  keywords: string[],
  opts: ScanOptions = {}
): KeywordHit[] {
  if (!text || keywords.length === 0) return [];
  const hits: KeywordHit[] = [];
  const seen = new Set<number>(); // dedupe by start index

  for (const kw of keywords) {
    if (!kw) continue;
    const suffixPart = opts.allowArmenianSuffix ? ARM_SUFFIX : "";
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegex(kw)}${suffixPart}(?![\\p{L}\\p{N}])`,
      "giu"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (seen.has(start)) continue;
      seen.add(start);
      hits.push({ start, end, match: m[0], keyword: kw.toLowerCase() });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  hits.sort((a, b) => a.start - b.start);
  return hits;
}
