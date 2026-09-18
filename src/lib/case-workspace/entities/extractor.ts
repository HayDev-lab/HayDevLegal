// src/lib/case-workspace/entities/extractor.ts
//
// §9 — Entity extractor. Detects people / companies / courts / roles in
// document text. Conservative: when uncertain, type=OTHER. Do NOT merge fuzzy
// names (§9 — keep uncertain matches separate; use role/organization/context/
// identifiers, not fuzzy name alone).
//
// Detection is rule-based + dictionary-driven. No LLM hallucination.
//
// Word-boundary handling: JavaScript's `\b` does NOT recognize Armenian /
// Cyrillic letters as word chars, so we use Unicode property escapes
// `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])` to mark boundaries.

import type { EntityType, EvidenceRef } from "../analysis-types";

export type EntityLanguage = "hy" | "ru" | "en" | "auto";

export interface EntityCandidate {
  surface: string;
  type: EntityType;
  context: string;
  evidenceRef: EvidenceRef;
}

const CONTEXT_CHARS = 80;

// ---------------------------------------------------------------------------
// Role keywords (Armenian / Russian / English).
// When found adjacent to a capitalized sequence, the entity is tagged with
// the corresponding role and an EntityType hint is applied.
// ---------------------------------------------------------------------------

interface RoleDef {
  role: string;
  entityHint: EntityType;
  keywords: string[];
}

const ROLES: RoleDef[] = [
  // Armenian
  { role: "դատավոր", entityHint: "PERSON", keywords: ["դատավոր"] },
  { role: "դատախազ", entityHint: "PROSECUTOR", keywords: ["դատախազ"] },
  { role: "փաստաբան", entityHint: "LAWYER", keywords: ["փաստաբան"] },
  { role: "քննիչ", entityHint: "INVESTIGATOR", keywords: ["քննիչ"] },
  { role: "փորձագետ", entityHint: "EXPERT", keywords: ["փորձագետ"] },
  { role: "կասկածյալ", entityHint: "PERSON", keywords: ["կասկածյալ"] },
  { role: "մեղադրյալ", entityHint: "PERSON", keywords: ["մեղադրյալ"] },
  { role: "վկա", entityHint: "PERSON", keywords: ["վկա"] },
  { role: "տուժող", entityHint: "PERSON", keywords: ["տուժող"] },
  // Russian
  { role: "судья", entityHint: "PERSON", keywords: ["судья"] },
  { role: "прокурор", entityHint: "PROSECUTOR", keywords: ["прокурор"] },
  { role: "адвокат", entityHint: "LAWYER", keywords: ["адвокат"] },
  { role: "следователь", entityHint: "INVESTIGATOR", keywords: ["следователь"] },
  { role: "эксперт", entityHint: "EXPERT", keywords: ["эксперт"] },
  { role: "подозреваемый", entityHint: "PERSON", keywords: ["подозреваемый"] },
  { role: "обвиняемый", entityHint: "PERSON", keywords: ["обвиняемый"] },
  { role: "свидетель", entityHint: "PERSON", keywords: ["свидетель"] },
  { role: "потерпевший", entityHint: "PERSON", keywords: ["потерпевший"] },
  // English
  { role: "judge", entityHint: "PERSON", keywords: ["judge"] },
  { role: "prosecutor", entityHint: "PROSECUTOR", keywords: ["prosecutor"] },
  { role: "lawyer", entityHint: "LAWYER", keywords: ["lawyer"] },
  { role: "attorney", entityHint: "LAWYER", keywords: ["attorney"] },
  { role: "investigator", entityHint: "INVESTIGATOR", keywords: ["investigator"] },
  { role: "expert", entityHint: "EXPERT", keywords: ["expert"] },
  { role: "suspect", entityHint: "PERSON", keywords: ["suspect"] },
  { role: "defendant", entityHint: "PERSON", keywords: ["defendant"] },
  { role: "witness", entityHint: "PERSON", keywords: ["witness"] },
  { role: "victim", entityHint: "PERSON", keywords: ["victim"] },
];

const ROLE_KEYWORDS_LOWER = new Set(
  ROLES.flatMap((r) => r.keywords.map((k) => k.toLowerCase()))
);

// ---------------------------------------------------------------------------
// Court name dictionaries. Armenian + Russian + English canonical court
// names → ENTITY_TYPE=COURT.
// ---------------------------------------------------------------------------

const COURT_KEYWORDS: string[] = [
  // Armenian
  "Վճռաբեկ դատարան",
  "Վճռաբեկ",
  "Քրեական դատարան",
  "Քաղաքացիական դատարան",
  "Վարչական դատարան",
  "Առաջին ատյանի դատարան",
  "Վերաքննիչ դատարան",
  "Սահմանադրական դատարան",
  "դատարան",
  // Russian
  "Кассационный суд",
  "Кассационный",
  "Уголовный суд",
  "Гражданский суд",
  "Административный суд",
  "Первой инстанции суд",
  "Апелляционный суд",
  "Конституционный суд",
  "суд",
  // English
  "cassation court",
  "criminal court",
  "civil court",
  "administrative court",
  "first instance court",
  "appeals court",
  "constitutional court",
  "court",
];

// Sort court keywords by length descending so we match longer phrases first
// (e.g. "Քրեական դատարան" before "դատարան").
const COURT_KEYWORDS_SORTED = [...COURT_KEYWORDS].sort(
  (a, b) => b.length - a.length
);

// ---------------------------------------------------------------------------
// Company suffixes (LLC / LLP / Inc / ООО / ՍՊ Ընկերություն / ՓԲԸ / ԲԸ).
// When a capitalized sequence ends with one of these, mark as COMPANY.
// ---------------------------------------------------------------------------

const COMPANY_SUFFIXES: string[] = [
  // Armenian
  "ՍՊ Ընկերություն",
  "ՍՊ Ընկ",
  "ՓԲԸ",
  "ԲԸ",
  "Ընկերություն",
  // Russian
  "ООО",
  "ОАО",
  "ЗАО",
  "ПАО",
  "ИП",
  // English
  "LLC",
  "LLP",
  "Inc",
  "Corp",
  "Ltd",
  "GmbH",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildContext(text: string, start: number, end: number): string {
  const ctxStart = Math.max(0, start - CONTEXT_CHARS);
  const ctxEnd = Math.min(text.length, end + CONTEXT_CHARS);
  const prefix = ctxStart > 0 ? "…" : "";
  const suffix = ctxEnd < text.length ? "…" : "";
  return (
    prefix + text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() + suffix
  );
}

// Token chars: Armenian (Ա-ֆ + և), Cyrillic (А-я + Ёё), Latin (A-z + '), and hyphen.
const NAME_TOKEN_CHARS =
  "[\\u0531-\\u0587\\u0400-\\u04FFA-Za-zА-Яа-яЁё'\\-]";
// Word-boundary regex using Unicode property escapes (so Armenian / Cyrillic
// letters are recognized as word chars).
const NAME_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])${NAME_TOKEN_CHARS}{2,}(?:\\s+${NAME_TOKEN_CHARS}{2,}){0,2}(?![\\p{L}\\p{N}])`,
  "gu"
);

function isUpperFirst(s: string): boolean {
  if (!s) return false;
  const c = s.codePointAt(0) ?? 0;
  return (
    (c >= 0x0531 && c <= 0x0556) || // Armenian capital
    (c >= 0x0410 && c <= 0x042f) || // Cyrillic capital A-Я
    (c >= 0x41 && c <= 0x5a) // Latin A-Z
  );
}

function allTokensCapitalized(surface: string): boolean {
  const tokens = surface.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every(isUpperFirst);
}

function matchesCompany(surface: string): boolean {
  for (const sfx of COMPANY_SUFFIXES) {
    if (surface.endsWith(sfx)) return true;
  }
  return false;
}

// Does the surface itself START with one of the court keywords (case-insensitive)?
function surfaceIsCourt(surface: string): boolean {
  const lower = surface.toLowerCase();
  for (const k of COURT_KEYWORDS) {
    if (lower.startsWith(k.toLowerCase())) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Is the role keyword ADJACENT to the candidate (within ~10 chars AND no
// sentence-ending punctuation between role and surface)?
function lookupRoleAdjacent(
  text: string,
  start: number
): RoleDef | undefined {
  // Look back up to ~15 chars before `start` for a role keyword that's
  // immediately followed by whitespace + the surface (no sentence-ending
  // punctuation in between).
  const windowStart = Math.max(0, start - 15);
  const window = text.slice(windowStart, start);
  // Sentence enders: . ։ ! ?
  const sentenceEndMatch = window.match(/[.!?\u0589]\s*$/);
  if (sentenceEndMatch) return undefined;
  for (const r of ROLES) {
    for (const kw of r.keywords) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegex(kw)}(?![\\p{L}\\p{N}])`,
        "iu"
      );
      if (re.test(window)) return r;
    }
  }
  return undefined;
}

// Strip a leading role keyword (e.g. "Դատավոր ") from the captured surface
// so the entity name is just the person, not the role+name combo.
function stemArmenian(token: string): string {
  // Strip trailing Armenian definite articles / plural markers / case suffixes.
  // Conservative — strip up to 3 trailing Armenian letters (handles ը/ն/ի/ին/վ etc.).
  const lower = token.toLowerCase();
  const re = /[\u0561-\u0587]$/u;
  let s = lower;
  for (let i = 0; i < 3; i++) {
    if (!re.test(s)) break;
    s = s.slice(0, -1);
  }
  return s;
}

function detectLeadingRole(surface: string): RoleDef | undefined {
  const trimmed = surface.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  const firstLower = tokens[0].toLowerCase();
  if (ROLE_KEYWORDS_LOWER.has(firstLower)) {
    return ROLES.find((r) =>
      r.keywords.some((k) => k.toLowerCase() === firstLower)
    );
  }
  // Try stem form (strip Armenian suffixes from the first token).
  const stem = stemArmenian(firstLower);
  for (const r of ROLES) {
    for (const kw of r.keywords) {
      if (stem === kw.toLowerCase()) return r;
    }
  }
  return undefined;
}

function stripLeadingRole(surface: string): string {
  const trimmed = surface.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return trimmed;
  const firstLower = tokens[0].toLowerCase();
  if (ROLE_KEYWORDS_LOWER.has(firstLower)) {
    return tokens.slice(1).join(" ");
  }
  // Try stem form.
  const stem = stemArmenian(firstLower);
  const isRoleStem = ROLES.some((r) =>
    r.keywords.some((k) => k.toLowerCase() === stem)
  );
  if (isRoleStem) {
    return tokens.slice(1).join(" ");
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------

export function extractEntities(
  text: string,
  language: EntityLanguage = "auto"
): EntityCandidate[] {
  if (!text || typeof text !== "string") return [];
  void language; // detection is script-agnostic via Unicode classes.
  const out: EntityCandidate[] = [];
  // Track captured spans (start,end) to avoid double-tagging.
  const capturedSpans: Array<{ start: number; end: number }> = [];

  const overlaps = (start: number, end: number) =>
    capturedSpans.some((s) => start < s.end && end > s.start);

  // 1. Court name pass — match longest court names first.
  // Use a soft trailing boundary that allows up to 4 Armenian suffix letters
  // (definite article ը/ն, plural marker ներ, case suffixes) so that
  // "Քրեական դատարանը" and "դատարաններում" are captured.
  for (const courtName of COURT_KEYWORDS_SORTED) {
    if (!courtName) continue;
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegex(courtName)}[\\u0530-\\u0587]{0,4}(?![\\p{L}\\p{N}])`,
      "giu"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      capturedSpans.push({ start, end });
      out.push({
        surface: m[0],
        type: "COURT",
        context: buildContext(text, start, end),
        evidenceRef: {
          section: "court",
          quote: m[0],
        },
      });
    }
  }

  // 2. Company pass — capitalized sequence ending in a company suffix.
  NAME_PATTERN.lastIndex = 0;
  let mn: RegExpExecArray | null;
  while ((mn = NAME_PATTERN.exec(text)) !== null) {
    const surface = mn[0].trim();
    if (!surface) continue;
    if (matchesCompany(surface) && allTokensCapitalized(surface)) {
      const start = mn.index;
      const end = mn.index + mn[0].length;
      if (overlaps(start, end)) continue;
      capturedSpans.push({ start, end });
      out.push({
        surface,
        type: "COMPANY",
        context: buildContext(text, start, end),
        evidenceRef: { quote: surface },
      });
    }
  }

  // 3. Bare-name pass — capitalized Name Surname [Patronymic] sequences.
  //    - Require ALL tokens to start with an uppercase letter (filter out
  //      "ին Քրեական դատարանը" style captures that mix lowercase function
  //      words with capitalized words).
  //    - Skip surfaces that are courts or companies.
  //    - Only keep single-token surfaces when an adjacent role keyword is
  //      present.
  NAME_PATTERN.lastIndex = 0;
  while ((mn = NAME_PATTERN.exec(text)) !== null) {
    const surface = mn[0].trim();
    if (!surface) continue;
    if (!allTokensCapitalized(surface)) continue;
    if (matchesCompany(surface)) continue;
    if (surfaceIsCourt(surface)) continue;
    const tokenCount = surface.split(/\s+/).filter(Boolean).length;
    const role = lookupRoleAdjacent(text, mn.index);
    if (tokenCount < 2 && !role) continue;
    const start = mn.index;
    const end = mn.index + mn[0].length;
    if (overlaps(start, end)) continue;

    // Two role-detection paths:
    //   (a) lookupRoleAdjacent: role keyword appears IMMEDIATELY BEFORE the
    //       surface in the surrounding text.
    //   (b) detectLeadingRole: the surface itself starts with a role keyword
    //       (e.g. "Դատավոր Արամ Պողոսյանը") — strip the leading role and use
    //       the remainder as the entity name.
    const leadingRole = detectLeadingRole(surface);
    const effectiveRole = role ?? leadingRole;
    const finalSurface = effectiveRole ? stripLeadingRole(surface) : surface;
    if (finalSurface.split(/\s+/).filter(Boolean).length < 1) continue;
    if (!allTokensCapitalized(finalSurface)) continue;

    capturedSpans.push({ start, end });
    out.push({
      surface: finalSurface,
      type: effectiveRole?.entityHint ?? "PERSON",
      context: buildContext(text, start, end),
      evidenceRef: {
        quote: finalSurface,
        section: effectiveRole?.role,
      },
    });
  }

  return out;
}
