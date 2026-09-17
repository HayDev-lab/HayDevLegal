// src/lib/legal-search/engine/query-understanding.ts
// Legal intent extraction (spec §8).
//
// Builds on the existing deterministic parser (src/lib/legal/query-parser.ts)
// and adds:
//  - legal concept detection via the curated bilingual lexicon;
//  - exact reference extraction (articles / case numbers / act titles)
//    that OVERRIDE semantic expansion (spec §10);
//  - optional LLM-assisted understanding for DEEP mode (subquestions +
//    concepts), with a strict timeout and JSON contract.

import type { LegalQuery } from "@/lib/legal/types";
import { parseLegalQuery } from "@/lib/legal/query-parser";
import { detectConcepts } from "./concept-lexicon";
import type { QueryUnderstanding, LegalConcept, ExpandedQuery } from "../types";
import { POLICY } from "../config";

/** Extract exact references (spec §10). */
function extractExactReferences(parsed: LegalQuery): QueryUnderstanding["exactReferences"] {
  const articles: string[] = [];
  if (parsed.article) articles.push(parsed.article);

  // "Article 6", "Article 5 §3", "5-րդ հոդված" for ECHR contexts.
  const echrMatch = parsed.normalized.match(/article\s+(\d+(?:\s*§\s*\d+)?)/i);
  if (echrMatch) articles.push(echrMatch[1].replace(/\s*§\s*/, "§"));

  const caseNumbers: string[] = [];
  if (parsed.caseNumber) caseNumbers.push(parsed.caseNumber);

  const actTitles: string[] = [];
  if (parsed.actTitle) actTitles.push(parsed.actTitle);

  return { articles, caseNumbers, actTitles };
}

/**
 * Deterministic query understanding — always runs, no network.
 */
export function understandQuery(raw: string): QueryUnderstanding {
  const parsed = parseLegalQuery(raw);
  const concepts = detectConcepts(parsed.normalized);
  const exactReferences = extractExactReferences(parsed);

  const hasExactReference =
    exactReferences.articles.length > 0 ||
    exactReferences.caseNumbers.length > 0 ||
    exactReferences.actTitles.length > 0;

  return {
    parsed,
    concepts,
    variants: [], // filled by expandQuery
    hasExactReference,
    exactReferences,
  };
}

// ---------------------------------------------------------------------------
// LLM-assisted understanding (deep mode only, spec §24)
// ---------------------------------------------------------------------------

type LlmUnderstanding = {
  concepts?: Array<{ hy: string; en?: string; ru?: string }>;
  subquestions?: string[];
};

/** Ask the LLM to decompose a complex legal question (deep mode). */
export async function understandQueryWithLLM(
  raw: string,
  base: QueryUnderstanding,
  timeoutMs: number,
): Promise<QueryUnderstanding> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    const zai = await ZAI.create();

    const prompt = `Վերլուծիր իրավական հարցը և վերադարձրու ՄԻԱՅՆ JSON այս ձևաչափով՝
{"concepts":[{"hy":"հայերեն հասկացություն","en":"english","ru":"русский"}],"subquestions":["հարց 1","հարց 2"]}

ԿԱՆՈՆՆԵՐ
- concepts՝ 2-4 իրավական հասկացություն
- subquestions՝ 3-5 ԿԱՐՃ ենթահարց (առավելագույնը 12 բառ յուրաքանչյուրը)
- Միայն JSON, առանց բացատրության։

ՀԱՐՑԸ՝ ${raw}`;

    const resp = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "Դու վերադարձնում ես միայն վավեր JSON։ Ոչ մի լրացուցիչ տեքստ, ոչ մի մեկնաբանություն։",
          },
          { role: "user", content: prompt },
        ],
        thinking: { type: "disabled" },
        max_tokens: 900,
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("llm timeout")), timeoutMs)),
    ])) as { choices?: Array<{ message?: { content?: string } }> };

    const text = (resp.choices?.[0]?.message?.content ?? "")
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return base;
    let parsed: LlmUnderstanding;
    try {
      parsed = JSON.parse(jsonMatch[0]) as LlmUnderstanding;
    } catch {
      // Truncated JSON: salvage the subquestions array via regex.
      const sqMatch = text.match(/"subquestions"\s*:\s*\[([\s\S]*?)\]/);
      const conceptsMatch = text.match(/"concepts"\s*:\s*\[([\s\S]*?)\]/);
      if (!sqMatch && !conceptsMatch) return base;
      parsed = {};
      if (conceptsMatch) {
        try {
          parsed.concepts = JSON.parse(`[${conceptsMatch[1]}]`)
            .filter((c) => c && typeof c.hy === "string");
        } catch {
          // ignore malformed concepts
        }
      }
      if (sqMatch) {
        try {
          parsed.subquestions = JSON.parse(`[${sqMatch[1]}]`).filter(
            (q) => typeof q === "string",
          );
        } catch {
          // ignore malformed subquestions
        }
      }
    }

    // Merge LLM concepts (avoiding duplicates with lexicon hits).
    const concepts: LegalConcept[] = [...base.concepts];
    const seen = new Set(concepts.map((c) => c.hy));
    for (const c of parsed.concepts ?? []) {
      if (!c?.hy || typeof c.hy !== "string") continue;
      if (seen.has(c.hy)) continue;
      seen.add(c.hy);
      concepts.push({
        hy: c.hy.slice(0, 80),
        en: typeof c.en === "string" ? c.en.slice(0, 120) : undefined,
        ru: typeof c.ru === "string" ? c.ru.slice(0, 120) : undefined,
        detectedBy: "llm",
      });
    }

    const subquestions = (parsed.subquestions ?? [])
      .filter((s) => typeof s === "string" && s.trim().length > 8)
      .slice(0, POLICY.maxSubquestions)
      .map((s) => s.trim().slice(0, 220));

    return { ...base, concepts, subquestions: subquestions.length ? subquestions : undefined };
  } catch (err) {
    console.error("[understandQueryWithLLM] failed:", err instanceof Error ? err.message : err);
    // LLM understanding is best-effort: deterministic understanding is enough.
    return base;
  } finally {
    clearTimeout(timer);
  }
}

/** Build the adapter-level variant list (see query-expansion.ts). */
export type { ExpandedQuery };
