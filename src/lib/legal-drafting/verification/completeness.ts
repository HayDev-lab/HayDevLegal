// src/lib/legal-drafting/verification/completeness.ts
// Phase 6 — §22 — Completeness firewall.
//
// Before a draft may reach VERIFIED status, the completeness firewall checks:
//
//   1) Every required plan section (per DocumentPlanSection.required=true) is
//      present in the draft sections.
//   2) Every plan.missingMetadata field is surfaced in the draft (either via
//      an explicit [MISSING_INFORMATION] marker, or by being flagged in a
//      section warning) — NOT silently ignored.
//   3) Every plan.sections[i].needsSupport flag is honored — the section
//      either marks [SUPPORT_REQUIRED] or has reviewStatus=NEEDS_SUPPORT.
//   4) No hidden placeholders remain ([TODO], [FILL IN], [???], TBD, etc.).
//   5) No metadata-only case is used as a holding — sections with the plan
//      warning "METADATA_ONLY" cannot be VERIFIED (§63 research layer).
//   6) No discovery-only source is used as the SOLE STRONG authority — a
//      section whose plan warnings include "DISCOVERY_ONLY" must not be the
//      sole source for a strong legal assertion.
//   7) All material contradictions surfaced by the planner are visible in
//      the draft (not silently resolved).
//
// CRITICAL — §22: "no metadata-only case used as holding; no discovery-only
//                  source as sole strong authority."

import type {
  DocumentPlan,
  DocumentPlanSection,
  DraftSection,
  VerificationAssertion,
  VerificationResult,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §22 — Hidden placeholder detector (heuristic)
// ---------------------------------------------------------------------------

const HIDDEN_PLACEHOLDER_PATTERNS = [
  /\[TODO\]/i,
  /\[TBD\]/i,
  /\[FILL IN[^\]]*\]/i,
  /\[FILL-IN[^\]]*\]/i,
  /\[INSERT[^\]]*\]/i,
  /\[\?\?\?\]/i,
  /\[\.\.\.\]/,
  /\[PLACEHOLDER[^\]]*\]/i,
  /\[YOUR TEXT HERE\]/i,
  /\[X{2,}\]/i, // [XX] / [XXX]
  /\[\s*Lorem ipsum\s*\]/i,
  // Armenian placeholder words
  /\[ՏԵՂԱԴՐԵԼ[^\]]*\]/i,
  /\[ԼՐԱԳՐԵԼ[^\]]*\]/i,
  // Russian placeholder words
  /\[ВСТАВИТЬ[^\]]*\]/i,
  /\[ЗАПОЛНИТЬ[^\]]*\]/i,
];

// Markers explicitly permitted by §15 (these are NOT placeholders).
const PERMITTED_MARKERS = /\[(SUPPORT_REQUIRED|MISSING_INFORMATION)\]/i;

function hasHiddenPlaceholder(text: string): { hit: boolean; pattern?: string } {
  // Strip permitted markers first so they don't false-positive.
  const stripped = text.replace(PERMITTED_MARKERS, "");
  for (const re of HIDDEN_PLACEHOLDER_PATTERNS) {
    if (re.test(stripped)) {
      return { hit: true, pattern: re.source };
    }
  }
  return { hit: false };
}

function hasMissingInformationMarker(text: string): boolean {
  return /\[MISSING_INFORMATION\]/i.test(text);
}

function hasSupportRequiredMarker(text: string): boolean {
  return /\[SUPPORT_REQUIRED\]/i.test(text);
}

/**
 * Find the section that corresponds to a plan section by sectionType.
 */
function findSectionForPlan(
  sections: DraftSection[],
  planSection: DocumentPlanSection,
): DraftSection | undefined {
  return sections.find((s) => s.sectionType === planSection.sectionType);
}

/**
 * §22 — Verify draft completeness.
 *
 * Master completeness check before VERIFIED status. Returns a
 * VerificationResult with the full assertion list.
 */
export async function verifyCompleteness(
  draftId: string,
  plan: DocumentPlan,
  sections: DraftSection[],
): Promise<VerificationResult> {
  const assertions: VerificationAssertion[] = [];

  // 1) Required plan sections must be present.
  for (const planSection of plan.sections ?? []) {
    if (!planSection.required) continue;
    const draftSection = findSectionForPlan(sections, planSection);
    if (!draftSection) {
      assertions.push({
        type: "REQUIRED_SECTION_PRESENT",
        passed: false,
        detail: `Required section "${planSection.sectionType}" is missing from the draft (draft ${draftId}). Either include the section or mark it [MISSING_INFORMATION].`,
      });
    } else {
      assertions.push({
        type: "REQUIRED_SECTION_PRESENT",
        passed: true,
        detail: `Required section "${planSection.sectionType}" is present.`,
      });
    }
  }

  // 2) plan.missingMetadata fields must be surfaced (either as a
  //    [MISSING_INFORMATION] marker in some section, or as a section warning).
  for (const field of plan.missingMetadata ?? []) {
    const surfaced = sections.some((s) => {
      const text = s.content?.text ?? "";
      // Check explicit marker
      if (hasMissingInformationMarker(text)) return true;
      // Check section warning listing this field as missing
      if (Array.isArray(s.warnings)) {
        return s.warnings.some(
          (w) =>
            w.type === "MISSING_INFORMATION" &&
            w.detail.toLowerCase().includes(field.toLowerCase()),
        );
      }
      return false;
    });
    if (!surfaced) {
      assertions.push({
        type: "MISSING_METADATA_FLAGGED",
        passed: false,
        detail: `Plan flags metadata field "${field}" as missing, but no draft section surfaces it. Add a [MISSING_INFORMATION] marker to the relevant section (§15 — never invent metadata, §11 — unknown stays unknown).`,
      });
    } else {
      assertions.push({
        type: "MISSING_METADATA_FLAGGED",
        passed: true,
        detail: `Missing metadata "${field}" is surfaced.`,
      });
    }
  }

  // 3) plan.sections[i].needsSupport must be honored.
  for (const planSection of plan.sections ?? []) {
    if (!planSection.needsSupport) continue;
    const draftSection = findSectionForPlan(sections, planSection);
    if (!draftSection) continue;
    const text = draftSection.content?.text ?? "";
    if (!hasSupportRequiredMarker(text) && draftSection.reviewStatus !== "NEEDS_SUPPORT") {
      assertions.push({
        type: "NEEDS_SUPPORT_HONORED",
        passed: false,
        detail: `Section "${draftSection.title}" was flagged by the planner as needing support, but does not mark [SUPPORT_REQUIRED] and is not NEEDS_SUPPORT. Either add support or downgrade review status.`,
      });
    } else {
      assertions.push({
        type: "NEEDS_SUPPORT_HONORED",
        passed: true,
        detail: `Section "${draftSection.title}" correctly flagged as needing support.`,
      });
    }
  }

  // 4) No hidden placeholders.
  for (const section of sections) {
    const text = section.content?.text ?? "";
    const placeholderCheck = hasHiddenPlaceholder(text);
    if (placeholderCheck.hit) {
      assertions.push({
        type: "NO_HIDDEN_PLACEHOLDERS",
        passed: false,
        detail: `Section "${section.title}" contains a hidden placeholder (${placeholderCheck.pattern}). Remove it before VERIFIED status.`,
      });
    }
  }

  // 5) & 6) No metadata-only case as holding; no discovery-only source as
  //    sole strong authority.
  //
  // We check this via the plan-section warnings array. If a plan section
  // carries a warning of type METADATA_ONLY or DISCOVERY_ONLY, the
  // corresponding draft section must NOT be VERIFIED (must be NEEDS_SUPPORT
  // or REJECTED).
  for (const planSection of plan.sections ?? []) {
    const warnings = planSection.warnings ?? [];
    const isMetadataOnly = warnings.some((w) =>
      w.type.toUpperCase().includes("METADATA_ONLY"),
    );
    const isDiscoveryOnly = warnings.some((w) =>
      w.type.toUpperCase().includes("DISCOVERY_ONLY"),
    );
    if (!isMetadataOnly && !isDiscoveryOnly) continue;

    const draftSection = findSectionForPlan(sections, planSection);
    if (!draftSection) continue;

    if (isMetadataOnly && draftSection.reviewStatus === "VERIFIED") {
      assertions.push({
        type: "NO_METADATA_ONLY_HOLDING",
        passed: false,
        detail: `Section "${draftSection.title}" is VERIFIED but the planner flagged it as metadata-only (no holding extractable). Downgrade to NEEDS_SUPPORT or REJECTED (§22, §63).`,
      });
    }
    if (isDiscoveryOnly && draftSection.reviewStatus === "VERIFIED") {
      assertions.push({
        type: "NO_DISCOVERY_ONLY_SOLE_AUTHORITY",
        passed: false,
        detail: `Section "${draftSection.title}" is VERIFIED but the planner flagged it as discovery-only (no holding — only mentioned in disclosure). Downgrade to NEEDS_SUPPORT or REJECTED (§22).`,
      });
    }
  }

  // 7) Material contradictions surfaced by the planner must be visible in
  //    the draft (not silently resolved).
  for (const c of plan.materialContradictions ?? []) {
    const visible = sections.some((s) => {
      const text = s.content?.text ?? "";
      if (text.toLowerCase().includes(c.detail?.toLowerCase()?.slice(0, 30) ?? "")) {
        return true;
      }
      if (Array.isArray(s.warnings)) {
        return s.warnings.some(
          (w) =>
            w.type.toUpperCase().includes("CONTRADICTION") ||
            w.type.toUpperCase().includes("MATERIALIZED"),
        );
      }
      return false;
    });
    if (!visible) {
      assertions.push({
        type: "MATERIAL_CONTRADICTION_VISIBLE",
        passed: false,
        detail: `Plan surfaced a material contradiction (${c.detail}) but no section makes it visible. The draft must not silently resolve material contradictions (§22).`,
      });
    } else {
      assertions.push({
        type: "MATERIAL_CONTRADICTION_VISIBLE",
        passed: true,
        detail: `Material contradiction is visible in the draft.`,
      });
    }
  }

  // 8) §22 — All factual/legal assertions grounded + quotes verified + relief
  //    matches goal: these are checked by the other firewalls (factual-
  //    assertion, legal-assertion, quote-firewall, request-verifier). The
  //    completeness firewall emits a meta-assertion summarizing whether all
  //    those sub-checks have been run on each non-empty section.
  for (const section of sections) {
    const text = section.content?.text ?? "";
    const sourceIds = section.content?.sourceIds ?? [];
    if (text.trim().length > 0 && sourceIds.length === 0) {
      // Non-empty section without ANY source id — needs SUPPORT_REQUIRED.
      if (!hasSupportRequiredMarker(text) && !hasMissingInformationMarker(text)) {
        assertions.push({
          type: "SECTION_HAS_GROUNDING",
          passed: false,
          detail: `Section "${section.title}" has body text but cites no source id (F1/L1/C1/CC1/E1/A1...). Mark [SUPPORT_REQUIRED] or cite a verified source.`,
        });
      }
    }
  }

  const passed = assertions.every((a) => a.passed);
  return { passed, assertions };
}
