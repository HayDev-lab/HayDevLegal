// src/lib/legal-research/verification/proposition-verifier.ts
// Proposition verifier (master prompt §50-§54).
//
// Every substantive proposition in the final answer must link back to
// holdings / applicability / evidence — no orphan propositions (§94).
//
// This module implements the DETERMINISTIC post-generation pass used by
// /api/answer in deep mode:
//   1. Applicability-language check (§53): strong applicability phrasing
//      near [En] is only allowed when the research layer concluded
//      DIRECTLY_RELEVANT for that precedent; otherwise the sentence is
//      softened with an explicit qualifier.
//   2. Paragraph-number fabrication check (§54): §N markers survive only
//      when some evidence passage mentions the same paragraph.
//   3. Metadata-only holding-language check (§63): sentences asserting what
//      "the court held" near a metadata-only citation lose the assertion.

import type { ApplicabilityResult, LegalHolding } from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";
import { paragraphNumbersReferenced, paragraphExistsInEvidence } from "./quote-verifier";

/** Armenian phrasing that asserts DIRECT applicability (§53). */
const DIRECT_APPLICABILITY_RE =
  /(անմիջապես\s+կիրառել|ուղղակիորեն\s+կիրառել|անպայման\s+կիրառել|պարտադիր\s+է\s+կիրառել|կիրառելի\s+է\s+առանց\s+պայմանների)/i;

/** Phrasing asserting what a court held (§63). */
const HOLDING_LANGUAGE_RE =
  /(դատարանը?\s+(?:եզրակացր|հիմնավոր|պարզ|արձանագր|նշել\s+է)|դատարանի?\s+իրավական\s+դիրք|իրավական\s+դիրք\s+է\s+ձևակերպել|Court\s+(?:held|found|concluded))/i;

export interface PropositionVerificationContext {
  evidence: LegalEvidence[];
  applicability: ApplicabilityResult[];
  holdings: LegalHolding[];
}

export interface PropositionVerificationResult {
  text: string;
  /** Sentences softened, per rule. */
  softened: number;
  /** §-references removed as unverifiable. */
  paragraphsRemoved: number;
  /** Holding-language assertions neutralized on metadata-only docs. */
  holdingClaimsNeutralized: number;
}

/**
 * Verify + repair the final deep answer text against the research layer.
 * Pure text transformation — safe to run on the assembled stream result.
 */
export function verifyPropositions(
  text: string,
  ctx: PropositionVerificationContext,
): PropositionVerificationResult {
  const appByEvidence = new Map(ctx.applicability.map((a) => [a.precedentId, a]));
  const holdingDocs = new Set(ctx.holdings.map((h) => h.documentId));
  const metaOnly = new Set(
    ctx.evidence.filter((e) => !e.fullTextVerified).map((e) => e.id),
  );

  let softened = 0;
  let paragraphsRemoved = 0;
  let holdingClaimsNeutralized = 0;

  // Sentence-level pass (split on sentence-final punctuation, keep delim).
  const parts = text.split(/(?<=[։.!?])\s+/);
  const repaired = parts.map((sentence) => {
    const citations = Array.from(sentence.matchAll(/\[E\d+\]/g)).map((m) =>
      m[0].slice(1, -1),
    );
    if (citations.length === 0) return sentence;
    let s = sentence;

    // §53/§24 — direct-applicability phrasing needs a DIRECT conclusion.
    if (DIRECT_APPLICABILITY_RE.test(s)) {
      const anyDirect = citations.some((c) => appByEvidence.get(c)?.conclusion === "DIRECTLY_RELEVANT");
      if (!anyDirect) {
        s = s.replace(DIRECT_APPLICABILITY_RE, (m) => `${m} (սահմանափակումներով)`);
        softened++;
      }
    }

    // §63 — no holding claims on metadata-only documents.
    if (HOLDING_LANGUAGE_RE.test(s)) {
      const citedHoldingDocs = citations.filter((c) => holdingDocs.has(c));
      const onlyMetaCited = citedHoldingDocs.length === 0 && citations.every((c) => metaOnly.has(c));
      if (onlyMetaCited) {
        s = s.replace(
          HOLDING_LANGUAGE_RE,
          (m) => `${m} (ամբողջական տեքստը հասանելի չէ. չստուգված)`,
        );
        holdingClaimsNeutralized++;
      }
    }

    // §54 — fabricated paragraph numbers near citations are removed.
    const paras = paragraphNumbersReferenced(s);
    for (const p of paras) {
      if (!paragraphExistsInEvidence(p, ctx.evidence)) {
        s = s.replace(new RegExp(`\\s*§\\s*${p}\\b`, "g"), "");
        paragraphsRemoved++;
      }
    }

    return s;
  });

  return {
    text: repaired.join(" "),
    softened,
    paragraphsRemoved,
    holdingClaimsNeutralized,
  };
}
