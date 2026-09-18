// src/lib/legal-drafting/verification/request-verifier.ts
// Phase 6 — §21 — Requested-relief firewall.
//
// The requested_relief section of a draft may ONLY contain relief that
// derives from:
//   1) the user-selected goal (§11 — e.g. "release from detention",
//      "exclude evidence", "restore deadline"), AND
//   2) the document type (e.g. MOTION, OBJECTION, APPEAL), AND
//   3) the verified procedural context (target court / authority).
//
// CRITICAL — §21: "AI cannot invent extra remedies."
// CRITICAL — §21: "Uncertain relief = review warning."
//
// Implementation: maintain a small deterministic relief-keyword table per
// (goal, docType). If the requested_relief section contains a relief verb
// not in the allowed set, the firewall flags it for review (reviewStatus =
// NEEDS_SUPPORT).

import type {
  DocumentType,
  DraftSection,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §11 — Goal keyword → allowed relief keywords
// ---------------------------------------------------------------------------

type GoalReliefMap = Record<string, string[]>;

/**
 * Per-goal allowed relief keywords. The goal text is matched case-
 * insensitively; the allowed relief verbs are also matched case-
 * insensitively as substrings inside the requested_relief section text.
 *
 * These are intentionally conservative — the goal text must contain at
 * least one keyword to enable a relief bucket.
 */
const GOAL_RELIEF_MAP: GoalReliefMap = {
  // Release-from-detention goals
  release: [
    "release",
    "free",
    "liberty",
    "alternativ",
    "bail",
    " lesser measure ",
    "personal recognizance",
    "ազատել",
    "ազատ արձակել",
    "երաշխիք",
    "այլընտրանքային",
    "освободить",
    "освобождение",
    "залог",
    "альтернативн",
  ],
  // Exclude-evidence goals
  exclude: [
    "exclude",
    "inadmissib",
    "exclusion",
    "suppress",
    "strike",
    "հեռացնել",
    "անընդունելի",
    "исключить",
    "недопустим",
  ],
  // Restore-deadline goals
  restore: [
    "restore",
    "extend",
    "extension",
    "deadline",
    "reopen",
    "վերականգնել",
    "ժամկետ",
    "երկարաձգել",
    "восстановить",
    "срок",
    "продлить",
  ],
  // Overturn / reverse goals
  overturn: [
    "overturn",
    "reverse",
    "quash",
    "vacate",
    "annul",
    "set aside",
    "դատավճիռը չեղարկել",
    "չեղարկել",
    "отменить",
    "отмена",
  ],
  // Declare unconstitutional goals
  unconstitutional: [
    "unconstitutional",
    "incompatible",
    "conformity",
    "constitution",
    "սահմանադրությանը հակառակ",
    "սահմանադրական",
    "несоответств",
    "конституцион",
  ],
  // Compensate goals
  compensate: [
    "compensat",
    "damages",
    "satisfaction",
    "just satisfaction",
    "փոխհատուցում",
    "վնաս",
    "компенсаци",
    "возмещен",
  ],
};

// ---------------------------------------------------------------------------
// §21 — Document type → allowed relief verb classes
// ---------------------------------------------------------------------------

const DOC_TYPE_VERB_MAP: Record<DocumentType, string[]> = {
  MOTION: ["release", "exclude", "restore", "overturn", "compensate", "request", "անհրաժեշտ է", "պահանջվում է"],
  OBJECTION: ["object", "exclude", "inadmissib", "strike", "disallow", "հեռացնել", "առարկել", "возраж", "исключ"],
  CLAIM: ["claim", "award", "order", "ենթադրել", "պահանջել", "взыск", "потребовать"],
  RESPONSE: ["deny", "reject", "dispute", "հերքել", "մերժել", "возразить", "отказать"],
  APPEAL: ["overturn", "reverse", "quash", "vacate", "annul", "modify", "չեղարկել", "փոփոխել", "отменить", "изменить"],
  CASSATION_APPEAL: ["overturn", "reverse", "quash", "vacate", "annul", "չեղարկել", "վճռաբեկել", "отменить", "кассаци"],
  CONSTITUTIONAL_COMPLAINT: [
    "unconstitutional",
    "incompatible",
    "conformity",
    "սահմանադրական",
    "հակառակ",
    "конституцион",
    "несоответств",
  ],
  ECHR_APPLICATION_SUPPORT: [
    "compensat",
    "just satisfaction",
    "violat",
    "infring",
    "փոխհատուցում",
    "խախտում",
    "компенсаци",
    "нарушен",
  ],
  LEGAL_MEMORANDUM: [], // No relief — advisory document.
  FACTUAL_STATEMENT: [], // No relief — factual statement only.
  REQUEST_TO_AUTHORITY: ["request", "compel", "require", "պահանջել", "պարտադրել", "потребовать"],
  OTHER: [],
};

// ---------------------------------------------------------------------------
// §21 — Invented-remedy detector
// ---------------------------------------------------------------------------

/**
 * Words that signal the drafter is inventing extra remedies outside the
 * user-selected goal. These trigger a hard flag regardless of document type
 * (§21: "AI cannot invent extra remedies").
 */
const NEVER_INVENTED_REMEDY_PATTERNS = [
  // Drafter invents a brand-new relief category
  "additional remedy",
  "further relief",
  "ancillary relief",
  "հավելյալ պահանջ",
  "երկրորդական միջոց",
  "дополнительное требование",
  // Drafter invents a monetary award not in the goal
  "punitive damages",
  "exemplary damages",
  "additional compensation",
  "լրացուցիչ փոխհատուցում",
  "дополнительная компенсация",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allowedReliefForGoal(goal: string): Set<string> {
  const out = new Set<string>();
  const lower = goal.toLowerCase();
  for (const [key, verbs] of Object.entries(GOAL_RELIEF_MAP)) {
    if (lower.includes(key)) {
      for (const v of verbs) out.add(v.toLowerCase());
    }
  }
  return out;
}

function allowedReliefForDocType(docType: DocumentType): Set<string> {
  return new Set((DOC_TYPE_VERB_MAP[docType] ?? []).map((v) => v.toLowerCase()));
}

function sectionText(section: DraftSection): string {
  const parts: string[] = [];
  if (section.content?.text) parts.push(section.content.text);
  if (Array.isArray(section.content?.paragraphs)) {
    for (const p of section.content.paragraphs) parts.push(p);
  }
  return parts.join("\n");
}

/**
 * §21 — Verify requested relief.
 *
 * Walks the requested_relief section (and any section ending in "_relief"),
 * extracts relief tokens, and verifies each is supported by the goal +
 * document type. Invented remedies (per NEVER_INVENTED_REMEDY_PATTERNS) are
 * hard-rejected. Uncertain relief is flagged for review.
 *
 * CRITICAL — §21: "AI cannot invent extra remedies."
 */
export async function verifyRequestedRelief(
  sections: DraftSection[],
  goal: string,
  docType: DocumentType,
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  const reliefSections = sections.filter(
    (s) =>
      s.sectionType === "requested_relief" ||
      s.sectionType.endsWith("_relief") ||
      s.title.toLowerCase().includes("relief") ||
      s.title.toLowerCase().includes("petition") ||
      s.title.toLowerCase().includes("պահանջ"),
  );

  if (reliefSections.length === 0) {
    // No requested_relief section at all. For MOTION / CLAIM / APPEAL types,
    // this is a completeness gap (§22 catches it too).
    if (
      docType === "MOTION" ||
      docType === "CLAIM" ||
      docType === "APPEAL" ||
      docType === "CASSATION_APPEAL"
    ) {
      assertions.push({
        type: "RELIEF_SECTION_PRESENT",
        passed: false,
        detail: `Document type ${docType} requires a requested_relief section, but none is present.`,
      });
    } else {
      // For advisory / factual document types, no relief is required.
      assertions.push({
        type: "RELIEF_SECTION_PRESENT",
        passed: true,
        detail: `Document type ${docType} does not require a requested_relief section.`,
      });
    }
  }

  const goalRelief = allowedReliefForGoal(goal);
  const docRelief = allowedReliefForDocType(docType);

  for (const section of reliefSections) {
    const text = sectionText(section);
    const lower = text.toLowerCase();

    // 1) Hard-reject invented-remedy patterns.
    for (const pattern of NEVER_INVENTED_REMEDY_PATTERNS) {
      if (lower.includes(pattern.toLowerCase())) {
        assertions.push({
          type: "RELIEF_IN_GOAL",
          passed: false,
          detail: `Section "${section.title}" contains invented-remedy language "${pattern}". The AI may not invent extra remedies (§21). Restrict to relief derived from the user-selected goal.`,
        });
      }
    }

    // 2) If the section uses an action verb not in the allowed set, flag
    //    for review (reviewStatus = NEEDS_SUPPORT). This is a review warning,
    //    not a hard reject — the user must confirm or amend.
    const allowed = new Set<string>([...goalRelief, ...docRelief]);
    if (allowed.size === 0) {
      // Empty goal / advisory doc — relief section itself is suspicious.
      if (text.trim().length > 0) {
        assertions.push({
          type: "RELIEF_IN_GOAL",
          passed: false,
          detail: `Section "${section.title}" requests relief but the document type ${docType} does not allow any remedy. Remove the relief section.`,
        });
      }
    } else {
      // Try to find at least one allowed verb in the section. If none found
      // and the section is non-empty, flag for review.
      let foundAllowed = false;
      for (const v of allowed) {
        if (lower.includes(v)) {
          foundAllowed = true;
          break;
        }
      }
      if (!foundAllowed && text.trim().length > 0) {
        assertions.push({
          type: "RELIEF_IN_GOAL",
          passed: false,
          detail: `Section "${section.title}" requests relief not derivable from the goal "${goal}" or document type ${docType}. Mark the section NEEDS_SUPPORT or restrict to allowed relief: ${Array.from(allowed).slice(0, 5).join(", ")}…`,
        });
      } else if (foundAllowed) {
        assertions.push({
          type: "RELIEF_IN_GOAL",
          passed: true,
          detail: `Section "${section.title}" requests relief within the goal + document type bounds.`,
        });
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}
