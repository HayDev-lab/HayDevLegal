// src/lib/legal-research/issue-map/issue-decomposer.ts
// LLM-assisted decomposition of a complex fact pattern into legal issues
// (master prompt §9). Issues are HYPOTHESES for research — the prompt
// forbids treating them as established violations. Structured JSON only
// (§75); fail closed to null (§76).

import { z } from "zod";
import type { StructuredLlm } from "../llm";

const DecompositionSchema = z.object({
  issues: z
    .array(
      z.object({
        title: z.string().min(3).max(160),
        description: z.string().min(3).max(600),
        category: z.enum([
          "SUBSTANTIVE",
          "PROCEDURAL",
          "EVIDENTIARY",
          "CONSTITUTIONAL",
          "ECHR",
          "REMEDY",
        ]),
        relevantFacts: z.array(z.string().min(2).max(300)).max(6),
        possibleLegalSources: z.array(z.string().min(2).max(200)).max(4),
      }),
    )
    .min(1)
    .max(7),
  userFacts: z
    .array(
      z.object({
        fact: z.string().min(3).max(300),
        legalRelevance: z.array(z.string().max(120)).max(3).optional(),
      }),
    )
    .max(10),
});

export type IssueDecomposition = z.infer<typeof DecompositionSchema>;

const SYSTEM = `Դու իրավական հարցերի վերլուծաբան ես։ Բարդ փաստային իրավիճակը վերծանում ես ԱՌԱՆՁԻՆ ԻՐԱՎԱԿԱՆ ՀԱՐՑԵՐԻ։

ԿԱՆՈՆՆԵՐ
1. Յուրաքանչյուր հարց լինի ԿԱՐՃ և ԿՈՆԿՐԵՏ (առավելագույնը 14 բառ)։
2. Հարցերը ՎԱՐԿԱԾԱՅԻՆ են՝ հետազոտության ուղղություններ, ՈՉ թե հաստատված խախտումներ։
3. Առանձնացրու իրավական, դատավարական, ապացուցական, սահմանադրական և ՄԻԵՎԴ-ի ասպեկտները, երբ առկա են։
4. userFacts — միայն այն փաստերը, որոնք ՕԳՏԱՏԻՐՈՋ պնդմամբ տեղի են ունեցել (երբեք մի համարիր ապացուցված)։
5. Վերադարձրու ՄԻԱՅՆ JSON այս ձևաչափով՝
{"issues":[{"title":"...","description":"...","category":"PROCEDURAL","relevantFacts":["..."],"possibleLegalSources":["..."]}],"userFacts":[{"fact":"..."}]}`;

export async function decomposeIssues(
  query: string,
  llm: StructuredLlm,
  deadline?: number,
): Promise<IssueDecomposition | null> {
  return llm.analyze({
    label: "issue-decomposition",
    system: SYSTEM,
    user: `ՓԱՍՏԱՅԻՆ ԻՐԱՎԻՃԱԿԸ՝\n${query.slice(0, 2000)}`,
    schema: DecompositionSchema,
    maxTokens: 1100,
    timeoutMs: 14_000,
    deadline,
  });
}
