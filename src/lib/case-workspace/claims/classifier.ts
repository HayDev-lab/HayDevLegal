// src/lib/case-workspace/claims/classifier.ts
//
// §12 — Claim classifier. Given a proposition, return its ClaimType + a
// confidence score in [0..1].
//
// Heuristic-based: keyword / phrase patterns. confidence is the ratio of
// matched trigger tokens over total proposition tokens (bounded to [0..1]).

import type { ClaimType } from "../analysis-types";

export type ClassifyLanguage = "hy" | "ru" | "en";

interface Rule {
  keywords: string[];
  claimType: ClaimType;
}

// Reuse the same trigger tables from the extractor (kept local for
// standalone import — extractor.ts also defines a similar table).
const RULES: Rule[] = [
  // Armenian
  {
    claimType: "DEFENDANT",
    keywords: [
      "մեղադրյալը նշում է",
      "մեղադրյալը պնդում է",
      "պաշտպանության դիրքորոշումն է",
      "պաշտպանը",
    ],
  },
  {
    claimType: "APPLICANT",
    keywords: ["հայցվորը նշում է", "հայցվորը պնդում է", "հայցվորը"],
  },
  {
    claimType: "PROSECUTION",
    keywords: ["դատախազությունը", "դատախազը նշում է", "մեղադրանք է առաջադրվել"],
  },
  {
    claimType: "GOVERNMENT",
    keywords: ["պետության դատախազը", "պետական մեղադրողը"],
  },
  {
    claimType: "WITNESS",
    keywords: ["վկան ցույզ է տալիս", "վկան ցույց է տալիս", "վկան ցույց տվեց", "վկան"],
  },
  {
    claimType: "EXPERT",
    keywords: [
      "փորձագետի եզրակացությամբ",
      "փորձագիտական եզրակացություն",
      "փորձագետը",
    ],
  },
  {
    claimType: "LOWER_COURT",
    keywords: [
      "առաջին ատյանի դատարանը եզրակացնում է",
      "ստորին ատյանը որոշեց",
      "առաջին ատյանի",
    ],
  },
  {
    claimType: "COURT_FINDING",
    keywords: [
      "դատարանը եզրակացնում է",
      "դատարանը վճռեց",
      "դատարանի եզրակացությամբ",
      "դատարանը հաստատեց",
    ],
  },
  // Russian
  {
    claimType: "DEFENDANT",
    keywords: [
      "подсудимый указывает",
      "подсудимый утверждает",
      "позиция защиты",
      "адвокат указывает",
      "адвокат утверждает",
    ],
  },
  {
    claimType: "APPLICANT",
    keywords: ["истец указывает", "истец утверждает", "заявитель указывает"],
  },
  {
    claimType: "PROSECUTION",
    keywords: [
      "прокуратура утверждает",
      "прокурор указывает",
      "государственный обвинитель",
    ],
  },
  {
    claimType: "GOVERNMENT",
    keywords: ["государственный прокурор"],
  },
  {
    claimType: "WITNESS",
    keywords: ["свидетель показывает", "свидетель показал", "свидетель"],
  },
  {
    claimType: "EXPERT",
    keywords: [
      "по заключению эксперта",
      "экспертное заключение",
      "эксперт",
    ],
  },
  {
    claimType: "LOWER_COURT",
    keywords: [
      "суд первой инстанции заключает",
      "суд первой инстанции постановил",
      "суд первой инстанции",
    ],
  },
  {
    claimType: "COURT_FINDING",
    keywords: [
      "суд заключает",
      "суд постановил",
      "суд установил",
      "судом установлено",
      "судебное решение",
    ],
  },
  // English
  {
    claimType: "DEFENDANT",
    keywords: [
      "defendant claims",
      "defendant asserts",
      "defense position is",
      "defense counsel argues",
    ],
  },
  {
    claimType: "APPLICANT",
    keywords: ["plaintiff claims", "applicant asserts"],
  },
  {
    claimType: "PROSECUTION",
    keywords: [
      "prosecution argues",
      "prosecutor asserts",
      "the prosecution claims",
    ],
  },
  {
    claimType: "GOVERNMENT",
    keywords: ["state prosecutor", "government argues"],
  },
  {
    claimType: "WITNESS",
    keywords: ["witness testifies", "witness testified", "witness"],
  },
  {
    claimType: "EXPERT",
    keywords: [
      "according to the expert",
      "expert conclusion",
      "expert opinion",
      "expert",
    ],
  },
  {
    claimType: "LOWER_COURT",
    keywords: [
      "trial court held",
      "court of first instance held",
      "trial court",
    ],
  },
  {
    claimType: "COURT_FINDING",
    keywords: [
      "court finds",
      "court found",
      "court holds",
      "court held",
      "court concludes",
      "court concluded",
      "court ruled",
      "court rules",
      "court established",
      "the court established",
      "the court found",
      "the court held",
    ],
  },
];

function tokenizeCount(text: string): number {
  const re = /[\p{L}\p{N}]+/gu;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length > 2) n++;
  }
  return Math.max(n, 1);
}

/**
 * §12 — Classify a proposition by its phrasing.
 *
 * CRITICAL: COURT_FINDING is ONLY returned when an explicit court-holding
 * phrase is present. A party submission ("defendant claims X") is never
 * classified as COURT_FINDING.
 */
export function classifyClaim(
  proposition: string,
  _language: ClassifyLanguage = "en"
): { claimType: ClaimType; confidence: number } {
  if (!proposition) return { claimType: "OTHER", confidence: 0 };
  const lower = proposition.toLowerCase();
  const totalTokens = tokenizeCount(proposition);

  let best: { claimType: ClaimType; confidence: number } = {
    claimType: "OTHER",
    confidence: 0,
  };

  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      const kwLower = kw.toLowerCase();
      if (!lower.includes(kwLower)) continue;
      // Confidence = matched keyword tokens / proposition tokens (capped).
      const kwTokens = Math.max(tokenizeCount(kw), 1);
      const score = Math.min(1, kwTokens / totalTokens);
      if (score > best.confidence) {
        best = { claimType: rule.claimType, confidence: score };
      }
    }
  }

  // Bias COURT_FINDING rules above other rules when present: if both a
  // COURT_FINDING phrase and a party-submission phrase appear in the same
  // proposition (unlikely but defensive), prefer COURT_FINDING — never
  // treat a party submission as a court holding.
  for (const rule of RULES) {
    if (rule.claimType !== "COURT_FINDING") continue;
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        const kwTokens = Math.max(tokenizeCount(kw), 1);
        const score = Math.min(1, kwTokens / totalTokens);
        if (score > 0 && best.claimType !== "COURT_FINDING") {
          best = { claimType: "COURT_FINDING", confidence: score };
        }
      }
    }
  }

  return best;
}
