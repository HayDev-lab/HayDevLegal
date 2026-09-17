// src/lib/legal-research/analysis/material-facts.ts
// Material fact extraction (master prompt §16-§17, §45).
//
// From each precedent with a verified full text, extract ONLY legally
// material facts (stage, basis, timing, notice, presence, risk factors...),
// each grounded in a verbatim quote. Facts the quote cannot support are
// dropped (fail closed). The fixed taxonomy feeds the distinguishing engine.

import { z } from "zod";
import type { LegalEvidence } from "@/lib/legal-search/types";
import type { MaterialFact, MaterialFactCategory } from "../types";
import type { StructuredLlm } from "../llm";
import { verifyQuote } from "../verification/holding-verifier";
import { splitCourtSections } from "./document-sections";

const CATEGORIES = [
  "STAGE",
  "PROCEDURAL_BASIS",
  "AUTHORITY_ACTION",
  "TIMING",
  "NOTICE",
  "PRESENCE",
  "OBJECT_ORIGIN",
  "CHARGE",
  "DETENTION_STATUS",
  "RISK_ASSESSMENT",
  "OTHER",
] as const;

const FactsSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(CATEGORIES),
        fact: z.string().min(5).max(300),
        quoteSpan: z.string().min(12).max(800),
      }),
    )
    .max(10),
});

const SYSTEM = `Դու դատական գործերի ԻՐԱՎԱԿԱՆ ՆՇԱՆԱԿԱԼԻ փաստերի արտահանող փորձագետ ես։

ԿԱՆՈՆՆԵՐ
1. Արտահանիր ՄԻԱՅՆ իրավական նշանակություն ունեցող փաստեր. վարույթի փուլը, գործողության հիմքը, ո՞ր մարմինն է գործել, ե՞րբ, ծանուցումը եղե՞լ է, ներկայությունը, ապացույցի ծագումը, մեղադրանքը, կալանքի վիճակը, ռիսկի գնահատումը։
2. ԲԱՑ ԹՈՂԻՐ իրավական նշանակություն չունեցող մանրամասնությունները։
3. Յուրաքանչյուր փաստի համար quoteSpan՝ ՓԱՍՏԱՑԻ հատված տեքստից, որը հաստատում է փաստը։
4. category-ներն են՝ ${CATEGORIES.join(", ")}։
5. Եթե նշանակալի փաստեր չկան՝ դատարկ ցուցակ։ ՄԻԱՅՆ JSON՝
{"facts":[{"category":"STAGE","fact":"...","quoteSpan":"..."}]}`;

const ECHR_FACT_HINTS = `
ՀԱՏԿԱՆՇԱԿԱՆ ՄԻԵՎԴ-Ի ՓԱՍՏԵՐ (§45). Արտահանիր միայն երբ առկա են տեքստում՝
reasonable suspicion, relevant and sufficient reasons, risk of absconding,
risk of interference, risk of reoffending, gravity of charges, passage of
time, special diligence, exceptional circumstances.`;

/**
 * Extract verified material facts from one precedent.
 * Returns [] on metadata-only or failed analysis (fail closed).
 */
export async function extractMaterialFacts(
  evidence: LegalEvidence,
  relevanceWeight: number,
  llm: StructuredLlm,
  deadline?: number,
): Promise<MaterialFact[]> {
  // §63 — metadata-only documents have no extractable facts.
  if (!evidence.fullTextVerified || !evidence.passage || evidence.passage.length < 80) {
    return [];
  }

  const isEchr = evidence.sourceType === "echr";
  const sections = splitCourtSections(evidence.passage, isEchr);
  const factsText = sections
    .filter((s) => s.kind === "FACTS" || s.kind === "COURT_ANALYSIS" || s.kind === "UNKNOWN")
    .map((s) => s.text)
    .join("\n") || evidence.passage;

  const raw = await llm.analyze({
    label: `facts-${evidence.id}`,
    system: isEchr ? `${SYSTEM}${ECHR_FACT_HINTS}` : SYSTEM,
    user: `ՓԱՍՏԱԹՂԹ (${evidence.sourceName}${evidence.caseNumber ? `, գործ ${evidence.caseNumber}` : ""})՝\n${factsText.slice(0, 6000)}`,
    schema: FactsSchema,
    maxTokens: 900,
    timeoutMs: 13_000,
    deadline,
  });
  if (!raw || raw.facts.length === 0) return [];

  const out: MaterialFact[] = [];
  raw.facts.forEach((f, i) => {
    const verdict = verifyQuote(f.quoteSpan, factsText);
    if (verdict === "REJECT") return; // ungrounded fact — dropped
    out.push({
      id: `${evidence.id}-F${i + 1}`,
      category: f.category as MaterialFactCategory,
      fact: f.fact,
      evidence: [{ evidenceId: evidence.id, quote: f.quoteSpan }],
      relevanceToIssue: verdict === "ACCEPT" ? relevanceWeight : relevanceWeight * 0.6,
    });
  });
  return out.slice(0, 8);
}

/** Negation markers — used by the distinguishing engine for polarity checks. */
const NEGATION_MARKERS = ["չի ", "չէր ", "չեն ", "բացակայում է", "բացակայում էին", "չի եղել", "չի ուղարկվել", "no ", "not ", "never "];

/** Does a fact statement assert the ABSENCE of its dimension? */
export function isNegativeFact(fact: string): boolean {
  const t = fact.toLowerCase();
  return NEGATION_MARKERS.some((m) => t.includes(m));
}
