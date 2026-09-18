// src/lib/ai-runtime/codex/case-analysis-schema.ts
// Zod schema for CodexCaseAnalysis + verification firewall (§45, §46).
//
// Two concerns live here:
//   1. STRUCTURAL validation — `CodexCaseAnalysisSchema` parses the JSON the
//      codex CLI wrote to `analysis.json` in the workspace. This is called by
//      `readWorkspaceOutput`. Failures are reported as `null` (caller decides
//      whether to retry / degrade / surface an error — never throw).
//   2. SEMANTIC firewall — `validateCodexOutput(analysis, pack)` walks the
//      parsed analysis and confirms every referenced `evidenceId` exists in
//      the supplied pack (§40 closed-evidence guarantee) and that the
//      synthesis is non-empty. This is the LAST line of defense against
//      invented citations before the analysis is exposed to business code.

import { z } from "zod";
import type { ZodType } from "zod";

import type {
  ApplicablePrecedent,
  ApplicabilityVerdict,
  ArgumentMapEntry,
  CaseAnalysisPack,
  CodexCaseAnalysis,
  EvidenceRef,
  IssueAnalysis,
  LegalEvidence,
} from "./types";

// ---------------------------------------------------------------------------
// Reusable shape fragments
// ---------------------------------------------------------------------------

const EvidenceRefSchema: ZodType<EvidenceRef> = z.object({
  evidenceId: z.string().min(1),
  quote: z.string().optional(),
  section: z.string().optional(),
});

const ApplicabilityVerdictSchema: ZodType<ApplicabilityVerdict> = z.enum([
  "DIRECT",
  "WITH_DISTINCTIONS",
  "ANALOGICAL",
  "NOT_APPLICABLE",
]);

const ApplicablePrecedentSchema: ZodType<ApplicablePrecedent> = z.object({
  evidenceId: z.string().min(1),
  holding: z.string().min(1),
  // §22 — optional supporting evidence array
  supportingEvidence: z.array(EvidenceRefSchema).optional(),
  similarities: z.array(z.string()),
  distinguishingFactors: z.array(z.string()),
  applicability: ApplicabilityVerdictSchema,
});

const IssueAnalysisSchema: ZodType<IssueAnalysis> = z.object({
  issueId: z.string().min(1),
  governingRules: z.array(EvidenceRefSchema),
  applicablePrecedents: z.array(ApplicablePrecedentSchema),
  counterAuthorities: z.array(EvidenceRefSchema),
  unresolvedQuestions: z.array(z.string()),
});

const ArgumentMapEntrySchema: ZodType<ArgumentMapEntry> = z.object({
  proposition: z.string().min(1),
  // §22 — renamed from `support` to `supportingAuthorities`
  supportingAuthorities: z.array(EvidenceRefSchema),
  // §22 — renamed from `counter` to `counterAuthorities`
  counterAuthorities: z.array(EvidenceRefSchema),
  limitations: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// §45 — Full schema. Use `passthrough()` so unknown keys (e.g. model debug
// fields the CLI may emit) don't fail the parse; we only care about the
// contract fields. The caller filters/ignores extras.
// ---------------------------------------------------------------------------

export const CodexCaseAnalysisSchema: ZodType<CodexCaseAnalysis> = z
  .object({
    issues: z.array(IssueAnalysisSchema),
    argumentMap: z.array(ArgumentMapEntrySchema),
    missingMaterialFacts: z.array(z.string()),
    additionalResearchNeeded: z.array(z.string()),
    synthesis: z.string(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// §46 — Verification firewall.
//
// Returns a discriminated union so callers can `switch` on `ok` without
// inspecting `reason` unnecessarily. NEVER throws — invalid analysis is a
// regular control-flow outcome (degrade to "analysis unavailable"), not an
// exceptional one.
// ---------------------------------------------------------------------------

export type CodexOutputValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify that every evidenceId referenced in `analysis` exists in `pack`.
 *
 * Walks (Phase 4.1 Finalization §22 — paths updated for new field names):
 *   - analysis.issues[].governingRules[]
 *   - analysis.issues[].applicablePrecedents[]               (precedent.evidenceId)
 *   - analysis.issues[].applicablePrecedents[].supportingEvidence[]   (§22 NEW)
 *   - analysis.issues[].counterAuthorities[]
 *   - analysis.argumentMap[].supportingAuthorities[]        (renamed from `support`)
 *   - analysis.argumentMap[].counterAuthorities[]           (renamed from `counter`)
 *
 * Also rejects an empty synthesis (§46 — empty synthesis means the model
 * gave up silently, which is not a valid answer).
 */
export function validateCodexOutput(
  analysis: CodexCaseAnalysis,
  pack: CaseAnalysisPack,
): CodexOutputValidation {
  const known = new Set<string>();
  for (const e of allPackEvidence(pack)) {
    known.add(e.id);
  }

  const referencedIds: string[] = [];
  for (const issue of analysis.issues ?? []) {
    for (const ref of issue.governingRules ?? []) {
      referencedIds.push(ref.evidenceId);
    }
    for (const precedent of issue.applicablePrecedents ?? []) {
      referencedIds.push(precedent.evidenceId);
      // §22 — walk the new supportingEvidence array if present
      for (const ref of precedent.supportingEvidence ?? []) {
        referencedIds.push(ref.evidenceId);
      }
    }
    for (const ref of issue.counterAuthorities ?? []) {
      referencedIds.push(ref.evidenceId);
    }
  }
  for (const arg of analysis.argumentMap ?? []) {
    // §22 — renamed fields
    for (const ref of arg.supportingAuthorities ?? []) {
      referencedIds.push(ref.evidenceId);
    }
    for (const ref of arg.counterAuthorities ?? []) {
      referencedIds.push(ref.evidenceId);
    }
  }

  for (const id of referencedIds) {
    if (!known.has(id)) {
      return { ok: false, reason: `unknown_evidence_id: ${id}` };
    }
  }

  if (!analysis.synthesis || analysis.synthesis.trim().length === 0) {
    return { ok: false, reason: "empty_synthesis" };
  }

  return { ok: true };
}

/**
 * Flatten every evidence array in the pack into a single iterable. Used by
 * the firewall and also exposed for callers (e.g. prompt builders) that
 * need to enumerate all evidence ids.
 */
export function allPackEvidence(pack: CaseAnalysisPack): LegalEvidence[] {
  return [
    ...pack.legislation,
    ...pack.cassationCases,
    ...pack.constitutionalCases,
    ...pack.echrCases,
    ...pack.otherEvidence,
  ];
}
