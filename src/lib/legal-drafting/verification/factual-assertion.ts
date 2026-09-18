// src/lib/legal-drafting/verification/factual-assertion.ts
// Phase 6 — §16 — Factual assertion firewall.
//
// Every factual proposition in a draft section must:
//   1) Reference an internal fact source id (F1, F2…) that exists in the
//      closed DraftingContext. If a proposition has NO source id, the
//      firewall rejects it (or accepts only when the section explicitly
//      marks [SUPPORT_REQUIRED] per §15).
//   2) Reflect the fact's epistemic status in the draft language (§9). The
//      word "established" / "հաստատված" / "установлено" may ONLY be used
//      when the underlying fact has status DOCUMENT_VERIFIED. ALLEGED,
//      DISPUTED, CONTRADICTED, USER_CONFIRMED and UNKNOWN facts must use
//      softer language ("alleged" / "պնդվում է" / "утверждается",
//      "disputed" / "վիճարկվում է" / "оспаривается", etc.).
//
// CRITICAL — §16: "No source = reject or SUPPORT_REQUIRED".
// CRITICAL — §9:  "Draft language must reflect fact status. Never write
//                  'established' for an ALLEGED fact."

import type {
  DraftSection,
  DraftingContext,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §9 — Strong epistemic words. Their use signals that the drafter is treating
// a fact as documentary-verified. They are ONLY permissible when the
// underlying fact's status is DOCUMENT_VERIFIED.
// ---------------------------------------------------------------------------

const STRONG_FACT_WORDS = [
  // Armenian (հայերեն) — "established" / "proven" / "verified"
  "հաստատված",
  "ապացուցված",
  "փաստարկված",
  "հիմնավորված",
  // Russian (русский) — "established" / "proven" / "confirmed"
  "установлено",
  "установлен",
  "установлена",
  "доказано",
  "доказан",
  "подтверждено",
  // English
  "established",
  "proven",
  "verified",
];

// ---------------------------------------------------------------------------
// §9 — Soft epistemic words. Their use signals that the drafter treats the
// fact as a party assertion or unverified claim. They are appropriate for
// ALLEGED / USER_CONFIRMED / DISPUTED / UNKNOWN facts.
// ---------------------------------------------------------------------------

const SOFT_FACT_WORDS = [
  // Armenian — "alleged" / "claimed" / "stated"
  "պնդվում է",
  "հայտարարված",
  "ըստ կողմի",
  "ըստ պաշտպանի",
  "վիճարկվում է",
  "վիճարկելի",
  // Russian
  "утверждается",
  "заявлено",
  "оспаривается",
  "по версии",
  // English
  "alleged",
  "claimed",
  "disputed",
  "contested",
];

const SUPPORT_REQUIRED_MARKER = /\[SUPPORT_REQUIRED\]/i;
const MISSING_INFO_MARKER = /\[MISSING_INFORMATION\]/i;

function hasStrongFactWord(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONG_FACT_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

function hasSoftFactWord(text: string): boolean {
  const lower = text.toLowerCase();
  return SOFT_FACT_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

function hasSupportRequiredMarker(text: string): boolean {
  return SUPPORT_REQUIRED_MARKER.test(text);
}

function hasMissingInformationMarker(text: string): boolean {
  return MISSING_INFO_MARKER.test(text);
}

/** Fact source id shape: F1, F2, F12, ... (§10 — InternalSourceId). */
const FACT_SOURCE_ID_RE = /^F\d+$/;

/**
 * §16 — Verify factual assertions in the draft.
 *
 * Walks every section, extracts fact references, verifies they exist in the
 * closed DraftingContext, and verifies the draft language matches the fact's
 * epistemic status (§9).
 */
export async function verifyFactualAssertions(
  sections: DraftSection[],
  ctx: DraftingContext,
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  // Build a lookup of fact source ids present in the closed context.
  const factById = new Map(ctx.facts.map((f) => [f.sourceId, f]));

  for (const section of sections) {
    const text = section.content?.text ?? "";
    const sourceIds = section.content?.sourceIds ?? [];

    // 1) Every fact source id referenced must exist in ctx.facts.
    const factRefs = sourceIds.filter((sid) => FACT_SOURCE_ID_RE.test(sid));
    for (const sid of factRefs) {
      const fact = factById.get(sid);
      if (!fact) {
        // §16 — No source = reject or SUPPORT_REQUIRED.
        assertions.push({
          type: "FACT_HAS_EVIDENCE",
          passed: false,
          detail: `Section "${section.title}" cites fact ${sid} which is not present in the closed DraftingContext. The AI may not introduce new factual sources (§14). Insert [SUPPORT_REQUIRED] and remove the citation, or relink to an existing fact.`,
          sourceId: sid,
        });
        continue;
      }

      // §9 — Check draft language reflects fact status.
      const textHasStrong = hasStrongFactWord(text);
      const textHasSoft = hasSoftFactWord(text);
      const supportRequired = hasSupportRequiredMarker(text);

      if (fact.status === "DOCUMENT_VERIFIED") {
        // Strong language is permitted. Soft language is also fine.
        assertions.push({
          type: "FACT_HAS_EVIDENCE",
          passed: true,
          detail: `${sid} (DOCUMENT_VERIFIED) cited with status-appropriate language.`,
          sourceId: sid,
        });
      } else if (fact.status === "CONTRADICTED") {
        // Must use disputed / contested language, OR mark [SUPPORT_REQUIRED].
        if (textHasStrong && !textHasSoft && !supportRequired) {
          assertions.push({
            type: "FACT_STATUS_LANGUAGE",
            passed: false,
            detail: `Section "${section.title}" uses established-fact language for ${sid} (status: CONTRADICTED). Use disputed language ("վիճարկվում է" / "оспаривается" / "disputed") or insert [SUPPORT_REQUIRED].`,
            sourceId: sid,
          });
        } else {
          assertions.push({
            type: "FACT_HAS_EVIDENCE",
            passed: true,
            detail: `${sid} (CONTRADICTED) cited with status-appropriate (disputed) language.`,
            sourceId: sid,
          });
        }
      } else if (fact.status === "DISPUTED") {
        if (textHasStrong && !textHasSoft && !supportRequired) {
          assertions.push({
            type: "FACT_STATUS_LANGUAGE",
            passed: false,
            detail: `Section "${section.title}" uses established-fact language for ${sid} (status: DISPUTED). Use disputed language or insert [SUPPORT_REQUIRED].`,
            sourceId: sid,
          });
        } else {
          assertions.push({
            type: "FACT_HAS_EVIDENCE",
            passed: true,
            detail: `${sid} (DISPUTED) cited with status-appropriate language.`,
            sourceId: sid,
          });
        }
      } else {
        // ALLEGED / USER_CONFIRMED / UNKNOWN — must NOT use "established".
        if (textHasStrong && !supportRequired) {
          assertions.push({
            type: "FACT_STATUS_LANGUAGE",
            passed: false,
            detail: `Section "${section.title}" uses established-fact language for ${sid} (status: ${fact.status}). Only DOCUMENT_VERIFIED facts may be called "established" (§9). Use alleged language ("պնդվում է" / "утверждается" / "alleged") or insert [SUPPORT_REQUIRED].`,
            sourceId: sid,
          });
        } else {
          assertions.push({
            type: "FACT_HAS_EVIDENCE",
            passed: true,
            detail: `${sid} (${fact.status}) cited with status-appropriate language.`,
            sourceId: sid,
          });
        }
      }
    }

    // 2) §16 — "No source = reject or SUPPORT_REQUIRED". If a section uses
    //    strong fact language ("established") but cites no fact source id,
    //    it must explicitly mark [SUPPORT_REQUIRED] (§15). Otherwise reject.
    if (factRefs.length === 0 && hasStrongFactWord(text)) {
      if (hasSupportRequiredMarker(text)) {
        assertions.push({
          type: "FACT_HAS_EVIDENCE",
          passed: true,
          detail: `Section "${section.title}" asserts established-fact language without a fact source id, but explicitly marks [SUPPORT_REQUIRED] (§15). Accepted with QUALIFY.`,
          sourceId: undefined,
        });
      } else {
        assertions.push({
          type: "FACT_HAS_EVIDENCE",
          passed: false,
          detail: `Section "${section.title}" asserts established-fact language but cites no fact source id (F1, F2…). The AI may not invent factual support (§14). Insert [SUPPORT_REQUIRED] or cite a fact from the DraftingContext.`,
          sourceId: undefined,
        });
      }
    }

    // 3) §15 — Material information gaps must be marked [MISSING_INFORMATION].
    //    Heuristic: sections of type "facts" / "procedural_history" with empty
    //    body text should carry the marker rather than silent blank prose.
    if (
      (section.sectionType === "facts" ||
        section.sectionType === "procedural_history") &&
      text.trim().length === 0
    ) {
      if (!hasMissingInformationMarker(text)) {
        assertions.push({
          type: "FACT_HAS_EVIDENCE",
          passed: false,
          detail: `Section "${section.title}" (${section.sectionType}) is empty. Mark [MISSING_INFORMATION] (§15) instead of leaving silent blank prose.`,
          sourceId: undefined,
        });
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}
