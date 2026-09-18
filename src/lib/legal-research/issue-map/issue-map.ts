// src/lib/legal-research/issue-map/issue-map.ts
// Legal Issue Map (master prompt §8-§9).
//
// Built BEFORE deep analysis: decomposes the user's question into legal
// issues (hypotheses — NEVER treated as established violations), extracts
// user-alleged facts with explicit epistemic status (§18-§19), and maps
// possible governing sources.
//
// Priority order:
//   1. deep-mode LLM subquestions already produced by query understanding
//      (reuse — do not re-decompose);
//   2. LLM-assisted decomposition for complex fact patterns (structured JSON,
//      fail-closed);
//   3. deterministic fallback from detected concepts.

import type {
  LegalIssue,
  LegalIssueCategory,
  LegalIssueMap,
  UserCaseFact,
} from "../types";
import type { QueryUnderstanding } from "@/lib/legal-search/types";
import { decomposeIssues } from "./issue-decomposer";
import type { StructuredLlm } from "../llm";

/** Deterministic category inference from Armenian keywords. */
export function inferIssueCategory(text: string): LegalIssueCategory {
  const t = text.toLowerCase();
  if (/(միեվդ|есчтр|echr|europea?n? court|convention|կոնվենցիա)/i.test(t)) return "ECHR";
  if (/(սահմանադրություն|սահմանադրական|constitut)/i.test(t)) return "CONSTITUTIONAL";
  if (/(ապացույց|ապացուց|վկա|dubi|eviden|միջնորդության վերաբերյալ ապացույց)/i.test(t))
    return "EVIDENTIARY";
  if (
    /(վարույթ|դատավարություն|դատական կարգ|ծանուցում|ժամկետ|միջնորդություն|կալանք|խուզարկություն|procedur|custod|detention|search|seizure|notice)/i.test(
      t,
    )
  )
    return "PROCEDURAL";
  if (/(բողոք|վերականգնում|փոխհատուցում|remed|compensat|appeal)/i.test(t)) return "REMEDY";
  return "SUBSTANTIVE";
}

/** Deterministic single-issue fallback from the parsed query. */
function deterministicIssue(u: QueryUnderstanding, query: string): LegalIssue {
  const concept = u.concepts[0];
  const title = concept ? concept.hy : query.slice(0, 120);
  return {
    id: "I1",
    title,
    description: `Հիմնական իրավական հարցը՝ ${title}`,
    category: inferIssueCategory(`${query} ${title}`),
    relevantFacts: [],
    possibleLegalSources: u.exactReferences.actTitles.slice(0, 3),
    status: "OPEN",
  };
}

/** Convert deep-mode LLM subquestions into issues (no extra LLM call). */
function issuesFromSubquestions(u: QueryUnderstanding): LegalIssue[] {
  const subs = (u.subquestions ?? []).slice(0, 7);
  return subs.map((sq, i) => ({
    id: `I${i + 1}`,
    title: sq,
    description: `Հետազոտության ենթահարց՝ ${sq}`,
    category: inferIssueCategory(sq),
    relevantFacts: [],
    possibleLegalSources: u.exactReferences.actTitles.slice(0, 3),
    status: "OPEN" as const,
  }));
}

/**
 * Build the Legal Issue Map.
 * `llm` is optional — when absent the map is fully deterministic.
 */
export async function buildIssueMap(
  query: string,
  understanding: QueryUnderstanding,
  llm: StructuredLlm | null,
  deadline?: number,
): Promise<LegalIssueMap> {
  // 1. Reuse deep-mode subquestions when the engine already decomposed.
  let issues: LegalIssue[] = issuesFromSubquestions(understanding);
  let userFacts: UserCaseFact[] = [];
  let builtBy: LegalIssueMap["builtBy"] = "deterministic";

  // 2. Complex fact pattern (long query): decompose. Exact references are a
  //    RETRIEVAL override, not an issue-map override — a long fact pattern
  //    with an article mention still deserves decomposition (§8-§9).
  const isComplexFactPattern = query.length > 80;
  if (issues.length === 0 && isComplexFactPattern && llm) {
    const decomposed = await decomposeIssues(query, llm, deadline);
    if (decomposed) {
      issues = decomposed.issues.slice(0, 7).map((iss, i) => ({
        id: `I${i + 1}`,
        title: iss.title,
        description: iss.description,
        category: normalizeCategory(iss.category),
        relevantFacts: iss.relevantFacts.slice(0, 6),
        possibleLegalSources: iss.possibleLegalSources.slice(0, 4),
        status: "OPEN",
      }));
      userFacts = decomposed.userFacts.slice(0, 10).map((f, i) => ({
        id: `UF${i + 1}`,
        fact: f.fact,
        source: "USER",
        verified: false,
        status: "USER_ALLEGED",
        legalRelevance: f.legalRelevance?.slice(0, 3),
      }));
      builtBy = "llm-assisted";
    }
  }

  // 3. Deterministic fallback.
  if (issues.length === 0) {
    issues = [deterministicIssue(understanding, query)];
  }

  // Always register exact-reference issues (§92 — exact precedent focus).
  for (const cn of understanding.exactReferences.caseNumbers.slice(0, 2)) {
    const id = `I${issues.length + 1}`;
    issues.push({
      id,
      title: `${cn} նախադեպի կիրառելիություն`,
      description: `Օգտատիրոջ նշած ${cn} գործի իրավական դիրքի հաստատում և կիրառելիության գնահատում`,
      category: "PROCEDURAL",
      relevantFacts: [],
      possibleLegalSources: [],
      status: "OPEN",
    });
  }

  return { question: query, issues, userFacts, builtBy };
}

function normalizeCategory(c: string): LegalIssueCategory {
  const valid: LegalIssueCategory[] = [
    "SUBSTANTIVE",
    "PROCEDURAL",
    "EVIDENTIARY",
    "CONSTITUTIONAL",
    "ECHR",
    "REMEDY",
  ];
  const up = String(c).toUpperCase();
  return (valid as string[]).includes(up) ? (up as LegalIssueCategory) : "SUBSTANTIVE";
}
