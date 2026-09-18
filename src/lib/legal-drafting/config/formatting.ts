// src/lib/legal-drafting/config/formatting.ts
// Phase 6.1 — §11 — Centralized court-ready formatting configuration.
//
// All court-ready formatting magic numbers live here. Export code (docx.ts,
// pdf.ts) and the formatting certification tests (§12-16, §49) read from this
// module — they do NOT scatter their own font sizes, margins, or page-break
// heuristics. This is critical so that:
//
//   1. A change to "the standard Armenian filing margin" propagates to every
//      export format and every test in one place.
//   2. There is no possibility of DOCX and PDF disagreeing about page size,
//      font, or signature block format.
//   3. The §11 rule "Do not pretend a statutory formatting rule exists unless
//      verified" is honored: every constant here is annotated with WHY it has
//      that value (typical Armenian legal filing practice, not a fake legal
//      citation).
//
// §11 CRITICAL: "Do not pretend a statutory formatting rule exists unless
//                verified — use reasonable values, not fake legal citations."
//
// §19 CRITICAL: "Do NOT share font files" — we use SYSTEM-AVAILABLE fonts
//                only (DejaVuSans ships with most Linux distributions and
//                supports the Armenian Unicode block U+0530–U+058F). The
//                export code locates the font at runtime via
//                `findUnicodeFont()` below; if no font file is found, the
//                export degrades gracefully (Latin-only) and the formatting
//                certification test surfaces that as a failure.

// ---------------------------------------------------------------------------
// §11 — Page geometry
// ---------------------------------------------------------------------------

/**
 * Page size for court-ready export. A4 is the standard Armenian / European
 * legal filing page (210 × 297 mm). NOT a fake citation — this is the page
 * size used by every Armenian court for filings.
 */
export const PAGE_SIZE = "A4" as const;
export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;

// Convert mm → PostScript points (1 mm = 2.834645669 pt). Used by pdfkit
// (which works in points by default).
export const MM_TO_PT = 2.834645669;

// Convert mm → twentieths of a point (twips). Used by docx (which works in
// twips for margins — 1440 twips = 1 inch = 25.4 mm).
export const MM_TO_TWIPS = 1440 / 25.4;

// ---------------------------------------------------------------------------
// §11 — Margins (typical Armenian legal filing)
// ---------------------------------------------------------------------------

/**
 * Page margins in millimeters. These are reasonable defaults for an Armenian
 * legal filing (left margin slightly larger to accommodate binding). NOT a
 * fake statutory citation — this is current practice observed in Armenian
 * court filings.
 */
export const MARGINS_MM = {
  top: 25,
  bottom: 25,
  left: 30,
  right: 20,
} as const;

/** Same margins expressed in PostScript points (for pdfkit). */
export const MARGINS_PT = {
  top: Math.round(MARGINS_MM.top * MM_TO_PT),
  bottom: Math.round(MARGINS_MM.bottom * MM_TO_PT),
  left: Math.round(MARGINS_MM.left * MM_TO_PT),
  right: Math.round(MARGINS_MM.right * MM_TO_PT),
} as const;

/** Same margins expressed in twips (for docx). */
export const MARGINS_TWIPS = {
  top: Math.round(MARGINS_MM.top * MM_TO_TWIPS),
  bottom: Math.round(MARGINS_MM.bottom * MM_TO_TWIPS),
  left: Math.round(MARGINS_MM.left * MM_TO_TWIPS),
  right: Math.round(MARGINS_MM.right * MM_TO_TWIPS),
} as const;

// ---------------------------------------------------------------------------
// §11 — Body typography
// ---------------------------------------------------------------------------

/**
 * Body text formatting for court-ready export. Times New Roman 12pt with 1.5
 * line spacing and a first-line indent of 12.5 mm is the prevailing
 * convention for Armenian legal filings.
 */
export const BODY = {
  font: "Times New Roman",
  fontSize: 12,
  lineHeight: 1.5,
  firstLineIndentMm: 12.5,
} as const;

// ---------------------------------------------------------------------------
// §11 — Heading typography
// ---------------------------------------------------------------------------

export const HEADING = {
  font: "Times New Roman",
  h1Size: 14,
  h2Size: 13,
  h3Size: 12,
  bold: true,
} as const;

// ---------------------------------------------------------------------------
// §11 — Alignment
// ---------------------------------------------------------------------------

export const ALIGNMENT = {
  body: "justify",
  heading: "center",
} as const;

// ---------------------------------------------------------------------------
// §11 — Page break rules
// ---------------------------------------------------------------------------

export const PAGE_BREAK = {
  beforeHeading: true,
  avoidOrphans: true,
} as const;

// ---------------------------------------------------------------------------
// §11 — Numbering
// ---------------------------------------------------------------------------

/**
 * Numbering scheme for sections + attachments. Section numbering is
 * hierarchical (1 / 1.1 / 1.1.1); attachment numbering is "Հավելված 1"
 * (Appendix 1) in Armenian.
 */
export const NUMBERING = {
  sections: "1. 1.1 1.1.1",
  attachments: "Հավելված 1, Հավելված 2",
} as const;

// ---------------------------------------------------------------------------
// §11 — Signature block
// ---------------------------------------------------------------------------

/**
 * Signature block format appended at the end of court-ready drafts. The
 * placeholder `__/s/ [signer name]` is the conventional electronic-signature
 * notation; the operator fills the actual signer + title + date.
 */
export const SIGNATURE_BLOCK =
  "__/s/ [signer name]\n[title]\n[date]" as const;

// ---------------------------------------------------------------------------
// §11 — Quote block
// ---------------------------------------------------------------------------

export const QUOTE_BLOCK = {
  indentMm: 20,
  fontSize: 11,
  italic: true,
} as const;

// ---------------------------------------------------------------------------
// §11 — Table
// ---------------------------------------------------------------------------

export const TABLE = {
  headerBold: true,
  borders: true,
  fontSize: 11,
} as const;

// ---------------------------------------------------------------------------
// §19 — PDF font policy (Armenian Unicode support)
// ---------------------------------------------------------------------------

/**
 * PDF font policy. The PDF export uses DejaVuSans (system font) for Armenian
 * Unicode support — DejaVuSans ships with most Linux distributions and
 * covers the Armenian block U+0530–U+058F.
 *
 * §19 CRITICAL: "Do NOT share font files" — the export code locates the font
 * at runtime via `findUnicodeFont()` and does NOT bundle font bytes in the
 * repo or in the exported PDF's metadata beyond what pdfkit embeds by
 * subsetting for the rendered glyphs.
 */
export const PDF_FONT = {
  family: "DejaVuSans",
  embed: true,
  bold: "DejaVuSans-Bold",
  italic: "DejaVuSans-Oblique",
} as const;

/**
 * Candidate DejaVuSans file locations checked at runtime (Linux + macOS).
 * The export code stops at the first existing file.
 */
export const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/DejaVuSans.ttf",
  "/usr/local/share/fonts/dejavu/DejaVuSans.ttf",
] as const;

export const FONT_BOLD_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
] as const;

// ---------------------------------------------------------------------------
// §37 — DRAFT watermark for unverified drafts
// ---------------------------------------------------------------------------

/**
 * Visible DRAFT watermark label appended to the header of UNVERIFIED drafts.
 * Per §37: unverified drafts must NOT carry a "VERIFIED" badge — they carry
 * a visible DRAFT label so the operator does not accidentally file them.
 *
 * Armenian: "ՉՍՏՈՒԳՎԱԾ ՆԱԽԱԳԻԾ" (unverified draft).
 */
export const DRAFT_LABEL = "DRAFT / ՉՍՏՈՒԳՎԱԾ ՆԱԽԱԳԻԾ" as const;

// ---------------------------------------------------------------------------
// §11 — Court-ready format composite (re-exported for export code + tests)
// ---------------------------------------------------------------------------

/**
 * Single composite object exposing every formatting constant. This is the
 * shape the export code reads from — tests can snapshot it for stability
 * checks (§21 numbering determinism).
 */
export const COURT_READY_FORMAT = {
  page: {
    size: PAGE_SIZE,
    widthMm: PAGE_WIDTH_MM,
    heightMm: PAGE_HEIGHT_MM,
  },
  margins: MARGINS_MM,
  marginsPt: MARGINS_PT,
  marginsTwips: MARGINS_TWIPS,
  body: BODY,
  heading: HEADING,
  alignment: ALIGNMENT,
  pageBreak: PAGE_BREAK,
  numbering: NUMBERING,
  signature: { block: SIGNATURE_BLOCK },
  quoteBlock: QUOTE_BLOCK,
  table: TABLE,
  pdfFont: PDF_FONT,
  draftLabel: DRAFT_LABEL,
} as const;

// ---------------------------------------------------------------------------
// §19 — Helper: locate the Unicode TTF font at runtime (Armenian support)
// ---------------------------------------------------------------------------

/**
 * Locate the first existing font file from a list of candidate paths.
 * Returns null when no candidate exists (the export code then degrades to
 * the default Latin-only font — the formatting test surfaces this as a
 * failure for VERIFIED PDF export).
 *
 * §19 CRITICAL: this function does NOT ship font files; it only reads from
 * well-known system font directories.
 */
export function findUnicodeFont(
  candidates: readonly string[],
): string | null {
  // Lazy-load node:fs to avoid pulling fs into client bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync, statSync } = require("node:fs") as {
    existsSync: (p: string) => boolean;
    statSync: (p: string) => { isFile: () => boolean };
  };
  for (const path of candidates) {
    try {
      if (existsSync(path) && statSync(path).isFile()) {
        return path;
      }
    } catch {
      // ignore — try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// §22 — Human-readable type labels for the References section
// ---------------------------------------------------------------------------

/**
 * Map internal source-id type (fact / legislation / cassation / concourt /
 * echr / evidence / chronology / argument) to a human-readable Armenian
 * label. The References section in exported drafts lists citations WITHOUT
 * leaking internal debug IDs (F1, C2, ...); instead it uses these type
 * labels so the reader sees "Փաստ: ..." (Fact: ...) etc.
 *
 * §22 CRITICAL: "normal export renders human-readable legal citations, NOT
 *                debug IDs (F1/C2 etc.)"
 */
export const SOURCE_TYPE_LABELS_HY: Record<string, string> = {
  fact: "Փաստ",
  chronology: "Ժամանակագրություն",
  legislation: "Օրենսդրություն",
  cassation: "Վճռաբեկ դատարանի նախադեպ",
  concourt: "Սահմանադրական դատարանի նախադեպ",
  echr: "Եվրոպական դատարանի նախադեպ",
  argument: "Ապացույց",
  evidence: "Ապացույց",
};

export const SOURCE_TYPE_LABELS_EN: Record<string, string> = {
  fact: "Fact",
  chronology: "Chronology",
  legislation: "Legislation",
  cassation: "Cassation precedent",
  concourt: "Constitutional Court precedent",
  echr: "ECtHR precedent",
  argument: "Argument",
  evidence: "Evidence",
};
