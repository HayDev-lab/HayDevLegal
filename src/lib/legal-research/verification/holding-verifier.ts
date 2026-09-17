// src/lib/legal-research/verification/holding-verifier.ts
// Holding verification (master prompt §15, §12, §13).
//
//   proposed holding -> supporting passage -> entailment check ->
//   ACCEPT / WEAK / REJECT
//
// The entailment check is CONSERVATIVE and deterministic:
//   ACCEPT  — the quote verbatim exists in the evidence passage (normalized
//             whitespace) and sits outside a forbidden (party) section;
//   WEAK    — a substantial fragment of the quote exists (>= 60 chars),
//             or the quote is very short;
//   REJECT  — the quote cannot be located, or it sits in a party-submission
//             section (§13 — party claims are never court holdings).

import type { EvidenceRef, LegalHolding } from "../types";

/** Normalize text for containment checks. */
export function normText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[\u0587]/g, "և") // էւ ligature -> և
    .trim()
    .toLowerCase();
}

export type HoldingVerdict = "ACCEPT" | "WEAK" | "REJECT";

export interface HoldingVerificationInput {
  /** The holding's supporting passages (quotes). */
  passages: EvidenceRef[];
  /** Full evidence text the quotes must be located in (evidenceId -> text). */
  evidenceTexts: Map<string, string>;
  /** §13 — section model of each evidence doc for party-claim exclusion. */
  forbiddenQuotes?: Map<string, Set<string>>;
}

/** Verify one quote against an evidence text. */
export function verifyQuote(
  quote: string,
  evidenceText: string,
  forbiddenQuotes?: Set<string>,
): HoldingVerdict {
  const q = normText(quote);
  if (q.length < 12) return "WEAK"; // too short to verify reliably
  const hay = normText(evidenceText);
  if (!hay) return "REJECT";

  // §13 — a quote inside a party-submission section is NOT a court holding.
  if (forbiddenQuotes) {
    for (const fq of forbiddenQuotes) {
      if (normText(fq).includes(q)) return "REJECT";
    }
  }

  if (hay.includes(q)) return "ACCEPT";

  // Partial containment: head or tail fragment of >= 40 chars. The window
  // is deliberately narrow (60) — a quote that diverges early is WEAK only
  // when a substantial prefix still matches.
  const head = q.slice(0, Math.min(60, q.length));
  const tail = q.slice(-Math.min(60, q.length));
  if (head.length >= 40 && hay.includes(head)) return "WEAK";
  if (tail.length >= 40 && hay.includes(tail)) return "WEAK";

  return "REJECT";
}

/** Verify a whole holding; sets verification + confidence (§15). */
export function verifyHolding(
  holding: LegalHolding,
  evidenceTexts: Map<string, string>,
  forbiddenQuotes?: Map<string, Set<string>>,
): LegalHolding {
  if (holding.supportingPassages.length === 0) {
    return { ...holding, verification: "REJECT", confidence: "LOW" };
  }
  let worst: HoldingVerdict = "ACCEPT";
  for (const p of holding.supportingPassages) {
    const text = evidenceTexts.get(p.evidenceId) ?? "";
    const v = verifyQuote(p.quote, text, forbiddenQuotes?.get(p.evidenceId));
    if (v === "REJECT") {
      worst = "REJECT";
      break;
    }
    if (v === "WEAK") worst = "WEAK";
  }
  const confidence: LegalHolding["confidence"] =
    worst === "ACCEPT" ? "HIGH" : worst === "WEAK" ? "MEDIUM" : "LOW";
  return { ...holding, verification: worst, confidence };
}
