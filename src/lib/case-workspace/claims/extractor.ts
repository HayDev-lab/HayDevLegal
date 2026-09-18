// src/lib/case-workspace/claims/extractor.ts
//
// §12 — Claim extractor. Detects party claims (defendant / prosecution /
// government / witness / expert / lower-court) AND court findings.
//
// CRITICAL (§12): Never treat party submission as court holding —
// COURT_FINDING is distinct from DEFENDANT/PROSECUTION/etc. claims.
//
// Trigger phrases (Armenian / Russian / English) drive the classification.
// Conservative: when no trigger matches, no candidate is emitted (we don't
// fabricate claims out of arbitrary sentences).

import type { ClaimType, EvidenceRef } from "../analysis-types";
import { scanKeywords } from "../shared/keyword-scanner";

export type ClaimLanguage = "hy" | "ru" | "en" | "auto";

export interface ClaimCandidate {
  proposition: string;
  claimType: ClaimType;
  source: EvidenceRef;
}

interface ClaimTrigger {
  keywords: string[];
  claimType: ClaimType;
}

const TRIGGERS: ClaimTrigger[] = [
  // Armenian — defendant
  {
    keywords: [
      "մեղադրյալը նշում է",
      "մեղադրյալը պնդում է",
      "պաշտպանության դիրքորոշումն է",
      "պաշտպանը նշում է",
      "պաշտպանը պնդում է",
    ],
    claimType: "DEFENDANT",
  },
  // Armenian — applicant (civil/administrative)
  {
    keywords: ["հայցվորը նշում է", "հայցվորը պնդում է"],
    claimType: "APPLICANT",
  },
  // Armenian — prosecution
  {
    keywords: [
      "դատախազությունը պնդում է",
      "դատախազը նշում է",
      "դատախազության կողմից առաջադրված",
      "մեղադրանք է առաջադրվել",
    ],
    claimType: "PROSECUTION",
  },
  // Armenian — government
  {
    keywords: ["պետության դատախազը", "պետական մեղադրողը"],
    claimType: "GOVERNMENT",
  },
  // Armenian — witness
  {
    keywords: ["վկան ցույզ է տալիս", "վկան ցույց է տալիս", "վկան ցույց տվեց"],
    claimType: "WITNESS",
  },
  // Armenian — expert
  {
    keywords: ["փորձագետի եզրակացությամբ", "փորձագիտական եզրակացությունը նշում է"],
    claimType: "EXPERT",
  },
  // Armenian — lower court
  {
    keywords: ["առաջին ատյանի դատարանը եզրակացնում է", "ստորին ատյանը որոշեց"],
    claimType: "LOWER_COURT",
  },
  // Armenian — court finding (DISTINCT from defendant/prosecution claims!)
  {
    keywords: [
      "դատարանը եզրակացնում է",
      "դատարանը վճռեց",
      "դատարանի եզրակացությամբ",
      "դատարանը հաստատեց",
    ],
    claimType: "COURT_FINDING",
  },
  // Russian — defendant
  {
    keywords: [
      "подсудимый указывает",
      "подсудимый утверждает",
      "позиция защиты",
      "адвокат указывает",
      "адвокат утверждает",
    ],
    claimType: "DEFENDANT",
  },
  // Russian — applicant
  {
    keywords: ["истец указывает", "истец утверждает", "заявитель указывает"],
    claimType: "APPLICANT",
  },
  // Russian — prosecution
  {
    keywords: [
      "прокуратура утверждает",
      "прокурор указывает",
      "государственный обвинитель",
      "предъявлено обвинение",
    ],
    claimType: "PROSECUTION",
  },
  // Russian — government
  {
    keywords: ["государственный прокурор"],
    claimType: "GOVERNMENT",
  },
  // Russian — witness
  {
    keywords: ["свидетель показывает", "свидетель показал"],
    claimType: "WITNESS",
  },
  // Russian — expert
  {
    keywords: ["по заключению эксперта", "экспертное заключение"],
    claimType: "EXPERT",
  },
  // Russian — lower court
  {
    keywords: ["суд первой инстанции заключает", "суд первой инстанции постановил"],
    claimType: "LOWER_COURT",
  },
  // Russian — court finding (DISTINCT from defendant/prosecution claims!)
  {
    keywords: [
      "суд заключает",
      "суд постановил",
      "суд установил",
      "судом установлено",
      "судебное решение",
    ],
    claimType: "COURT_FINDING",
  },
  // English — defendant
  {
    keywords: [
      "defendant claims",
      "defendant asserts",
      "defense position is",
      "defense counsel argues",
    ],
    claimType: "DEFENDANT",
  },
  // English — applicant
  {
    keywords: ["plaintiff claims", "applicant asserts"],
    claimType: "APPLICANT",
  },
  // English — prosecution
  {
    keywords: [
      "prosecution argues",
      "prosecutor asserts",
      "the prosecution claims",
    ],
    claimType: "PROSECUTION",
  },
  // English — government
  {
    keywords: ["state prosecutor", "government argues"],
    claimType: "GOVERNMENT",
  },
  // English — witness
  {
    keywords: ["witness testifies", "witness testified"],
    claimType: "WITNESS",
  },
  // English — expert
  {
    keywords: [
      "according to the expert",
      "expert conclusion",
      "expert opinion",
    ],
    claimType: "EXPERT",
  },
  // English — lower court
  {
    keywords: ["trial court held", "court of first instance held"],
    claimType: "LOWER_COURT",
  },
  // English — court finding (DISTINCT from party submissions!)
  {
    keywords: [
      "court finds",
      "court holds",
      "court concludes",
      "court ruled",
      "the court established",
    ],
    claimType: "COURT_FINDING",
  },
];

function buildProposition(text: string, triggerEnd: number): string {
  // Find the sentence containing the trigger keyword (up to ~250 chars).
  const boundaries = /[.!?\u0589]/;
  let start = triggerEnd;
  while (start > 0 && !boundaries.test(text[start - 1] ?? "")) start--;
  let end = triggerEnd;
  while (end < text.length && !boundaries.test(text[end] ?? "")) end++;
  if (end < text.length) end++; // include boundary punctuation
  const sentence = text.slice(start, end).replace(/\s+/g, " ").trim();
  return sentence.length > 250 ? sentence.slice(0, 247) + "…" : sentence;
}

function buildContext(text: string, idx: number, end: number): string {
  const start = Math.max(0, idx - 80);
  const stop = Math.min(text.length, end + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = stop < text.length ? "…" : "";
  return (
    prefix + text.slice(start, stop).replace(/\s+/g, " ").trim() + suffix
  );
}

/**
 * §12 — Extract claim candidates from text.
 *
 * CRITICAL (§12): never treat party submission as court holding —
 * COURT_FINDING is only emitted when the explicit "court finds/holds/concludes"
 * phrasing is present.
 *
 * Returns an array of candidates with proposition / claimType / source.
 */
export function extractClaims(
  text: string,
  documentId: string,
  pageNumber: number,
  _language: ClaimLanguage = "auto"
): ClaimCandidate[] {
  if (!text || typeof text !== "string") return [];
  if (!documentId) return [];

  const out: ClaimCandidate[] = [];
  const seen = new Set<number>(); // dedupe by trigger start

  for (const trig of TRIGGERS) {
    const hits = scanKeywords(text, trig.keywords, { allowArmenianSuffix: true });
    for (const hit of hits) {
      if (seen.has(hit.start)) continue;
      seen.add(hit.start);
      const proposition = buildProposition(text, hit.end);
      const ctx = buildContext(text, hit.start, hit.end);
      out.push({
        proposition: proposition || hit.match,
        claimType: trig.claimType,
        source: {
          documentId,
          page: pageNumber,
          quote: ctx,
          section: trig.claimType,
        },
      });
    }
  }

  return out;
}
