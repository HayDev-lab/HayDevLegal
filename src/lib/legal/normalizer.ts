// src/lib/legal/normalizer.ts
// Armenian-aware query normalization.
//
// Goals:
//  - canonicalize Armenian Unicode (NFC)
//  - collapse repeated whitespace & Armenian punctuation quirks
//  - normalize quotation marks, dashes
//  - normalize article notation ("հոդված 108", "108 հոդված", "հ.108", "հ-108")
//  - normalize digits (Armenian/Arabic -> ASCII)
//  - expand common legal abbreviations
//
// The ORIGINAL query is always preserved alongside the normalized form,
// so ranking can still match the user's literal phrasing.

import { expandAbbreviations, type AbbreviationEntry } from "./abbreviations";

const ARMENIAN_DIGITS: Record<string, string> = {
  "٠": "0", "۰": "0",
  "١": "1", "۱": "1",
  "٢": "2", "۲": "2",
  "٣": "3", "۳": "3",
  "٤": "4", "۴": "4",
  "٥": "5", "۵": "5",
  "٦": "6", "۶": "6",
  "٧": "7", "۷": "7",
  "٨": "8", "۸": "8",
  "٩": "9", "۹": "9",
};

const QUOTE_PAIRS: [string, string][] = [
  ["«", "\""],
  ["»", "\""],
  ["“", "\""],
  ["”", "\""],
  ["„", "\""],
  ["‟", "\""],
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
];

const DASH_VARIANTS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;

export type NormalizedQuery = {
  raw: string;
  normalized: string;
  matchedAbbreviations: AbbreviationEntry[];
};

/**
 * Normalize an Armenian legal query.
 * Returns the original raw string alongside the normalized form.
 */
export function normalizeQuery(raw: string): NormalizedQuery {
  if (!raw) {
    return { raw: "", normalized: "", matchedAbbreviations: [] };
  }

  let s = raw.normalize("NFC");

  // Normalize dashes to ASCII hyphen
  s = s.replace(DASH_VARIANTS, "-");

  // Normalize quotes
  for (const [from, to] of QUOTE_PAIRS) {
    s = s.split(from).join(to);
  }

  // Normalize digits
  s = s.replace(/[٠۰٤۴٥۵٦۶٧۷٨۸٩۹0-9]/g, (ch) => ARMENIAN_DIGITS[ch] ?? ch);

  // Normalize Armenian punctuation: ; → , (Armenian comma), : stays, ? stays
  s = s.replace(/\u0589/g, ";"); // ։ Armenian full stop -> ; (keep as separator)
  s = s.replace(/\u055D/g, ","); // ՝ Armenian comma -> ,
  s = s.replace(/\u055C/g, "'"); // ՚ Armenian apostrophe -> '
  s = s.replace(/\u055A/g, "'"); // ՚ second apostrophe
  s = s.replace(/\u055B/g, "\""); // ճ

  // Article notation normalization:
  //   "հոդված 108", "հ.108", "հ-108", "108 հոդված"  -> keep "հոդված 108"
  // We normalise "հ." / "հ-" prefix to "հոդված " when followed by digits.
  s = s.replace(/\bհ\.?\s*(\d)/giu, "հոդված $1");
  s = s.replace(/\bհ-(\d)/giu, "հոդված $1");

  // Collapse repeated whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Expand abbreviations
  const { expanded, matched } = expandAbbreviations(s);
  // collapse whitespace again post-expansion
  const normalized = expanded.replace(/\s+/g, " ").trim();

  return { raw, normalized, matchedAbbreviations: matched };
}

/**
 * Lightweight token splitter used by the ranker for keyword overlap.
 * Keeps Armenian letters and digits, drops pure punctuation.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  // \u0530-\u058F = Armenian block; also keep Latin letters and digits.
  const matches = text.toLowerCase().match(/[\u0530-\u058fa-z0-9]+/g);
  return matches ?? [];
}

/** Strip HTML tags from an ARLIS HTML fragment and collapse whitespace. */
export function stripHtml(html: string): string {
  if (!html) return "";
  // Remove script/style blocks first
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Replace <br>, </p>, </div>, </tr>, </li> with newline for readability
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop all remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "-");
  // Collapse whitespace per line, trim
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return s;
}
