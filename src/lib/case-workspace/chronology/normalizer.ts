// src/lib/case-workspace/chronology/normalizer.ts
//
// §8 — Date normalizer. Parses a date mention and returns ISO + dateStatus.
// NEVER throws — failure returns { dateStatus: "UNKNOWN" }.
//
// Supported inputs (Armenian / Russian / English):
//   ISO:        "2024-01-15"                 → "2024-01-15" / EXACT
//   Numeric:    "15.01.2024" "15/01/2024"    → "2024-01-15" / EXACT
//   Armenian:  "հունվարի 15, 2024"            → "2024-01-15" / EXACT
//               "2024թ. հունվարի 15"           → "2024-01-15" / EXACT
//               "հունվարի 2024"               → "2024-01"   / INFERRED
//               "2024թ."                       → "2024"     / INFERRED
//   Russian:   "15 января 2024"              → "2024-01-15" / EXACT
//               "января 2024"                  → "2024-01"   / INFERRED
//   English:   "January 15, 2024"            → "2024-01-15" / EXACT
//               "15 January 2024"             → "2024-01-15" / EXACT
//               "January 2024"                → "2024-01"   / INFERRED

import type { DateStatus } from "../analysis-types";

export type DateLanguage = "hy" | "ru" | "en" | "auto";

export interface NormalizeResult {
  iso?: string;
  dateStatus: DateStatus;
}

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

function lookupMonth(
  token: string
): string | undefined {
  const lower = token.toLowerCase().replace(/\.$/, "");
  return (
    ARM_MONTHS[lower] ??
    RU_MONTHS[lower] ??
    EN_MONTHS[lower]
  );
}

/**
 * §8 — Parse a date mention into { iso, dateStatus }.
 * Never throws. UNKNOWN when format unrecognized.
 */
export function normalizeDate(
  original: string,
  _language: DateLanguage = "auto"
): NormalizeResult {
  if (!original || typeof original !== "string") {
    return { dateStatus: "UNKNOWN" };
  }
  const s = original.trim();
  if (!s) return { dateStatus: "UNKNOWN" };

  // 1. ISO YYYY-MM-DD (or YYYY/MM/DD)
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const iso = buildIso(y, mo, d);
    if (iso) return { iso, dateStatus: "EXACT" };
  }

  // 2. Numeric DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    const iso = buildIso(y, mo, d);
    if (iso) return { iso, dateStatus: "EXACT" };
  }

  // 3. Armenian "2024թ. հունվարի 15" (year first)
  m = /^(\d{4})թ?\.?\s+([ա-ֆԱ-Ֆև?]+)/i.exec(s);
  // (the regex above can't reliably tokenize Armenian month — use lookupMonth
  // inside parse anyway). We instead try a few structural patterns below.

  // 3. Armenian year-first: "2024թ. հունվարի 15"
  m = /^(\d{4})թ?\.?\s+(\S+)\s+(\d{1,2})/.exec(s);
  if (m) {
    const y = parseInt(m[1], 10);
    const moStr = lookupMonth(m[2]);
    const d = parseInt(m[3], 10);
    if (moStr) {
      const iso = buildIso(y, parseInt(moStr, 10), d);
      if (iso) return { iso, dateStatus: "EXACT" };
    }
  }

  // 4. Armenian "հունվարի 15, 2024" (month first, then day, then year)
  m = /^(\S+)\s+(\d{1,2})\s*,?\s*(\d{4})թ?\.?$/.exec(s);
  if (m) {
    const moStr = lookupMonth(m[1]);
    if (moStr) {
      const d = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const iso = buildIso(y, parseInt(moStr, 10), d);
      if (iso) return { iso, dateStatus: "EXACT" };
    }
  }

  // 5. Russian/English "15 January 2024" / "15 января 2024" / "15 Jan. 2024"
  m = /^(\d{1,2})\s+(\S+)\s+(\d{4})\s*г?\.?$/.exec(s);
  if (m) {
    const d = parseInt(m[1], 10);
    const moStr = lookupMonth(m[2]);
    if (moStr) {
      const y = parseInt(m[3], 10);
      const iso = buildIso(y, parseInt(moStr, 10), d);
      if (iso) return { iso, dateStatus: "EXACT" };
    }
  }

  // 6. English "January 15, 2024" / "Jan. 15 2024"
  m = /^(\S+)\s+(\d{1,2})\s*,?\s*(\d{4})$/.exec(s);
  if (m) {
    const moStr = lookupMonth(m[1]);
    if (moStr) {
      const d = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      const iso = buildIso(y, parseInt(moStr, 10), d);
      if (iso) return { iso, dateStatus: "EXACT" };
    }
  }

  // 7. Partial "January 2024" / "հունվարի 2024" / "января 2024" → INFERRED
  m = /^(\S+)\s+(\d{4})թ?\.?\s*г?\.?$/.exec(s);
  if (m) {
    const moStr = lookupMonth(m[1]);
    if (moStr) {
      const y = parseInt(m[2], 10);
      if (y >= 1900 && y <= 2100) {
        return { iso: `${y}-${moStr}`, dateStatus: "INFERRED" };
      }
    }
  }

  // 8. Bare year "2024" / "2024թ." / "2024 г."
  m = /^(\d{4})թ?\.?\s*г?\.?$/.exec(s);
  if (m) {
    const y = parseInt(m[1], 10);
    if (y >= 1900 && y <= 2100) {
      return { iso: `${y}`, dateStatus: "INFERRED" };
    }
  }

  // 9. Couldn't parse — UNKNOWN, never throw.
  return { dateStatus: "UNKNOWN" };
}
