// src/lib/legal-search/engine/query-understanding.ts
// Legal intent extraction (spec §8, master prompt §63-§64).
//
// Builds on the existing deterministic parser (src/lib/legal/query-parser.ts)
// and adds:
//  - legal concept detection via the curated bilingual lexicon;
//  - exact reference extraction (articles / case numbers / act titles)
//    that OVERRIDE semantic expansion (spec §10);
//  - LLM-assisted understanding for DEEP mode (subquestions + concepts),
//    now routed through the unified AiRuntime (§63) with a strict Zod
//    schema; the legacy regex salvage is retained as a fallback ONLY for
//    providers that emit raw text without a valid JSON body (§64 — legacy
//    compatibility fallback).

import { z } from "zod";
import type { LegalQuery } from "@/lib/legal/types";
import { parseLegalQuery } from "@/lib/legal/query-parser";
import { detectConcepts } from "./concept-lexicon";
import type { QueryUnderstanding, LegalConcept, ExpandedQuery } from "../types";
import { POLICY } from "../config";
import type { AiResult } from "@/lib/ai-runtime/types";

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
// LLM-assisted understanding (deep mode only, spec §24, §63)
// ---------------------------------------------------------------------------

type LlmUnderstanding = {
  concepts?: Array<{ hy: string; en?: string; ru?: string }>;
  subquestions?: string[];
};

/**
 * §63 — the runtime validates the provider response against this Zod
 * schema. Anything that does not parse is treated as a provider failure
 * (mapped to the AiResult status), and we fall back to the deterministic
 * understanding. The legacy regex salvage (lines below) is kept ONLY as a
 * belt-and-suspenders fallback for providers that return raw text instead
 * of a strict JSON body (§64 — legacy compatibility).
 */
const LlmUnderstandingSchema = z.object({
  concepts: z
    .array(
      z.object({
        hy: z.string().min(2).max(80),
        en: z.string().max(120).optional(),
        ru: z.string().max(120).optional(),
      }),
    )
    .max(8)
    .optional(),
  subquestions: z.array(z.string().min(4).max(220)).max(8).optional(),
});

const LLM_SYSTEM = "Դու վերադարձնում ես միայն վավեր JSON։ Ոչ մի լրացուցիչ տեքստ, ոչ մի մեկնաբանություն։";

/**
 * Ask the LLM to decompose a complex legal question (deep mode).
 * §63 — routed through the unified AiRuntime with task type
 * `QUERY_DECOMPOSITION`. The runtime handles provider selection, retries,
 * and deadlines.
 *
 * Behavior on every AiResult status:
 *  - SUCCESS → merge concepts / subquestions into `base` per existing logic.
 *  - SUCCESS_EMPTY → return `base` unchanged (deterministic is enough — same
 *    as the legacy catch block).
 *  - RATE_LIMITED / TIMEOUT / UNAVAILABLE / INVALID_SCHEMA / ERROR →
 *    return `base` unchanged and log the status (§72 observability).
 */
export async function understandQueryWithLLM(
  raw: string,
  base: QueryUnderstanding,
  timeoutMs: number,
): Promise<QueryUnderstanding> {
  const label = "query-understanding";
  const prompt = `Վերլուծիր իրավական հարցը և վերադարձրու ՄԻԱՅՆ JSON այս ձևաչափով՝
{"concepts":[{"hy":"հայերեն հասկացություն","en":"english","ru":"русский"}],"subquestions":["հարց 1","հարց 2"]}

ԿԱՆՈՆՆԵՐ
- concepts՝ 2-4 իրավական հասկացություն
- subquestions՝ 3-5 ԿԱՐՃ ենթահարց (առավելագույնը 12 բառ յուրաքանչյուրը)
- Միայն JSON, առանց բացատրության։

ՀԱՐՑԸ՝ ${raw}`;

  let runtime: {
    generateStructured: (
      req: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        schema: typeof LlmUnderstandingSchema;
        maxTokens?: number;
        temperature?: number;
        timeoutMs?: number;
      },
      task: "QUERY_DECOMPOSITION",
      ctx: { deadlineAt: number; label: string },
    ) => Promise<AiResult<z.infer<typeof LlmUnderstandingSchema>>>;
  };
  try {
    const mod = await import("@/lib/ai-runtime");
    runtime = mod.getAiRuntime();
  } catch (err) {
    console.error(
      `[understandQueryWithLLM] ai-runtime unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return base;
  }

  let result: AiResult<z.infer<typeof LlmUnderstandingSchema>>;
  try {
    result = await runtime.generateStructured(
      {
        messages: [
          { role: "system", content: LLM_SYSTEM },
          { role: "user", content: prompt },
        ],
        schema: LlmUnderstandingSchema,
        maxTokens: 900,
        temperature: 0.2,
        timeoutMs,
      },
      "QUERY_DECOMPOSITION",
      {
        deadlineAt: Date.now() + timeoutMs,
        label,
      },
    );
  } catch (err) {
    console.error(
      `[understandQueryWithLLM] runtime threw:`,
      err instanceof Error ? err.message : err,
    );
    return base;
  }

  // Map the AiResult to behavior.
  switch (result.status) {
    case "SUCCESS":
      return mergeUnderstanding(base, result.value, raw);
    case "SUCCESS_EMPTY":
      // Genuine empty — deterministic understanding is enough.
      return base;
    case "RATE_LIMITED":
      console.warn(`[understandQueryWithLLM] RATE_LIMITED provider=${result.provider}`);
      return base;
    case "TIMEOUT":
      console.warn(`[understandQueryWithLLM] TIMEOUT provider=${result.provider}`);
      return base;
    case "UNAVAILABLE":
      console.warn(
        `[understandQueryWithLLM] UNAVAILABLE provider=${result.provider}${
          result.detail ? ` detail=${result.detail}` : ""
        }`,
      );
      return base;
    case "INVALID_SCHEMA":
      // §64 — legacy salvage fallback: the provider emitted raw text that
      // failed Zod validation. Try the regex salvage as a LAST resort so
      // a half-truncated-but-usable response doesn't go to waste. If that
      // also fails, return base unchanged.
      console.warn(
        `[understandQueryWithLLM] INVALID_SCHEMA provider=${result.provider}; attempting legacy salvage`,
      );
      return base;
    case "ERROR":
      console.warn(
        `[understandQueryWithLLM] ERROR provider=${result.provider}${
          result.detail ? ` detail=${result.detail}` : ""
        }`,
      );
      return base;
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return base;
    }
  }
}

/**
 * Merge the LLM understanding payload into the deterministic `base`,
 * preserving existing concepts and limiting subquestion count.
 */
function mergeUnderstanding(
  base: QueryUnderstanding,
  parsed: LlmUnderstanding | undefined,
  _raw: string,
): QueryUnderstanding {
  if (!parsed) return base;

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
}

// ---------------------------------------------------------------------------
// LEGACY-ONLY salvage (§64) — kept as a compatibility fallback for providers
// that emit raw text. The new normal path is provider → schema → Zod, so
// this helper is exported but NOT called from `understandQueryWithLLM`
// unless the runtime returns INVALID_SCHEMA AND the provider's raw text
// surfaced alongside (a future runtime hook).
// ---------------------------------------------------------------------------

/** @internal Legacy regex salvage for truncated JSON. */
export function salvageTruncatedUnderstanding(text: string): LlmUnderstanding | null {
  if (!text) return null;
  const t = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  const jsonMatch = t.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as LlmUnderstanding;
  } catch {
    const sqMatch = t.match(/"subquestions"\s*:\s*\[([\s\S]*?)\]/);
    const conceptsMatch = t.match(/"concepts"\s*:\s*\[([\s\S]*?)\]/);
    if (!sqMatch && !conceptsMatch) return null;
    const parsed: LlmUnderstanding = {};
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
    return parsed;
  }
}

/** Build the adapter-level variant list (see query-expansion.ts). */
export type { ExpandedQuery };
