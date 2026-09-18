// src/lib/legal-drafting/verification/quote-firewall.ts
// Phase 6 — §18 — Quote firewall.
//
// Every quote appearing inside quotation marks in the draft MUST exist in the
// cited source (only harmless whitespace normalization is permitted). If a
// quote is not verbatim present in the cited authority's passages, the
// firewall either:
//   - rejects the quote (the drafter must remove quotation marks and
//     paraphrase with citation), OR
//   - flags the section for review (reviewStatus = NEEDS_SUPPORT).
//
// CRITICAL — §18: "NEVER create model wording inside quotation marks."
// CRITICAL — §14: "The AI may not introduce new legal sources." (Quotes are
//                  a form of source introduction.)
//
// Quote lookup strategy: for every quoted span found in the section body, we
// look for a verbatim match (after harmless whitespace normalization) inside
// the passages of any legal authority (L/C/CC/E) cited by that section, OR
// inside the `quote` field of any evidence ref (CE-type) cited by the
// section, OR inside any `supportingEvidence[i].quote` of any fact (F-type)
// cited by the section.

import type {
  DraftSection,
  DraftingContext,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";
import { extractQuotedText } from "@/lib/legal-drafting/verification/citation-firewall";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * §18 — Normalize a quoted span for harmless-whitespace comparison only.
 *
 * Harmless normalization = collapse runs of whitespace, trim leading/trailing
 * whitespace, normalize smart quotes / dashes. No case folding, no
 * punctuation removal, no reordering — the words must appear in the same
 * order as the source.
 */
function normalizeQuote(text: string): string {
  return text
    .replace(/[\u2010-\u2015]/g, "-") // dashes → ASCII hyphen
    .replace(/[“”„‟]/g, '"') // smart double quotes → ASCII
    .replace(/[‘’‚‛]/g, "'") // smart single quotes → ASCII
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collect all verbatim candidate passages from the closed DraftingContext.
 * Returns a flat list of normalized passages for fuzzy containment check.
 *
 * Includes:
 *   - ctx.legislation[i].passages (verbatim statute passages)
 *   - ctx.cassationCases[i].passages
 *   - ctx.conCourtCases[i].passages
 *   - ctx.echrCases[i].passages
 *   - ctx.evidenceRefs[i].quote (evidence document quotes)
 *   - ctx.facts[i].supportingEvidence[].quote
 *   - ctx.facts[i].contradictingEvidence[].quote
 *   - ctx.chronology[i].evidenceRefs[].quote
 */
function collectCandidatePassages(ctx: DraftingContext): string[] {
  const passages: string[] = [];
  for (const leg of ctx.legislation ?? []) {
    for (const p of leg.passages ?? []) passages.push(p);
  }
  for (const c of ctx.cassationCases ?? []) {
    for (const p of c.passages ?? []) passages.push(p);
  }
  for (const c of ctx.conCourtCases ?? []) {
    for (const p of c.passages ?? []) passages.push(p);
  }
  for (const e of ctx.echrCases ?? []) {
    for (const p of e.passages ?? []) passages.push(p);
  }
  for (const ev of ctx.evidenceRefs ?? []) {
    if (ev.quote) passages.push(ev.quote);
  }
  for (const f of ctx.facts ?? []) {
    for (const e of f.supportingEvidence ?? []) {
      if (e.quote) passages.push(e.quote);
    }
    for (const e of f.contradictingEvidence ?? []) {
      if (e.quote) passages.push(e.quote);
    }
  }
  for (const ce of ctx.chronology ?? []) {
    for (const e of ce.evidenceRefs ?? []) {
      if (e.quote) passages.push(e.quote);
    }
  }
  return passages;
}

/**
 * Look up the candidate passages restricted to the authorities cited by a
 * section. This is a more conservative check than the global one — a quote
 * must be findable in the authorities actually cited, not just any authority
 * in the context.
 *
 * §17 — "Verify article, case, court, date if stated, holding, and quote if
 * quoted."
 */
function collectSectionCandidatePassages(
  ctx: DraftingContext,
  section: DraftSection,
): string[] {
  const passages: string[] = [];
  const sourceIds = section.content?.sourceIds ?? [];

  const legIds = new Set(sourceIds.filter((s) => /^L\d+$/.test(s)));
  const cassIds = new Set(sourceIds.filter((s) => /^C\d+$/.test(s)));
  const ccIds = new Set(sourceIds.filter((s) => /^CC\d+$/.test(s)));
  const echrIds = new Set(sourceIds.filter((s) => /^E\d+$/.test(s)));
  const evIds = new Set(sourceIds.filter((s) => /^CE/.test(s)));
  const factIds = new Set(sourceIds.filter((s) => /^F\d+$/.test(s)));

  for (const leg of ctx.legislation ?? []) {
    if (legIds.has(leg.sourceId)) {
      for (const p of leg.passages ?? []) passages.push(p);
    }
  }
  for (const c of ctx.cassationCases ?? []) {
    if (cassIds.has(c.sourceId)) {
      for (const p of c.passages ?? []) passages.push(p);
    }
  }
  for (const c of ctx.conCourtCases ?? []) {
    if (ccIds.has(c.sourceId)) {
      for (const p of c.passages ?? []) passages.push(p);
    }
  }
  for (const e of ctx.echrCases ?? []) {
    if (echrIds.has(e.sourceId)) {
      for (const p of e.passages ?? []) passages.push(p);
    }
  }
  for (const ev of ctx.evidenceRefs ?? []) {
    if (evIds.has(ev.sourceId) && ev.quote) passages.push(ev.quote);
  }
  for (const f of ctx.facts ?? []) {
    if (factIds.has(f.sourceId)) {
      for (const e of f.supportingEvidence ?? []) {
        if (e.quote) passages.push(e.quote);
      }
      for (const e of f.contradictingEvidence ?? []) {
        if (e.quote) passages.push(e.quote);
      }
    }
  }

  return passages;
}

/**
 * §18 — Verify quotes in the draft.
 *
 * Walks every section, extracts every quoted span, and verifies each appears
 * verbatim (modulo harmless whitespace normalization) inside the cited
 * source's passages. Quotes that don't appear verbatim are flagged for review
 * (the drafter must remove quotation marks and paraphrase with citation, or
 * the section must be marked NEEDS_SUPPORT).
 *
 * CRITICAL — §18: "NEVER create model wording inside quotation marks."
 */
export async function verifyQuotes(
  sections: DraftSection[],
  ctx: DraftingContext,
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  // Pre-build a normalized global passages list. This is used as a fallback
  // when section-specific passages are empty (e.g. section cites only a fact
  // F1 but the quote lives in F1's supporting evidence).
  const globalPassages = collectCandidatePassages(ctx).map(normalizeQuote);
  const globalPassagesSet = new Set(globalPassages);

  for (const section of sections) {
    const text = section.content?.text ?? "";
    const quotes = extractQuotedText(text);

    if (quotes.length === 0) continue;

    // Section-cited candidate passages.
    const sectionPassages = collectSectionCandidatePassages(ctx, section).map(
      normalizeQuote,
    );
    const sectionPassagesSet = new Set(sectionPassages);

    for (const q of quotes) {
      // §18 — Skip very short spans (single-letter / word fragments) since
      // they are likely punctuation artifacts.
      if (q.trim().length < 3) continue;

      const normalized = normalizeQuote(q);

      // 1) Check if the quote is verbatim present in cited authorities.
      let foundInSection = false;
      for (const p of sectionPassages) {
        if (normalizeQuote(p).includes(normalized)) {
          foundInSection = true;
          break;
        }
      }

      // 2) Fallback: check the global passages list (when the section
      //    didn't cite a specific authority, the quote may still appear in
      //    any context passage).
      let foundGlobally = false;
      if (!foundInSection) {
        for (const p of globalPassagesSet) {
          if (p.includes(normalized)) {
            foundGlobally = true;
            break;
          }
        }
      }

      if (foundInSection) {
        assertions.push({
          type: "QUOTE_IN_SOURCE",
          passed: true,
          detail: `Quote "${truncate(q, 60)}…" is verbatim in a cited authority.`,
        });
      } else if (foundGlobally) {
        // The quote exists in the context but not in a section-cited authority.
        // §18 — flag for review (the drafter should cite the right authority).
        assertions.push({
          type: "QUOTE_SOURCE_NOT_CITED",
          passed: false,
          detail: `Quote "${truncate(q, 60)}…" appears in the DraftingContext but the section does not cite its source. Cite the source (L1/C1/CC1/E1/...) or paraphrase without quotation marks.`,
        });
      } else {
        // §18 — "NEVER create model wording inside quotation marks."
        assertions.push({
          type: "QUOTE_NOT_IN_SOURCE",
          passed: false,
          detail: `Quote "${truncate(q, 60)}…" is not present in any cited authority's passages. The AI must not create model wording inside quotation marks (§18). Remove the quotation marks and paraphrase with citation, or mark the section NEEDS_SUPPORT.`,
        });
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n);
}
