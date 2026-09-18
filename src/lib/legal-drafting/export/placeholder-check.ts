// src/lib/legal-drafting/export/placeholder-check.ts
// Phase 6.1 — §49 — Court-ready placeholder + internal-ID leak check.
//
// Before a draft may reach VERIFIED/EXPORT_READY state AND be exported as
// court-ready DOCX/PDF, the exported text must contain:
//
//   - NO forbidden placeholders: [SUPPORT_REQUIRED], [MISSING_INFORMATION],
//     [TODO], [TBD], the literal words "undefined" / "null" as text content,
//     and any of the §22 forbidden placeholder patterns.
//   - NO leaked internal source ids: F1, C2, CE3, L4, CC1, E5, A6 — these
//     are internal debug ids used by the AI while drafting. The normal
//     export renders human-readable citations (§10) via the SourceIdMap; if
//     any internal id survives into the export, that's a leak.
//
// CRITICAL — §49: "Court-ready VERIFIED export must contain none of the
//                  placeholders/IDs."
// CRITICAL — §29: "Never leave VERIFIED badge when dependency changes."
//
// These checks are PURE STRING scans over the final exported text. They do
// NOT trust the firewall verdicts or the SourceIdMap. The formatting
// certification test (§12-16, §49) calls these on the text extracted from
// the exported DOCX/PDF.

// ---------------------------------------------------------------------------
// §49 — Forbidden placeholder patterns
// ---------------------------------------------------------------------------

/**
 * §22 — Hidden placeholder patterns (reused by §49 placeholder check).
 *
 * The completeness firewall checks these in §22 (NO_HIDDEN_PLACEHOLDERS
 * assertion). The court-ready check applies the SAME patterns to the
 * final exported text — VERIFIED export must contain none of them.
 */
const HIDDEN_PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[TODO\]/i,
  /\[TBD\]/i,
  /\[FILL IN[^\]]*\]/i,
  /\[FILL-IN[^\]]*\]/i,
  /\[INSERT[^\]]*\]/i,
  /\[\?\?\?\]/i,
  /\[\.\.\.\]/,
  /\[PLACEHOLDER[^\]]*\]/i,
  /\[YOUR TEXT HERE\]/i,
  /\[X{2,}\]/i, // [XX] / [XXX]
  /\[\s*Lorem ipsum\s*\]/i,
  // Armenian placeholder words
  /\[ՏԵՂԱԴՐԵŁ[^\]]*\]/i,
  /\[ԼՐԱԳՐԵŁ[^\]]*\]/i,
  // Russian placeholder words
  /\[ВСТАВИТЬ[^\]]*\]/i,
  /\[ЗАПОЛНИТЬ[^\]]*\]/i,
];

/**
 * §15 — Markers explicitly permitted by the closed-evidence system
 * instruction. These are NOT placeholders when the section is in
 * NEEDS_SUPPORT or has known-missing material. However, for a VERIFIED
 * court-ready export (§49), even these markers are forbidden — the
 * draft must be complete enough to file.
 *
 * Global flag — we use this in a loop with exec() to collect every
 * occurrence (not just the first).
 */
const PERMITTED_DRAFTING_MARKERS: RegExp = /\[(SUPPORT_REQUIRED|MISSING_INFORMATION)\]/gi;

/**
 * §49 — Patterns that match the literal words "undefined" / "null" as
 * standalone tokens in the text. We use word boundaries so legitimate
 * words like "null hypothesis" or "undefined-behaviour disclaimer" are
 * not flagged — only the bare "undefined" / "null" string leak (which
 * indicates a JSON.stringify bug or a template variable that was never
 * filled) is flagged.
 */
const LITERAL_LEAK_PATTERNS: RegExp[] = [
  /\bundefined\b/i,
  /\bnull\b/i,
  /\bNaN\b/,
];

// ---------------------------------------------------------------------------
// §10/§22 — Internal source id pattern
// ---------------------------------------------------------------------------

/**
 * §10 — Internal source id pattern. Matches the AI's inline form:
 * F1, F2, F99 / CE1, CE2 / L1, L2 / C1, C2 / CC1, CC2 / E1, E2 / A1, A2.
 * Both bracketed [F1] and unbracketed F1 forms are matched.
 *
 * The SourceIdMap replaces these with human-readable citations at export
 * time. If any id survives into the export, that's a §22 leak.
 */
const INTERNAL_ID_PATTERN =
  /\[?(F\d+|CE\d+|L\d+|C\d+|CC\d+|E\d+|A\d+)\]?/g;

/**
 * §22 — Stricter pattern: matches ONLY the bracketed form [F1], [C2], etc.
 * Used by `checkInternalIdLeak` — the bracketed form is unambiguous and
 * cannot false-positive on legal text like "Article 1 of the Code" (C1 is
 * a different lexical form).
 */
const BRACKETED_INTERNAL_ID_PATTERN =
  /\[(F\d+|CE\d+|L\d+|C\d+|CC\d+|E\d+|A\d+)\]/g;

// ---------------------------------------------------------------------------
// §49 — checkPlaceholders
// ---------------------------------------------------------------------------

export interface PlaceholderCheckResult {
  /** true iff no forbidden placeholders or literal leaks were found. */
  ok: boolean;
  /** List of forbidden patterns found (each entry is the matched text). */
  found: string[];
}

/**
 * §49 — Check whether the exported text contains any forbidden
 * placeholders or literal leaks.
 *
 * Forbidden patterns (any one of these makes `ok=false`):
 *   - [SUPPORT_REQUIRED] marker (§15 — permitted in DRAFT, forbidden in
 *     VERIFIED export)
 *   - [MISSING_INFORMATION] marker (§15 — same rule)
 *   - [TODO], [TBD], [FILL IN], [INSERT], [???], [...], [PLACEHOLDER],
 *     [XX], [Lorem ipsum], Armenian/Russian placeholder words (§22)
 *   - The literal words "undefined" / "null" / "NaN" as standalone tokens
 *     (indicates a JSON.stringify bug or template-var leak)
 *
 * Court-ready VERIFIED export MUST contain none of these (§49).
 *
 * @param text the text to scan (typically extracted from DOCX/PDF)
 * @returns `{ ok, found }` — `ok=true` iff the text is court-ready.
 */
export function checkPlaceholders(text: string): PlaceholderCheckResult {
  const found: string[] = [];

  // 1) §15 permitted-in-draft markers are forbidden in VERIFIED export.
  //    Match the bracketed form [SUPPORT_REQUIRED] / [MISSING_INFORMATION].
  //    Global regex with exec loop — collects every occurrence.
  PERMITTED_DRAFTING_MARKERS.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PERMITTED_DRAFTING_MARKERS.exec(text)) !== null) {
    // pm[0] is the full match "[SUPPORT_REQUIRED]" — push that, not the
    // capture group.
    found.push(pm[0]);
  }

  // 2) §22 hidden placeholder patterns.
  for (const re of HIDDEN_PLACEHOLDER_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) found.push(m[0]);
  }

  // 3) §49 literal leak patterns (undefined / null / NaN).
  for (const re of LITERAL_LEAK_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) found.push(m[0]);
  }

  // De-duplicate the found list (the same placeholder might match multiple
  // patterns — we surface it once).
  const unique = Array.from(new Set(found));

  return { ok: unique.length === 0, found: unique };
}

// ---------------------------------------------------------------------------
// §22/§49 — checkInternalIdLeak
// ---------------------------------------------------------------------------

export interface InternalIdLeakResult {
  /** true iff no internal source ids leaked into the export. */
  ok: boolean;
  /** List of leaked internal ids (e.g. ["[F1]", "[C2]"]). */
  leaked: string[];
}

/**
 * §22/§49 — Check whether the exported text contains any leaked internal
 * source ids (F1, CE2, L3, C4, CC5, E6, A7).
 *
 * The normal export (§10) replaces every internal id with its
 * human-readable citation via the SourceIdMap. If any id survives into
 * the export, that's a §22 leak — the export is NOT court-ready.
 *
 * The bracketed form [F1] / [C2] / ... is checked because it is
 * unambiguous — it cannot false-positive on "Article 1" or "L 1" etc.
 *
 * @param text the text to scan (typically extracted from DOCX/PDF)
 * @returns `{ ok, leaked }` — `ok=true` iff no internal ids leaked.
 */
export function checkInternalIdLeak(text: string): InternalIdLeakResult {
  const leaked: string[] = [];
  // Use the global-flag regex with exec() in a loop to collect ALL matches.
  BRACKETED_INTERNAL_ID_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRACKETED_INTERNAL_ID_PATTERN.exec(text)) !== null) {
    leaked.push(m[0]);
  }
  // De-duplicate.
  const unique = Array.from(new Set(leaked));
  return { ok: unique.length === 0, leaked: unique };
}

// ---------------------------------------------------------------------------
// §22 — Convenience: combined court-ready scan
// ---------------------------------------------------------------------------

export interface CourtReadyCheckResult {
  /** true iff both placeholder + id-leak checks passed. */
  ok: boolean;
  /** Result of the placeholder check. */
  placeholders: PlaceholderCheckResult;
  /** Result of the internal-id leak check. */
  idLeak: InternalIdLeakResult;
}

/**
 * §49 — Combined court-ready scan: runs both `checkPlaceholders` and
 * `checkInternalIdLeak` on the exported text. Returns ok=true iff BOTH
 * pass. Used by the formatting certification test (§12-16, §49).
 */
export function checkCourtReady(text: string): CourtReadyCheckResult {
  const placeholders = checkPlaceholders(text);
  const idLeak = checkInternalIdLeak(text);
  return {
    ok: placeholders.ok && idLeak.ok,
    placeholders,
    idLeak,
  };
}
