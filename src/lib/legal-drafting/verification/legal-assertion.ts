// src/lib/legal-drafting/verification/legal-assertion.ts
// Phase 6 — §17 — Legal assertion firewall.
//
// Every substantive legal proposition in a draft section ("the law requires
// X", "the Cassation Court held Y", "the Constitutional Court stated Z",
// "the ECtHR requires W") MUST map to an internal authority source id that
// exists in the closed DraftingContext:
//
//   L1…  — legislation            (ctx.legislation)
//   C1…  — Cassation precedent     (ctx.cassationCases)
//   CC1… — Constitutional Court    (ctx.conCourtCases)
//   E1…  — ECtHR precedent         (ctx.echrCases)
//
// If a section asserts a legal proposition without an authority source id,
// the firewall REJECTS the assertion (§16: "no source = reject or
// SUPPORT_REQUIRED"). Unsupported propositions cannot survive VERIFIED
// status (§17).
//
// CRITICAL — §17: "Every 'law requires / Cassation held / ConCourt stated /
//                  ECtHR requires' maps to authority IDs."
// CRITICAL — §14: "The AI may not introduce new legal sources."

import type {
  DraftSection,
  DraftingContext,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §17 — Legal-assertion trigger phrases. When a section contains any of
// these, it must cite an authority source id (L1, C1, CC1, E1, ...).
// ---------------------------------------------------------------------------

const LEGAL_TRIGGER_PHRASES = [
  // English
  "law requires",
  "statute requires",
  "code requires",
  "cassation held",
  "cassation court held",
  "court of cassation held",
  "concourt stated",
  "constitutional court stated",
  "constitutional court held",
  "echr requires",
  "european court held",
  "ecthr held",
  "ecthr stated",
  "case law establishes",
  "precedent holds",
  "binding precedent",
  "persuasive authority",
  "governing law",
  // Armenian
  "օրենքը պահանջում է",
  "կոդեքսը պահանջում է",
  "վճռաբեկ դատարանը հաստատել է",
  "վճռաբեկության դատարանը եզրակացրել է",
  "սահմանադրական դատարանը նշել է",
  "սահմանադրական դատարանը հաստատել է",
  "մարդու իրավունքների եվրոպական դատարանը պահանջում է",
  "եվրոպական դատարանը հաստատել է",
  "դատական պրակտիկան հաստատում է",
  "գերիշխող նորմ",
  // Russian
  "закон требует",
  "кодекс требует",
  "кассационный суд установил",
  "конституционный суд указал",
  "конституционный суд постановил",
  "ектр требует",
  "европейский суд установил",
  "судебная практика устанавливает",
];

const SUPPORT_REQUIRED_MARKER = /\[SUPPORT_REQUIRED\]/i;

/** Legal authority source id shapes (§10 — InternalSourceId). */
const LEGISLATION_RE = /^L\d+$/;
const CASSATION_RE = /^C\d+$/;
const CONCOURT_RE = /^CC\d+$/;
const ECHR_RE = /^E\d+$/;

function isLegalAuthorityId(sid: string): boolean {
  return (
    LEGISLATION_RE.test(sid) ||
    CASSATION_RE.test(sid) ||
    CONCOURT_RE.test(sid) ||
    ECHR_RE.test(sid)
  );
}

function hasLegalTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return LEGAL_TRIGGER_PHRASES.some((p) => lower.includes(p.toLowerCase()));
}

function hasSupportRequiredMarker(text: string): boolean {
  return SUPPORT_REQUIRED_MARKER.test(text);
}

/**
 * §17 — Verify legal assertions in the draft.
 *
 * Walks every section, detects legal-assertion trigger phrases, verifies the
 * section cites an authority source id that exists in the closed
 * DraftingContext, and verifies the authority's "role" matches the trigger
 * (e.g. "Cassation held" must cite a C\d+ source, "ECtHR requires" must cite
 * an E\d+ source).
 *
 * CRITICAL — §17: "Unsupported proposition cannot survive VERIFIED status."
 */
export async function verifyLegalAssertions(
  sections: DraftSection[],
  ctx: DraftingContext,
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  // Build lookups for each authority type.
  const legislationById = new Map(ctx.legislation.map((l) => [l.sourceId, l]));
  const cassationById = new Map(ctx.cassationCases.map((c) => [c.sourceId, c]));
  const concourtById = new Map(ctx.conCourtCases.map((c) => [c.sourceId, c]));
  const echrById = new Map(ctx.echrCases.map((e) => [e.sourceId, e]));

  for (const section of sections) {
    const text = section.content?.text ?? "";
    const sourceIds = section.content?.sourceIds ?? [];

    const legalRefs = sourceIds.filter(isLegalAuthorityId);

    // 1) Every cited authority id must exist in ctx.
    for (const sid of legalRefs) {
      let exists = false;
      let authorityKind: "legislation" | "cassation" | "concourt" | "echr" | null = null;

      if (LEGISLATION_RE.test(sid)) {
        exists = legislationById.has(sid);
        authorityKind = "legislation";
      } else if (CASSATION_RE.test(sid)) {
        exists = cassationById.has(sid);
        authorityKind = "cassation";
      } else if (CONCOURT_RE.test(sid)) {
        exists = concourtById.has(sid);
        authorityKind = "concourt";
      } else if (ECHR_RE.test(sid)) {
        exists = echrById.has(sid);
        authorityKind = "echr";
      }

      if (!exists) {
        assertions.push({
          type: "LEGAL_AUTHORITY_EXISTS",
          passed: false,
          detail: `Section "${section.title}" cites authority ${sid} which is not present in the closed DraftingContext. The AI may not introduce new legal sources (§14). Insert [SUPPORT_REQUIRED] or relink to an existing authority.`,
          sourceId: sid,
        });
      } else {
        assertions.push({
          type: "LEGAL_AUTHORITY_EXISTS",
          passed: true,
          detail: `${sid} (${authorityKind}) cited and present in context.`,
          sourceId: sid,
        });
      }
    }

    // 2) §17 — If a section uses a legal-assertion trigger phrase, it must
    //    cite at least one authority source id OR explicitly mark
    //    [SUPPORT_REQUIRED] (§15). Otherwise reject.
    if (hasLegalTrigger(text) && legalRefs.length === 0) {
      if (hasSupportRequiredMarker(text)) {
        assertions.push({
          type: "LEGAL_AUTHORITY_EXISTS",
          passed: true,
          detail: `Section "${section.title}" uses legal-assertion language but cites no authority source id; explicitly marked [SUPPORT_REQUIRED] (§15). Accepted with QUALIFY.`,
          sourceId: undefined,
        });
      } else {
        assertions.push({
          type: "LEGAL_AUTHORITY_EXISTS",
          passed: false,
          detail: `Section "${section.title}" asserts a legal proposition ("law requires / Cassation held / ConCourt stated / ECtHR requires") without citing an authority source id (L1, C1, CC1, E1, ...). The AI may not invent legal support (§14, §17). Insert [SUPPORT_REQUIRED] or cite an authority from the DraftingContext.`,
          sourceId: undefined,
        });
      }
    }

    // 3) §17 — Authority "kind" must match the trigger. If a section says
    //    "Cassation held", it must cite a C\d+ source. If "ECtHR requires",
    //    it must cite an E\d+ source. Mismatches are QUALIFY (not hard
    //    reject) because the drafter may cite multiple authorities.
    const lowerText = text.toLowerCase();
    if (lowerText.includes("cassation") || lowerText.includes("վճռաբեկ")) {
      const hasCassationRef = legalRefs.some((s) => CASSATION_RE.test(s));
      if (!hasCassationRef && !hasSupportRequiredMarker(text)) {
        assertions.push({
          type: "LEGAL_AUTHORITY_KIND_MATCH",
          passed: false,
          detail: `Section "${section.title}" references the Cassation Court but cites no C\\d+ source id. Cite a Cassation precedent from the DraftingContext (or mark [SUPPORT_REQUIRED]).`,
          sourceId: undefined,
        });
      }
    }
    if (lowerText.includes("constitutional court") || lowerText.includes("սահմանադրական դատարան")) {
      const hasConcourtRef = legalRefs.some((s) => CONCOURT_RE.test(s));
      if (!hasConcourtRef && !hasSupportRequiredMarker(text)) {
        assertions.push({
          type: "LEGAL_AUTHORITY_KIND_MATCH",
          passed: false,
          detail: `Section "${section.title}" references the Constitutional Court but cites no CC\\d+ source id. Cite a ConCourt precedent from the DraftingContext (or mark [SUPPORT_REQUIRED]).`,
          sourceId: undefined,
        });
      }
    }
    if (
      lowerText.includes("echr") ||
      lowerText.includes("ecthr") ||
      lowerText.includes("european court") ||
      lowerText.includes("եվրոպական դատարան") ||
      lowerText.includes("մարդու իրավունքների եվրոպական")
    ) {
      const hasEchrRef = legalRefs.some((s) => ECHR_RE.test(s));
      if (!hasEchrRef && !hasSupportRequiredMarker(text)) {
        assertions.push({
          type: "LEGAL_AUTHORITY_KIND_MATCH",
          passed: false,
          detail: `Section "${section.title}" references the ECtHR but cites no E\\d+ source id. Cite an ECtHR precedent from the DraftingContext (or mark [SUPPORT_REQUIRED]).`,
          sourceId: undefined,
        });
      }
    }

    // 4) §17 — Unsupported proposition cannot survive VERIFIED status. We
    //    flag a SECTION_CANNOT_VERIFY warning on the section (handled by the
    //    review-model downstream). Here we just emit the assertion; the
    //    final review status is set by updateSectionReview.
    if (
      section.reviewStatus === "VERIFIED" &&
      hasLegalTrigger(text) &&
      legalRefs.length === 0 &&
      !hasSupportRequiredMarker(text)
    ) {
      assertions.push({
        type: "SECTION_CANNOT_VERIFY",
        passed: false,
        detail: `Section "${section.title}" is marked VERIFIED but contains an unsupported legal proposition. Downgrade to NEEDS_SUPPORT.`,
        sourceId: undefined,
      });
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}
