// src/lib/legal-research/verification/quote-verifier.ts
// Quote verification for the research layer (master prompt §15, §54).
//
// Reuses the Phase 3 §48 exact-quote rule: a literal quote is allowed only
// when it exists in a VERIFIED evidence passage. Anything else is marked
// non-literal. Deterministic.

import type { LegalEvidence } from "@/lib/legal-search/types";
import { normText } from "./holding-verifier";

export type QuoteVerdict = "VERIFIED_LITERAL" | "NON_LITERAL";

/**
 * Verify that a literal quote exists in the passage of the cited evidence.
 * Partial containment (head/tail >= 40 chars) counts as verified — the
 * model may trim a quote slightly.
 */
export function verifyQuoteAgainstEvidence(
  quote: string,
  evidence: LegalEvidence | undefined,
): QuoteVerdict {
  if (!evidence || !evidence.passage) return "NON_LITERAL";
  if (!evidence.fullTextVerified) return "NON_LITERAL"; // §47-§48

  const q = normText(quote);
  if (q.length < 8) return "NON_LITERAL";
  const hay = normText(evidence.passage);
  if (hay.includes(q)) return "VERIFIED_LITERAL";

  const head = q.slice(0, Math.min(60, q.length));
  const tail = q.slice(-Math.min(60, q.length));
  if (head.length >= 40 && hay.includes(head)) return "VERIFIED_LITERAL";
  if (tail.length >= 40 && hay.includes(tail)) return "VERIFIED_LITERAL";
  return "NON_LITERAL";
}

/**
 * §54 — no fabricated paragraph numbers. Extract §-references from an
 * answer sentence and check whether at least one evidence passage mentions
 * the same paragraph marker.
 */
export function paragraphNumbersReferenced(text: string): string[] {
  const out: string[] = [];
  const re = /§\s*(\d{1,3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

export function paragraphExistsInEvidence(
  paragraph: string,
  evidence: LegalEvidence[],
): boolean {
  const marker = new RegExp(`(?:§|para?\\s*\\.?\\s*)${paragraph}\\b`, "i");
  return evidence.some((e) => marker.test(e.passage));
}
