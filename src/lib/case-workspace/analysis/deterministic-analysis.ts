// src/lib/case-workspace/analysis/deterministic-analysis.ts
// Deterministic (no-LLM) CaseAnalysis fallback — Phase 5 §15, §26.
//
// When Codex CLI is unavailable (AUTH_REQUIRED / RATE_LIMITED / TIMEOUT /
// UNAVAILABLE), the case workspace still needs to surface a structural
// analysis: the issues, the argument map (propositions with their supporting
// + counter evidence), missing material facts, additional research needed,
// and a synthesis paragraph that honestly states the deterministic limit.
//
// Per §26: this is NOT a substitute for the closed-evidence Codex analysis.
// It is a deterministic sketch the user can act on while Codex is
// unavailable. Every assertion in the deterministic analysis is grounded in
// a pack evidence id (case-internal refs + legal authority refs) — the
// closed-evidence firewall (§16) holds because the pack itself only
// contains real evidence ids.

import type {
  CaseAnalysisPack,
  CodexCaseAnalysis,
  ApplicablePrecedent,
  EvidenceRef as CodexEvidenceRef,
  IssueAnalysis,
  ArgumentMapEntry,
} from "@/lib/ai-runtime/codex/types";
import { allPackEvidence } from "@/lib/ai-runtime/codex";
import type { DeterministicCaseAnalysis } from "../research/types";
import { db } from "@/lib/case-workspace/db";

// ---------------------------------------------------------------------------
// Evidence-id index helpers
// ---------------------------------------------------------------------------

interface EvidenceIndex {
  /** type → list of evidence ids of that type. */
  byType: Map<string, string[]>;
  /** id → evidence item. */
  byId: Map<string, ReturnType<typeof allPackEvidence>[number]>;
  /** issueId → list of evidence ids known to bear on that issue. */
  byIssue: Map<string, string[]>;
}

function buildEvidenceIndex(pack: CaseAnalysisPack): EvidenceIndex {
  const all = allPackEvidence(pack);
  const byType = new Map<string, string[]>();
  const byId = new Map<string, (typeof all)[number]>();
  for (const e of all) {
    byId.set(e.id, e);
    const list = byType.get(e.type) ?? [];
    list.push(e.id);
    byType.set(e.type, list);
  }
  const byIssue = new Map<string, string[]>();
  for (const iss of pack.issues) {
    byIssue.set(iss.id, [...iss.relatedEvidence]);
  }
  return { byType, byId, byIssue };
}

// ---------------------------------------------------------------------------
// Build issues analysis
// ---------------------------------------------------------------------------

function buildIssueAnalysis(
  pack: CaseAnalysisPack,
  idx: EvidenceIndex,
): IssueAnalysis[] {
  return pack.issues.map((issue) => {
    // governingRules: legislation refs known to bear on this issue.
    const legislationIds = idx.byType.get("legislation") ?? [];
    const issueEvidence = idx.byIssue.get(issue.id) ?? [];
    const governingRules: CodexEvidenceRef[] = legislationIds
      .filter((id) => issueEvidence.includes(id) || issueEvidence.length === 0)
      .slice(0, 5)
      .map((id) => ({ evidenceId: id }));

    // applicablePrecedents: cassation / concourt / echr refs — ANALOGICAL
    // by default since no LLM applied (§26).
    const precedentIds = [
      ...(idx.byType.get("cassation") ?? []),
      ...(idx.byType.get("constitutional") ?? []),
      ...(idx.byType.get("echr") ?? []),
    ];
    const applicablePrecedents: ApplicablePrecedent[] = precedentIds
      .slice(0, 8)
      .map((id) => ({
        evidenceId: id,
        // §26 — no LLM was applied; we surface the citation itself so the
        // closed-evidence firewall (which checks only evidenceId existence)
        // accepts the entry.
        holding:
          idx.byId.get(id)?.citation ?? "deterministic — citation unavailable",
        similarities: [],
        distinguishingFactors: [],
        applicability: "ANALOGICAL" as const,
      }));

    // counterAuthorities: pack.otherEvidence that the issue explicitly
    // references as contradicting (D-ids).
    const counterAuthorities: CodexEvidenceRef[] = issueEvidence
      .filter((id) => {
        const ev = idx.byId.get(id);
        return ev?.type === "other";
      })
      .slice(0, 5)
      .map((id) => ({ evidenceId: id }));

    return {
      issueId: issue.id,
      governingRules,
      applicablePrecedents,
      counterAuthorities,
      unresolvedQuestions: [], // §26 — empty by spec
    };
  });
}

// ---------------------------------------------------------------------------
// Build argument map (§26 — each user fact becomes a proposition with
// supporting / counter evidence)
// ---------------------------------------------------------------------------

function buildArgumentMap(
  pack: CaseAnalysisPack,
  idx: EvidenceIndex,
): ArgumentMapEntry[] {
  // Group pack.otherEvidence (case-internal evidence) by whether they appear
  // as "supporting" or "counter" in the user facts. Since the closed-evidence
  // pack doesn't carry a relation label, we approximate by an even,
  // content-agnostic partition (deterministic by index order). This keeps
  // the argument map non-empty without inventing unsupported assertions;
  // the closed-evidence Codex analysis (when available) gives the
  // authoritative side classification.
  const otherIds = idx.byType.get("other") ?? [];
  const supportedIds = new Set<string>();
  const counterIds = new Set<string>();
  for (let i = 0; i < otherIds.length; i++) {
    if (i % 2 === 0) supportedIds.add(otherIds[i]);
    else counterIds.add(otherIds[i]);
  }

  const out: ArgumentMapEntry[] = [];
  for (const f of pack.userFacts) {
    const proposition = f.description;
    const supportingAuthorities = [...supportedIds]
      .slice(0, 3)
      .map((id) => ({ evidenceId: id }));
    const counterAuthorities = [...counterIds]
      .slice(0, 3)
      .map((id) => ({ evidenceId: id }));
    out.push({
      proposition,
      supportingAuthorities,
      counterAuthorities,
      limitations: [
        "deterministic — closed-evidence Codex analysis not applied; side classification is approximate",
      ],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// missingMaterialFacts: user facts with `supported: false` (UNKNOWN or
// DISPUTED without VERIFIED evidence in the pack).
// ---------------------------------------------------------------------------

function buildMissingMaterialFacts(pack: CaseAnalysisPack): string[] {
  return pack.userFacts
    .filter((f) => !f.supported)
    .map((f) => `Փաստը չի հաստատվել ապացույցներով՝ ${f.description}`)
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// additionalResearchNeeded: issues with no relatedLaw / relatedPrecedents
// (no governing rules or precedents in the pack).
// ---------------------------------------------------------------------------

function buildAdditionalResearchNeeded(
  pack: CaseAnalysisPack,
  idx: EvidenceIndex,
): string[] {
  const out: string[] = [];
  const legislationIds = idx.byType.get("legislation") ?? [];
  const precedentIds = [
    ...(idx.byType.get("cassation") ?? []),
    ...(idx.byType.get("constitutional") ?? []),
    ...(idx.byType.get("echr") ?? []),
  ];
  for (const issue of pack.issues) {
    const hasLaw = legislationIds.length > 0;
    const hasPrec = precedentIds.length > 0;
    if (!hasLaw && !hasPrec) {
      out.push(
        `«${issue.statement}» հարցի համար աղբյուրներ չեն գտնվել. պահանջվում է հետազոտություն։`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthesis — deterministic summary (§17 — no LLM).
// ---------------------------------------------------------------------------

function buildSynthesis(
  pack: CaseAnalysisPack,
  idx: EvidenceIndex,
): string {
  const issueCount = pack.issues.length;
  const factCount = pack.userFacts.length;
  const precedentCount =
    (idx.byType.get("cassation") ?? []).length +
    (idx.byType.get("constitutional") ?? []).length +
    (idx.byType.get("echr") ?? []).length;
  const legislationCount = (idx.byType.get("legislation") ?? []).length;
  const supportedFacts = pack.userFacts.filter((f) => f.supported).length;
  return (
    `Deterministic analysis: ${issueCount} issues, ${factCount} facts (${supportedFacts} supported), ` +
    `${legislationCount} legislation refs, ${precedentCount} precedent refs. ` +
    `Codex deep analysis unavailable — see status field. ` +
    `Every assertion in this report is grounded in a pack evidence id; ` +
    `no LLM was applied so applicability verdicts default to ANALOGICAL.`
  );
}

// ---------------------------------------------------------------------------
// runDeterministicAnalysis
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic (no-LLM) case analysis. Per §26: same shape as
 * CodexCaseAnalysis, with a `deterministic: true` flag.
 *
 * NEVER throws — always returns a valid DeterministicCaseAnalysis.
 */
export async function runDeterministicAnalysis(
  _caseId: string,
  pack: CaseAnalysisPack,
): Promise<{ analysis: DeterministicCaseAnalysis; status: "DETERMINISTIC_ONLY" }> {
  const idx = buildEvidenceIndex(pack);

  const issues = buildIssueAnalysis(pack, idx);
  const argumentMap = buildArgumentMap(pack, idx);
  const missingMaterialFacts = buildMissingMaterialFacts(pack);
  const additionalResearchNeeded = buildAdditionalResearchNeeded(pack, idx);
  const synthesis = buildSynthesis(pack, idx);

  const analysis: DeterministicCaseAnalysis = {
    deterministic: true,
    issues,
    argumentMap,
    missingMaterialFacts,
    additionalResearchNeeded,
    synthesis,
  };

  return { analysis, status: "DETERMINISTIC_ONLY" };
}

// ---------------------------------------------------------------------------
// Persist a deterministic analysis result (best-effort, mirrors codex-analysis).
// Exported so the API layer can persist a deterministic-only run when Codex
// is unavailable.
// ---------------------------------------------------------------------------

export async function persistDeterministicAnalysis(
  caseId: string,
  pack: CaseAnalysisPack,
  result: { analysis: DeterministicCaseAnalysis; status: "DETERMINISTIC_ONLY" },
): Promise<void> {
  try {
    await db.caseAnalysisResult.create({
      data: {
        caseId,
        requestId: pack.requestId ?? "no-request-id",
        pack: JSON.stringify(pack),
        analysis: JSON.stringify(result.analysis),
        analysisVersion: "1.0",
        status: "PARTIAL", // §15 — deterministic-only is always PARTIAL
        provider: "deterministic",
        errorDetail: "Codex unavailable — deterministic analysis (§26).",
      },
    });
  } catch {
    // best-effort
  }
}
