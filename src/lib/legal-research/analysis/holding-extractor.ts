// src/lib/legal-research/analysis/holding-extractor.ts
// Holding extraction (master prompt §11-§15, §43-§44).
//
// For every court decision with a VERIFIED full text:
//   1. split into sections (§14) and keep ONLY court-reasoning sections;
//   2. ask the LLM for structured holdings — issue / rule / application /
//      conclusion — each grounded in a verbatim quoteSpan;
//   3. verify every quote (§15): ACCEPT / WEAK / REJECT; REJECTed holdings
//      are DROPPED (fail closed — no unsupported holding ever reaches the
//      answer);
//   4. ECtHR holdings carry kind = GENERAL_PRINCIPLE vs CASE_SPECIFIC_FINDING
//      (§44 — general standard != why the Court found a violation here).
//
// §63 — metadata-only documents NEVER produce holdings.

import { z } from "zod";
import { ANALYSIS } from "@/lib/legal-search/config";
import type { LegalEvidence } from "@/lib/legal-search/types";
import type { EvidenceRef, LegalHolding, HoldingKind } from "../types";
import type { StructuredLlm } from "../llm";
import { verifyHolding } from "../verification/holding-verifier";
import {
  splitCourtSections,
  holdingEligibleText,
  partySubmissionTexts,
} from "./document-sections";

const HoldingSchema = z.object({
  holdings: z
    .array(
      z.object({
        issue: z.string().min(3).max(200),
        rule: z.string().min(10).max(700),
        application: z.string().max(700).optional(),
        conclusion: z.string().max(400).optional(),
        kind: z.enum(["GENERAL_PRINCIPLE", "CASE_SPECIFIC_FINDING", "DOMESTIC_RULE"]),
        quoteSpan: z.string().min(12).max(1200),
      }),
    )
    .max(4),
});

type RawHolding = z.infer<typeof HoldingSchema>;

const ARM_SYSTEM = `Դու դատական որոշումների իրավական դիրքերի (holdings) արտահանող փորձագետ ես։

ԿԱՆՈՆՆԵՐ
1. ԱՐՏԱՀԱՆԻՐ ՄԻԱՅՆ ԴԱՏԱՐԱՆԻ ՍԵՓԱԿԱՆ իրավական դիրքերը։ Կողմերի (մեղադրյալ, պաշտպան, մեղադրող, կառավարություն) դիրքորոշումները holding ՉԵՆ։
2. Յուրաքանչյուր holding-ի համար տրամադրիր quoteSpan՝ ՓԱՍՏԱՑԻ հատված տրամադրված տեքստից (առնվազն 12 նիշ), որն իրականում հաստատում է rule-ը։
3. Եթե տեքստում չկա դատարանի հստակ իրավական դիրք, վերադարձրու դատարկ holdings ցուցակ։
4. rule-ը լինի ճշգրիտ. ՄԻ ԸՆԴՀԱՐՆԻՐ դատարանի կոնկրետ եզրակացությունը ընդհանուր սկզբունքի հետ։
5. ՄԻԱՅՆ JSON՝
{"holdings":[{"issue":"...","rule":"...","application":"...","conclusion":"...","kind":"DOMESTIC_RULE","quoteSpan":"..."}]}`;

const ECHR_SYSTEM = `Դու ՄԻԵՎԴ-ի որոշումների իրավական դիրքերի արտահանող փորձագետ ես։

ԿԱՆՈՆՆԵՐ
1. ՏԱՐԲԵՐԻՐ՝
   - GENERAL_PRINCIPLE՝ Դատարանի ձևակերպած ԸՆԴՀԱՆՈՒՐ սկզբունք/չափանիշ,
   - CASE_SPECIFIC_FINDING՝ ինչու հենց ԱՅՍ գործում գրանցվեց խախտում/չգրանցվեց։
2. ԱՐՏԱՀԱՆԻՐ միայն Դատարանի (Court's Assessment / The Law) դիրքը, ՈՉ թե կողմերի ներկայացումները։
3. Յուրաքանչյուր holding-ի համար quoteSpan՝ փաստացի հատված տեքստից, որը հաստատում է rule-ը։
4. Եթե հստակ դիրք չկա՝ դատարկ ցուցակ։
5. ՄԻԱՅՆ JSON՝
{"holdings":[{"issue":"...","rule":"...","application":"...","conclusion":"...","kind":"GENERAL_PRINCIPLE","quoteSpan":"..."}]}`;

/**
 * Extract + verify holdings for one evidence document.
 * Returns [] for metadata-only or failed analysis (fail closed, §63/§76).
 */
export async function extractHoldings(
  evidence: LegalEvidence,
  llm: StructuredLlm,
  deadline?: number,
): Promise<LegalHolding[]> {
  // §63 — no verified full text -> no holdings. Ever.
  if (!evidence.fullTextVerified || !evidence.passage || evidence.passage.length < 80) {
    return [];
  }

  const isEchr = evidence.sourceType === "echr";
  const sections = splitCourtSections(evidence.passage, isEchr);
  const eligible = holdingEligibleText(sections) || evidence.passage;

  const raw = await llm.analyze({
    label: `holding-${evidence.id}`,
    system: isEchr ? ECHR_SYSTEM : ARM_SYSTEM,
    user: `ՓԱՍՏԱԹՂԹԻ ՏԵՔՍՏ (${evidence.sourceName}${evidence.caseNumber ? `, գործ ${evidence.caseNumber}` : ""})՝\n${eligible.slice(0, 6000)}`,
    schema: HoldingSchema,
    maxTokens: 1100,
    timeoutMs: 15_000,
    deadline,
  });
  if (!raw || raw.holdings.length === 0) return [];

  const evidenceTexts = new Map<string, string>([[evidence.id, eligible]]);
  // §13 — party-submission sections are quarantined: quotes found there are
  // REJECTed (a party claim is never a court holding).
  const forbiddenQuotes = new Map<string, Set<string>>();
  const partyTexts = partySubmissionTexts(sections);
  if (partyTexts.length > 0) {
    forbiddenQuotes.set(evidence.id, new Set(partyTexts));
  }

  const out: LegalHolding[] = [];
  for (let i = 0; i < Math.min(raw.holdings.length, ANALYSIS.maxHoldingsPerDocument); i++) {
    const h = raw.holdings[i];
    const ref: EvidenceRef = { evidenceId: evidence.id, quote: h.quoteSpan };
    let holding: LegalHolding = {
      id: `${evidence.id}-H${i + 1}`,
      documentId: evidence.id,
      issue: h.issue,
      rule: h.rule,
      application: h.application,
      conclusion: h.conclusion,
      kind: normalizeKind(h.kind, isEchr),
      supportingPassages: [ref],
      confidence: "HIGH",
      verification: "ACCEPT",
    };
    holding = verifyHolding(holding, evidenceTexts, forbiddenQuotes);
    // §12 — a rule without a supporting passage is dropped entirely.
    if (holding.verification === "REJECT") continue;
    out.push(holding);
  }
  return out;
}

function normalizeKind(kind: string, isEchr: boolean): HoldingKind {
  if (kind === "GENERAL_PRINCIPLE" || kind === "CASE_SPECIFIC_FINDING") return kind;
  return isEchr ? "CASE_SPECIFIC_FINDING" : "DOMESTIC_RULE";
}
