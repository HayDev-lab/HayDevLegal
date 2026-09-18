// src/lib/case-workspace/legal-issues/builder.ts
//
// §13 — Legal-issue extractor. Detects legal issue framing in document text:
//   - "քրեական գործի շարժառիթում"
//   - "իրավական խնդիր"
//   - "օրենսդրական կարգավորում"
//   - "հոդվածի կիրառում"
//   - "դատական պրակտիկա"
//
// Category: SUBSTANTIVE / PROCEDURAL / EVIDENTIARY / JURISDICTIONAL / OTHER.
//
// Conservative: only emits when an explicit legal-issue framing phrase is
// present (we don't invent legal issues from arbitrary sentences).

import type { EvidenceRef, LegalIssueCategory } from "../analysis-types";
import { scanKeywords } from "../shared/keyword-scanner";

export type LegalIssueLanguage = "hy" | "ru" | "en" | "auto";

export interface LegalIssueCandidate {
  statement: string;
  category: LegalIssueCategory;
  evidenceRef: EvidenceRef;
}

interface IssueTrigger {
  keywords: string[];
  category: LegalIssueCategory;
}

const TRIGGERS: IssueTrigger[] = [
  // Armenian — substantive
  {
    keywords: [
      "իրավական խնդիր",
      "օրենսդրական կարգավորում",
      "հոդվածի կիրառում",
      "քրեական իրավական որակավորում",
      "քաղաքացիական իրավական որակավորում",
    ],
    category: "SUBSTANTIVE",
  },
  // Armenian — procedural
  {
    keywords: [
      "քրեական գործի շարժառիթում",
      "դատավարական կարգ",
      "դատավարության կարգ",
      "իրավասություն",
      "մրցութային իրավասություն",
    ],
    category: "PROCEDURAL",
  },
  // Armenian — evidentiary
  {
    keywords: [
      "ապացույցների ընդունելիություն",
      "ապացույցների գնահատում",
      "ապացուցողական խնդիր",
    ],
    category: "EVIDENTIARY",
  },
  // Armenian — jurisdictional
  {
    keywords: [
      "դատարանի իրավասություն",
      "իրավասական ենթակայություն",
      "բացառություն դատարանի իրավասությունից",
    ],
    category: "JURISDICTIONAL",
  },
  // Armenian — court practice
  {
    keywords: ["դատական պրակտիկա", "դատական վարքագիծ", "բարձրագույն դատարանի պրակտիկա"],
    category: "SUBSTANTIVE",
  },
  // Russian — substantive
  {
    keywords: [
      "правовая проблема",
      "законодательное регулирование",
      "применение статьи",
      "квалификация преступления",
      "квалификация гражданско-правовая",
    ],
    category: "SUBSTANTIVE",
  },
  // Russian — procedural
  {
    keywords: [
      "возбуждение уголовного дела",
      "процессуальный порядок",
      "порядок судопроизводства",
      "подсудность",
    ],
    category: "PROCEDURAL",
  },
  // Russian — evidentiary
  {
    keywords: [
      "допустимость доказательств",
      "оценка доказательств",
      "доказательственная проблема",
    ],
    category: "EVIDENTIARY",
  },
  // Russian — jurisdictional
  {
    keywords: [
      "юрисдикция суда",
      "подсудность",
      "исключение из юрисдикции",
    ],
    category: "JURISDICTIONAL",
  },
  // English — substantive
  {
    keywords: [
      "legal issue",
      "legislative regulation",
      "application of article",
      "qualification of the offense",
    ],
    category: "SUBSTANTIVE",
  },
  // English — procedural
  {
    keywords: [
      "criminal procedure",
      "procedural order",
      "order of proceedings",
      "jurisdiction",
    ],
    category: "PROCEDURAL",
  },
  // English — evidentiary
  {
    keywords: [
      "admissibility of evidence",
      "evaluation of evidence",
      "evidentiary issue",
    ],
    category: "EVIDENTIARY",
  },
  // English — jurisdictional
  {
    keywords: [
      "court jurisdiction",
      "subject-matter jurisdiction",
      "exclusion from jurisdiction",
    ],
    category: "JURISDICTIONAL",
  },
  // English — court practice
  {
    keywords: ["judicial practice", "supreme court practice"],
    category: "SUBSTANTIVE",
  },
];

function buildStatement(text: string, triggerEnd: number): string {
  const boundaries = /[.!?\u0589]/;
  let start = triggerEnd;
  while (start > 0 && !boundaries.test(text[start - 1] ?? "")) start--;
  let end = triggerEnd;
  while (end < text.length && !boundaries.test(text[end] ?? "")) end++;
  if (end < text.length) end++;
  const sentence = text.slice(start, end).replace(/\s+/g, " ").trim();
  return sentence.length > 250 ? sentence.slice(0, 247) + "…" : sentence;
}

function buildContext(text: string, idx: number, end: number): string {
  const start = Math.max(0, idx - 80);
  const stop = Math.min(text.length, end + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = stop < text.length ? "…" : "";
  return prefix + text.slice(start, stop).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * §13 — Extract legal-issue candidates from text.
 */
export function extractLegalIssues(
  text: string,
  documentId: string,
  pageNumber: number,
  _language: LegalIssueLanguage = "auto"
): LegalIssueCandidate[] {
  if (!text || typeof text !== "string") return [];
  if (!documentId) return [];

  const out: LegalIssueCandidate[] = [];
  const seen = new Set<number>();

  for (const trig of TRIGGERS) {
    const hits = scanKeywords(text, trig.keywords, { allowArmenianSuffix: true });
    for (const hit of hits) {
      if (seen.has(hit.start)) continue;
      seen.add(hit.start);
      const statement = buildStatement(text, hit.end) || hit.match;
      const ctx = buildContext(text, hit.start, hit.end);
      out.push({
        statement,
        category: trig.category,
        evidenceRef: {
          documentId,
          page: pageNumber,
          quote: ctx,
          section: trig.category,
        },
      });
    }
  }

  return out;
}
