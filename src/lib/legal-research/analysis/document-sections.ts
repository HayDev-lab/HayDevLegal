// src/lib/legal-research/analysis/document-sections.ts
// Section-aware document splitting (master prompt §14).
//
// Armenian court decisions and ECtHR judgments follow recurring section
// structures. Splitting the text lets the holding extractor use ONLY
// court-reasoning sections and never party submissions (§13 — party claims
// must never be recorded as court holdings).
//
// CRITICAL: heading patterns are ANCHORED to the whole line
// (^...$ with optional numbering prefix / trailing punctuation). A bare
// substring match would misread running text — real decisions routinely
// contain "դատարանը եզրակացրել է…" mid-sentence, which must NEVER be
// treated as a CONCLUSION heading.

import type { CourtSection, CourtSectionKind } from "../types";

interface SectionPattern {
  kind: CourtSectionKind;
  /** Alternatives of the heading text (matched as full lines). */
  heading: RegExp;
}

/**
 * Wrap heading alternatives into a full-line anchored regex:
 *   ^(?:[numbering])?(?:ALT1|ALT2|...)[trailing punct]?$
 */
function fullLine(alternatives: string): RegExp {
  return new RegExp(`^(?:[A-Z0-9IVX]{1,4}[.)]\\s*)?(?:${alternatives})\\s*[։.:;]?\\s*$`, "i");
}

/** Armenian court decision structure (§14). */
const ARM_PATTERNS: SectionPattern[] = [
  {
    kind: "FACTS",
    heading: fullLine("ՀԱՍՏԱՏՎԱԾ\\s+ՀԱՆԳԱՄԱՆՔՆԵՐ|ՀԱՆԳԱՄԱՆՔՆԵՐ|ԻՐԱՎԱԿԱՆ ՀԱՆԳԱՄԱՆՔՆԵՐ|ՓԱՍՏԱԿԱՆ ՀԱՆԳԱՄԱՆՔՆԵՐ|ԳՈՐԾԻ ՀԱՆԳԱՄԱՆՔՆԵՐ"),
  },
  {
    kind: "PARTY_SUBMISSIONS",
    heading: fullLine(
      "ԿՈՂՄԵՐԻ ԴԻՐՔՈՐՈՇՈՒՄ|ԿՈՂՄԵՐԻ ԴԻՐՔԵՐԸ|ԿՈՂՄԵՐԻ ԲԱՑԱՏՐՈՒԹՅՈՒՆՆԵՐԸ|ՄԵՂԱԴՐԱՆՔ|ՊԱՇՏՊԱՆԻ ԴԻՐՔԸ|ՄԵՂԱԴՐՈՂԻ ԴԻՐՔԸ|ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՄԱՍՆԱԿԻՑՆԵՐԻ ԴԻՐՔԵՐԸ",
    ),
  },
  {
    kind: "LEGAL_FRAMEWORK",
    heading: fullLine("ԻՐԱՎԱԿԱՆ ՀԻՄՔԵՐ|ԻՐԱՎԱԿԱՆ ԿԱՐԳԱՎՈՐՈՒՄ|ԿԱՐԳԱՎՈՐՈՒՄ"),
  },
  {
    kind: "COURT_ANALYSIS",
    heading: fullLine(
      "ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ|ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ|ԴԱՏԱՐԱՆԻ ԵԶՐԱԿԱՑՈՒԹՅՈՒՆ|ԴԱՏԱՐԱՆԻ ԳՆԱՀԱՏԱԿԱՆԸ|ԴԱՏԱՐԱՆԻ ԴԻՐՔԸ",
    ),
  },
  {
    kind: "CONCLUSION",
    heading: fullLine("ԵԶՐԱԿԱՑՈՒԹՅՈՒՆ|ԱՄՓՈՓՈՒՄ"),
  },
  {
    kind: "OPERATIVE_PART",
    heading: fullLine("ՈՐՈՇՈՒՄ|ՎՃՌԱՅԻՆ ՄԱՍԸ|ԿԱՅԱՑՐԵԼ Է"),
  },
];

/** ECtHR judgment structure (§14). */
const ECHR_PATTERNS: SectionPattern[] = [
  { kind: "FACTS", heading: fullLine("THE FACTS|ALLEGED FACTS|STATEMENT OF FACTS") },
  {
    kind: "PARTY_SUBMISSIONS",
    heading: fullLine(
      "(?:THE\\s+)?APPLICANT'?S\\s+SUBMISSIONS|(?:THE\\s+)?GOVERNMENT'?S\\s+SUBMISSIONS|SUBMISSIONS\\s+OF\\s+THE\\s+PARTIES|THE\\s+PARTIES'?\\s+SUBMISSIONS",
    ),
  },
  {
    kind: "LEGAL_FRAMEWORK",
    heading: fullLine(
      "RELEVANT\\s+LEGAL\\s+FRAMEWORK|RELEVANT\\s+DOMESTIC\\s+LAW(?:\\s+AND\\s+PRACTICE)?|RELEVANT\\s+INTERNATIONAL\\s+(?:LAW|MATERIAL)",
    ),
  },
  {
    kind: "COURT_ANALYSIS",
    heading: fullLine("THE\\s+LAW|THE\\s+COURT'?S\\s+ASSESSMENT|ASSESSMENT|THE\\s+COURT'?S\\s+EXAMINATION|THE\\s+COURT'?S\\s+OBSERVATIONS"),
  },
  { kind: "CONCLUSION", heading: fullLine("CONCLUSION|CONCLUSIONS") },
  { kind: "OPERATIVE_PART", heading: fullLine("OPERATIVE|OPERATIVE\\s+PART|DECIDES") },
];

/**
 * Split a court document into sections. Headings are matched on their own
 * line (ALL-CAPS or Title Case typical of judgments). Unmatched text before
 * the first heading lands in an UNKNOWN section.
 */
export function splitCourtSections(text: string, isEchr: boolean): CourtSection[] {
  const patterns = isEchr ? ECHR_PATTERNS : ARM_PATTERNS;
  const lines = text.split(/\n+/);

  const sections: CourtSection[] = [];
  let current: CourtSection = { kind: "UNKNOWN", title: "", text: "" };

  for (const line of lines) {
    const trimmed = line.trim();
    const matched = matchHeading(trimmed, patterns);
    if (matched) {
      if (current.text.trim()) sections.push(current);
      current = { kind: matched.kind, title: trimmed.slice(0, 120), text: "" };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) sections.push(current);

  return sections.map((s) => ({ ...s, text: s.text.trim() }));
}

function matchHeading(line: string, patterns: SectionPattern[]): SectionPattern | null {
  if (!line || line.length > 120) return null;
  for (const p of patterns) {
    if (p.heading.test(line)) return p;
  }
  return null;
}

/**
 * §13 — sections a holding may legally be extracted from: the court's own
 * analysis / conclusion / operative part / legal framework.
 */
const HOLDING_ALLOWED: CourtSectionKind[] = [
  "COURT_ANALYSIS",
  "CONCLUSION",
  "OPERATIVE_PART",
  "LEGAL_FRAMEWORK",
];

/** Sections that only describe facts or party positions. */
const HOLDING_FORBIDDEN: CourtSectionKind[] = ["PARTY_SUBMISSIONS"];

export function holdingEligibleText(sections: CourtSection[]): string {
  return sections
    .filter((s) => HOLDING_ALLOWED.includes(s.kind))
    .map((s) => s.text)
    .join("\n")
    .trim();
}

export function hasPartySubmissionSections(sections: CourtSection[]): boolean {
  return sections.some((s) => HOLDING_FORBIDDEN.includes(s.kind));
}

/** §13 — verbatim texts of party-submission sections (holding quarantine). */
export function partySubmissionTexts(sections: CourtSection[]): string[] {
  return sections.filter((s) => HOLDING_FORBIDDEN.includes(s.kind)).map((s) => s.text);
}

/**
 * Quote-offset mapping: find where a quote sits relative to the whole text,
 * and report whether that region is inside a forbidden section.
 */
export function quoteInForbiddenSection(
  sections: CourtSection[],
  quote: string,
): boolean {
  const norm = quote.replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm) return false;
  for (const s of sections) {
    if (HOLDING_FORBIDDEN.includes(s.kind) && s.text.toLowerCase().includes(norm)) {
      return true;
    }
  }
  return false;
}
