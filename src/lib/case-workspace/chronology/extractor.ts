// src/lib/case-workspace/chronology/extractor.ts
//
// §8 — Chronology extractor. Recognizes Armenian / Russian / English date
// mentions in document text. Normalizes to ISO YYYY-MM-DD where possible.
//
// Correctness rules:
//  - PRESERVE original date text (never invent missing components).
//  - dateStatus: EXACT when day+month+year all parsed; INFERRED when partial
//    (e.g. only month/year or only year); UNKNOWN when format unrecognized.
//  - Context (~80 chars before/after the date mention) is captured to help
//    disambiguate the event referenced.
//  - Never hallucinate — return UNKNOWN rather than guessing.
//
// Note on regex flags: `\b` in JavaScript regex does NOT recognize Armenian
// or Cyrillic letters as word chars (even with `u` flag), so we use Unicode
// property escapes `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])` for boundaries.
// The `i` flag is added so capital Armenian / Cyrillic / Latin letters match
// the lowercase keyword patterns.

import type { DateStatus } from "../analysis-types";

export type DateLanguage = "hy" | "ru" | "en" | "auto";

export interface DateCandidate {
  original: string;
  normalized?: string;
  dateStatus: DateStatus;
  context?: string;
}

const CONTEXT_CHARS = 80;

// Boundary helpers using Unicode property escapes (so Armenian/Cyrillic/Latin
// letters are all recognized as word chars).
const LB = `(?<![\\p{L}\\p{N}])`;
const RB = `(?![\\p{L}\\p{N}])`;

// Armenian month names → 2-digit month. Accepts both -ի suffix and base form.
const ARM_MONTHS: Record<string, string> = {
  հունվար: "01",
  հունվարի: "01",
  փետրվար: "02",
  փետրվարի: "02",
  մարտ: "03",
  մարտի: "03",
  ապրիլ: "04",
  ապրիլի: "04",
  մայիս: "05",
  մայիսի: "05",
  հունիս: "06",
  հունիսի: "06",
  հուլիս: "07",
  հուլիսի: "07",
  օգոստոս: "08",
  օգոստոսի: "08",
  սեպտեմբեր: "09",
  սեպտեմբերի: "09",
  հոկտեմբեր: "10",
  հոկտեմբերի: "10",
  նոյեմբեր: "11",
  նոյեմբերի: "11",
  դեկտեմբեր: "12",
  դեկտեմբերի: "12",
};

const ARM_MONTH_PATTERN = Object.keys(ARM_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const RU_MONTHS: Record<string, string> = {
  января: "01",
  январь: "01",
  февраля: "02",
  февраль: "02",
  марта: "03",
  март: "03",
  апреля: "04",
  апрель: "04",
  мая: "05",
  май: "05",
  июня: "06",
  июнь: "06",
  июля: "07",
  июль: "07",
  августа: "08",
  август: "08",
  сентября: "09",
  сентябрь: "09",
  октября: "10",
  октябрь: "10",
  ноября: "11",
  ноябрь: "11",
  декабря: "12",
  декабрь: "12",
};

const RU_MONTH_PATTERN = Object.keys(RU_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const EN_MONTHS: Record<string, string> = {
  january: "01",
  jan: "01",
  february: "02",
  feb: "02",
  march: "03",
  mar: "03",
  april: "04",
  apr: "04",
  may: "05",
  june: "06",
  jun: "06",
  july: "07",
  jul: "07",
  august: "08",
  aug: "08",
  september: "09",
  sep: "09",
  sept: "09",
  october: "10",
  oct: "10",
  november: "11",
  nov: "11",
  december: "12",
  dec: "12",
};

const EN_MONTH_PATTERN = Object.keys(EN_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clampDay(year: number, month: number, day: number): number {
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  return Math.min(Math.max(day, 1), daysInMonth[month - 1] ?? 31);
}

function buildIso(year: number, month: number, day: number): string | undefined {
  if (year < 1900 || year > 2100) return undefined;
  if (month < 1 || month > 12) return undefined;
  const d = clampDay(year, month, day);
  return `${year}-${pad2(month)}-${pad2(d)}`;
}

function buildContext(text: string, start: number, end: number): string {
  const ctxStart = Math.max(0, start - CONTEXT_CHARS);
  const ctxEnd = Math.min(text.length, end + CONTEXT_CHARS);
  const prefix = ctxStart > 0 ? "…" : "";
  const suffix = ctxEnd < text.length ? "…" : "";
  return (
    prefix + text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() + suffix
  );
}

interface CompiledPattern {
  name: string;
  regex: RegExp;
  parse: (m: RegExpExecArray) => { iso?: string; dateStatus: DateStatus };
}

// All patterns use `iu` flags for case-insensitive Unicode-aware matching.
// Boundaries are expressed via Unicode property escapes (not `\b`).
const PATTERNS: CompiledPattern[] = [
  // ISO YYYY-MM-DD (also accepts YYYY/MM/DD).
  {
    name: "ISO",
    regex: new RegExp(`${LB}(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})${RB}`, "giu"),
    parse: (m) => {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const iso = buildIso(y, mo, d);
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY.
  {
    name: "DD.MM.YYYY",
    regex: new RegExp(`${LB}(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})${RB}`, "giu"),
    parse: (m) => {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const iso = buildIso(y, mo, d);
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // Armenian "15 հունվարի 2024" / "15 հունվարի 2024թ."
  {
    name: "HY-named",
    regex: new RegExp(
      `${LB}(\\d{1,2})\\s+(${ARM_MONTH_PATTERN})\\s*,?\\s*(\\d{4})թ?\\.?`,
      "giu"
    ),
    parse: (m) => {
      const d = parseInt(m[1], 10);
      const mo = ARM_MONTHS[m[2].toLowerCase()];
      const y = parseInt(m[3], 10);
      const iso = mo ? buildIso(y, parseInt(mo, 10), d) : undefined;
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // Armenian "2024թ. հունվարի 15" (year first, then month, then day)
  {
    name: "HY-yearfirst",
    regex: new RegExp(
      `${LB}(\\d{4})թ?\\.?\\s+(${ARM_MONTH_PATTERN})\\s+(\\d{1,2})`,
      "giu"
    ),
    parse: (m) => {
      const y = parseInt(m[1], 10);
      const mo = ARM_MONTHS[m[2].toLowerCase()];
      const d = parseInt(m[3], 10);
      const iso = mo ? buildIso(y, parseInt(mo, 10), d) : undefined;
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // Armenian "հունվարի 2024" (partial — no day) → INFERRED
  {
    name: "HY-month-year",
    regex: new RegExp(
      `${LB}(${ARM_MONTH_PATTERN})\\s*,?\\s*(\\d{4})թ?\\.?`,
      "giu"
    ),
    parse: (m) => {
      const mo = ARM_MONTHS[m[1].toLowerCase()];
      const y = parseInt(m[2], 10);
      if (!mo) return { dateStatus: "UNKNOWN" };
      if (y < 1900 || y > 2100) return { dateStatus: "UNKNOWN" };
      return { dateStatus: "INFERRED", iso: `${y}-${mo}` };
    },
  },
  // Russian "15 января 2024" / "15 января 2024 г."
  {
    name: "RU-named",
    regex: new RegExp(
      `${LB}(\\d{1,2})\\s+(${RU_MONTH_PATTERN})\\s+,?\\s*(\\d{4})\\s*г?\\.?`,
      "giu"
    ),
    parse: (m) => {
      const d = parseInt(m[1], 10);
      const mo = RU_MONTHS[m[2].toLowerCase()];
      const y = parseInt(m[3], 10);
      const iso = mo ? buildIso(y, parseInt(mo, 10), d) : undefined;
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // Russian "января 2024" (no day) → INFERRED
  {
    name: "RU-month-year",
    regex: new RegExp(
      `${LB}(${RU_MONTH_PATTERN})\\s+(\\d{4})\\s*г?\\.?`,
      "giu"
    ),
    parse: (m) => {
      const mo = RU_MONTHS[m[1].toLowerCase()];
      const y = parseInt(m[2], 10);
      if (!mo) return { dateStatus: "UNKNOWN" };
      if (y < 1900 || y > 2100) return { dateStatus: "UNKNOWN" };
      return { dateStatus: "INFERRED", iso: `${y}-${mo}` };
    },
  },
  // English "January 15, 2024" / "Jan. 15, 2024"
  {
    name: "EN-named-MDY",
    regex: new RegExp(
      `${LB}(${EN_MONTH_PATTERN})\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})`,
      "giu"
    ),
    parse: (m) => {
      const mo = EN_MONTHS[m[1].toLowerCase()];
      const d = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const iso = mo ? buildIso(y, parseInt(mo, 10), d) : undefined;
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // English "15 January 2024" / "15 Jan. 2024"
  {
    name: "EN-named-DMY",
    regex: new RegExp(
      `${LB}(\\d{1,2})\\s+(${EN_MONTH_PATTERN})\\.?\\s+(\\d{4})`,
      "giu"
    ),
    parse: (m) => {
      const d = parseInt(m[1], 10);
      const mo = EN_MONTHS[m[2].toLowerCase()];
      const y = parseInt(m[3], 10);
      const iso = mo ? buildIso(y, parseInt(mo, 10), d) : undefined;
      return { iso, dateStatus: iso ? "EXACT" : "UNKNOWN" };
    },
  },
  // English "January 2024" (no day) → INFERRED
  {
    name: "EN-month-year",
    regex: new RegExp(
      `${LB}(${EN_MONTH_PATTERN})\\.?\\s+(\\d{4})`,
      "giu"
    ),
    parse: (m) => {
      const mo = EN_MONTHS[m[1].toLowerCase()];
      const y = parseInt(m[2], 10);
      if (!mo) return { dateStatus: "UNKNOWN" };
      if (y < 1900 || y > 2100) return { dateStatus: "UNKNOWN" };
      return { dateStatus: "INFERRED", iso: `${y}-${mo}` };
    },
  },
];

// ----------------------------------------------------------------------------
// extractDateCandidates
// ----------------------------------------------------------------------------

/**
 * Detect language by counting Armenian / Cyrillic / Latin letters in the
 * text. When the dominant script is Armenian, default to "hy"; Cyrillic →
 * "ru"; otherwise → "en".
 */
function detectLanguage(text: string): "hy" | "ru" | "en" {
  let hy = 0;
  let ru = 0;
  let en = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0530 && c <= 0x058f) hy++;
    else if (c >= 0x0400 && c <= 0x04ff) ru++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) en++;
  }
  if (hy >= ru && hy >= en && hy > 0) return "hy";
  if (ru >= en && ru > 0) return "ru";
  return "en";
}

/**
 * §8 — Extract date candidates from text.
 */
export function extractDateCandidates(
  text: string,
  opts: { language?: DateLanguage } = {}
): DateCandidate[] {
  if (!text || typeof text !== "string") return [];
  const language: DateLanguage = opts.language ?? "auto";

  // For "auto" detection (the default), we still run all patterns. The
  // patterns are script-specific (Latin month names won't false-trigger on
  // Armenian text, etc.).
  void language;

  // Collect (startIdx, candidate) tuples so we can dedupe overlapping matches.
  type Hit = { start: number; end: number; candidate: DateCandidate };
  const hits: Hit[] = [];

  for (const pat of PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      const { iso, dateStatus } = pat.parse(m);
      if (!iso && dateStatus === "UNKNOWN") {
        // Skip — don't emit a candidate when parsing produced no useful signal.
        if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = m.index + m[0].length;
      hits.push({
        start,
        end,
        candidate: {
          original: m[0],
          normalized: iso,
          dateStatus,
          context: buildContext(text, start, end),
        },
      });
      if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;
    }
  }

  // Dedupe overlapping hits — keep the stronger (EXACT > INFERRED).
  hits.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - a.start));
  const kept: Hit[] = [];
  for (const h of hits) {
    const last = kept[kept.length - 1];
    if (last && h.start < last.end) {
      // Overlap — keep the one with stronger status (EXACT > INFERRED).
      const stronger =
        strength(h.candidate.dateStatus) >= strength(last.candidate.dateStatus)
          ? h
          : last;
      if (stronger === h) kept[kept.length - 1] = h;
      continue;
    }
    kept.push(h);
  }

  return kept.map((h) => h.candidate);
}

function strength(s: DateStatus): number {
  return s === "EXACT" ? 2 : s === "INFERRED" ? 1 : 0;
}

// Re-export normalizeDate from normalizer for convenience.
export { normalizeDate } from "./normalizer";
