// src/lib/legal-drafting/verification/index.ts
// Phase 6 — Verification firewall orchestrator (§16-§22).
//
// Aggregates the six verification submodules:
//   1. factual-assertion  (§16)  — facts cited + epistemic status language
//   2. legal-assertion     (§17)  — legal authorities cited + role match
//   3. citation-firewall  (§17)  — internal ids + human-readable citations
//   4. quote-firewall      (§18)  — quotes verbatim in cited source
//   5. request-verifier    (§21)  — relief from goal + doc type only
//   6. completeness        (§22)  — required sections, metadata, placeholders
//
// Re-exports all submodule functions and exposes `runAllVerification` as the
// single entry point used by the API + UI layers.

import type {
  DraftingContext,
  DraftSection,
  DocumentPlan,
  DocumentType,
  SectionWarning,
  SourceIdMap,
  VerificationResult,
} from "@/lib/legal-drafting/types";

import { verifyFactualAssertions } from "@/lib/legal-drafting/verification/factual-assertion";
import { verifyLegalAssertions } from "@/lib/legal-drafting/verification/legal-assertion";
import { citationWarnings, verifyCitations } from "@/lib/legal-drafting/verification/citation-firewall";
import { verifyQuotes } from "@/lib/legal-drafting/verification/quote-firewall";
import { verifyRequestedRelief } from "@/lib/legal-drafting/verification/request-verifier";
import { verifyCompleteness } from "@/lib/legal-drafting/verification/completeness";

// Re-export submodule functions for direct API usage.
export { verifyFactualAssertions } from "@/lib/legal-drafting/verification/factual-assertion";
export { verifyLegalAssertions } from "@/lib/legal-drafting/verification/legal-assertion";
export {
  verifyCitations,
  renderCitation,
  lookupSourceEntry,
  citationWarnings,
  extractQuotedText,
} from "@/lib/legal-drafting/verification/citation-firewall";
export { verifyQuotes } from "@/lib/legal-drafting/verification/quote-firewall";
export { verifyRequestedRelief } from "@/lib/legal-drafting/verification/request-verifier";
export { verifyCompleteness } from "@/lib/legal-drafting/verification/completeness";

/**
 * Aggregate a SectionWarning list from all submodules' assertions. Each
 * failed assertion becomes a SectionWarning with a synthesized `type` and
 * the assertion's `detail` (and `sourceId` when present).
 */
function failedAssertionsToWarnings(
  results: VerificationResult[],
): SectionWarning[] {
  const warnings: SectionWarning[] = [];
  for (const r of results) {
    for (const a of r.assertions) {
      if (a.passed) continue;
      warnings.push({
        type: a.type,
        detail: a.detail ?? a.type,
        sourceId: a.sourceId,
      });
    }
  }
  return warnings;
}

/**
 * §22 — Run all verification firewalls in sequence and aggregate the
 * results.
 *
 * @param draftId     the LegalDraft id (for traceability)
 * @param sections    the DraftSection[] to verify
 * @param ctx         the closed DraftingContext (§8)
 * @param plan        the DocumentPlan (§12)
 * @param sourceIdMap the SourceIdMap (§10)
 * @param goal        the user-selected goal (§11)
 * @param docType     the document type (§5)
 *
 * @returns `{ passed, results, warnings }`:
 *   - `passed`     = true iff every firewall returned `passed: true`
 *   - `results`    = ordered list of per-firewall VerificationResult
 *   - `warnings`   = aggregated SectionWarning[] for the drafting UI (§24)
 */
export async function runAllVerification(
  draftId: string,
  sections: DraftSection[],
  ctx: DraftingContext,
  plan: DocumentPlan,
  sourceIdMap: SourceIdMap,
  goal: string,
  docType: DocumentType,
): Promise<{
  passed: boolean;
  results: VerificationResult[];
  warnings: SectionWarning[];
}> {
  // Run all firewalls. Each is independent — a failure in one does not
  // short-circuit the others (we want the full warning list surfaced).
  const [
    factualResult,
    legalResult,
    citationResult,
    quoteResult,
    reliefResult,
    completenessResult,
  ] = await Promise.all([
    verifyFactualAssertions(sections, ctx),
    verifyLegalAssertions(sections, ctx),
    verifyCitations(sections, sourceIdMap),
    verifyQuotes(sections, ctx),
    verifyRequestedRelief(sections, goal, docType),
    verifyCompleteness(draftId, plan, sections),
  ]);

  const results: VerificationResult[] = [
    factualResult,
    legalResult,
    citationResult,
    quoteResult,
    reliefResult,
    completenessResult,
  ];

  // Aggregate SectionWarnings from failed assertions + the citation firewall.
  const warnings: SectionWarning[] = [
    ...failedAssertionsToWarnings(results),
    ...citationWarnings(sections, sourceIdMap),
  ];

  // De-duplicate warnings by (type, detail, sourceId) tuple.
  const seen = new Set<string>();
  const dedupedWarnings: SectionWarning[] = [];
  for (const w of warnings) {
    const key = `${w.type}|${w.detail ?? ""}|${w.sourceId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedWarnings.push(w);
  }

  const passed = results.every((r) => r.passed);
  return { passed, results, warnings: dedupedWarnings };
}
