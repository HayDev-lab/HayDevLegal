// src/lib/case-workspace/facts/extractor.ts
//
// §10 — Fact extractor. Detects factual assertions in document text.
//
// Conservative: AI proposes candidates with status ALLEGED; cannot promote
// to VERIFIED without evidence. The fact matrix + verifier handles promotion
// based on evidence links — never the extractor.
//
// Categories (TEMPORAL / SPATIAL / IDENTITY / PROCEDURAL / SUBSTANTIVE /
// EVIDENTIARY / OTHER) are inferred from trigger keywords.
//
// Materiality (HIGH for charge/arrest/search; MEDIUM for procedural; LOW
// for contextual) is inferred from trigger keywords.

import type { EvidenceRef, FactCategory, Materiality } from "../analysis-types";
import { scanKeywords } from "../shared/keyword-scanner";

export type FactLanguage = "hy" | "ru" | "en" | "auto";

export interface FactCandidate {
  proposition: string;
  category: FactCategory;
  evidenceRef: EvidenceRef;
  materiality: Materiality;
}

const CONTEXT_CHARS = 80;

interface FactTrigger {
  keywords: string[];
  category: FactCategory;
  materiality: Materiality;
}

const TRIGGERS: FactTrigger[] = [
  // Armenian — substantive
  {
    keywords: ["հանցանքը կատարվել է", "հանցանք կատարվել", "հանցագործությունը կատարվել"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  // Armenian — arrest (HIGH)
  {
    keywords: ["ձերբակալվել է", "ձերբակալություն", "ձերբակալված"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  // Armenian — search (HIGH)
  {
    keywords: ["խուզարկությունն իրականացվել է", "խուզարկություն", "խուզարկվել է"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  // Armenian — charge (HIGH)
  {
    keywords: ["մեղադրանք", "մեղադրյալը խոստովանել է", "մեղադրանք առաջադրվել"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  // Armenian — confession
  {
    keywords: ["խոստովանել է", "խոստովանություն"],
    category: "EVIDENTIARY",
    materiality: "HIGH",
  },
  // Armenian — expert conclusion
  {
    keywords: ["փորձագետի եզրակացությամբ", "փորձագիտական եզրակացություն"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  // Armenian — interrogation
  {
    keywords: ["հարցաքննվել է", "հարցաքննություն", "ցույց է տվել"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  // Armenian — seizure
  {
    keywords: ["բռնագրավվել է", "բռնագրավում"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  // Armenian — filing
  {
    keywords: ["ներկայացվել է", "դատարան է ներկայացվել"],
    category: "PROCEDURAL",
    materiality: "MEDIUM",
  },
  // Armenian — decision
  {
    keywords: ["վճռել է", "որոշում է կայացրել", "դատարանը որոշեց"],
    category: "SUBSTANTIVE",
    materiality: "MEDIUM",
  },
  // Russian
  {
    keywords: ["преступление совершено", "совершено преступление"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  {
    keywords: ["задержан", "арестован", "заключен под стражу"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["обыск произведен", "проведен обыск", "обыск"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["обвинение", "обвиняемый признал", "предъявлено обвинение"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  {
    keywords: ["признал", "признание"],
    category: "EVIDENTIARY",
    materiality: "HIGH",
  },
  {
    keywords: ["по заключению эксперта", "экспертное заключение"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  {
    keywords: ["допрошен", "дали показания", "показал"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  {
    keywords: ["изъято", "конфисковано"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["подано", "представлено в суд"],
    category: "PROCEDURAL",
    materiality: "MEDIUM",
  },
  {
    keywords: ["суд постановил", "суд решил", "вынес решение"],
    category: "SUBSTANTIVE",
    materiality: "MEDIUM",
  },
  // English
  {
    keywords: ["the crime was committed", "committed the offense"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  {
    keywords: ["was arrested", "placed under arrest", "taken into custody"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["search was conducted", "a search warrant was executed", "searched"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["charged", "defendant confessed", "indicted"],
    category: "SUBSTANTIVE",
    materiality: "HIGH",
  },
  {
    keywords: ["confessed", "admitted"],
    category: "EVIDENTIARY",
    materiality: "HIGH",
  },
  {
    keywords: ["according to the expert", "expert report concludes"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  {
    keywords: ["testified", "gave testimony"],
    category: "EVIDENTIARY",
    materiality: "MEDIUM",
  },
  {
    keywords: ["seized", "confiscated"],
    category: "PROCEDURAL",
    materiality: "HIGH",
  },
  {
    keywords: ["filed", "submitted to court"],
    category: "PROCEDURAL",
    materiality: "MEDIUM",
  },
  {
    keywords: ["court ruled", "court decided", "court held"],
    category: "SUBSTANTIVE",
    materiality: "MEDIUM",
  },
];

function buildContext(text: string, start: number, end: number): string {
  const ctxStart = Math.max(0, start - CONTEXT_CHARS);
  const ctxEnd = Math.min(text.length, end + CONTEXT_CHARS);
  const prefix = ctxStart > 0 ? "…" : "";
  const suffix = ctxEnd < text.length ? "…" : "";
  return (
    prefix + text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() + suffix
  );
}

// Build a proposition from the context. The proposition is a one-sentence
// summary of the fact mentioned. We take the context sentence containing
// the trigger keyword.
function buildProposition(text: string, triggerEnd: number): string {
  // Find the sentence containing the trigger keyword.
  // Armenian sentence ender: ։
  const boundaries = /[.!?\u0589]/;
  let start = triggerEnd;
  while (start > 0 && !boundaries.test(text[start - 1] ?? "")) start--;
  let end = triggerEnd;
  while (end < text.length && !boundaries.test(text[end] ?? "")) end++;
  if (end < text.length) end++; // include the boundary punctuation
  const sentence = text.slice(start, end).replace(/\s+/g, " ").trim();
  return sentence.length > 200 ? sentence.slice(0, 197) + "…" : sentence;
}

/**
 * §10 — Extract fact candidates from text.
 * Returns an array of candidates with proposition / category / evidenceRef
 * (provenance: documentId?/page?/quote/section) / materiality.
 *
 * Every candidate starts as ALLEGED (handled by the fact matrix builder).
 */
export function extractFactCandidates(
  text: string,
  opts: {
    language?: FactLanguage;
    documentId?: string;
    page?: number;
    section?: string;
    originalFilename?: string;
    contentHash?: string;
  } = {}
): FactCandidate[] {
  if (!text || typeof text !== "string") return [];
  const out: FactCandidate[] = [];
  const seen = new Set<number>(); // dedupe by trigger start position

  for (const trig of TRIGGERS) {
    const hits = scanKeywords(text, trig.keywords, { allowArmenianSuffix: true });
    for (const hit of hits) {
      if (seen.has(hit.start)) continue;
      seen.add(hit.start);
      const ctx = buildContext(text, hit.start, hit.end);
      const proposition = buildProposition(text, hit.end);
      out.push({
        proposition: proposition || hit.match,
        category: trig.category,
        materiality: trig.materiality,
        evidenceRef: {
          documentId: opts.documentId,
          page: opts.page,
          section: opts.section || trig.category,
          quote: ctx,
          originalFilename: opts.originalFilename,
          contentHash: opts.contentHash,
        },
      });
    }
  }

  return out;
}
