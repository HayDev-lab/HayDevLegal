// src/lib/legal-research/evaluation/evaluator.ts
// Applicability Gold Set evaluator (master prompt §78-§82, §112).
//
// Metrics:
//   - passRate             fixtures passing their structured expectations
//   - falseApplicableRate  system declared a materially-inapplicable precedent
//                          applicable (§81 — THE Phase 4 metric, target 0)
//   - holdingAccuracy      verified holdings actually supported by their
//                          cited passage (§82, target 1.0)
//   - partyClaimConfusion  party claims recorded as holdings (§83, target 0)
//   - temporalWarningRate  stale-law fixtures flagged POTENTIALLY_STALE (§84)

import { runResearchPipeline } from "../pipeline";
import { cacheClear } from "../analysis-cache";
import { GOLD_FIXTURES, mockLlm, type GoldFixture } from "./gold-fixtures";
import type { ResearchReport } from "../types";

export interface GoldFixtureResult {
  fixture: GoldFixture;
  report: ResearchReport;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface GoldSetMetrics {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  falseApplicable: number;
  falseApplicableRate: number;
  holdingAccuracy: number;
  partyClaimConfusion: number;
  temporalWarningRate: number;
  results: GoldFixtureResult[];
}

/** Run one fixture through the pipeline with its scripted LLM. */
export async function runFixture(fixture: GoldFixture): Promise<GoldFixtureResult> {
  const t0 = Date.now();
  cacheClear(); // fixtures must not share cached analyses
  try {
    const report = await runResearchPipeline(
      {
        query: fixture.query,
        understanding: fixture.understanding,
        evidence: fixture.evidence,
        deadline: Date.now() + 5_000,
      },
      { llm: mockLlm(fixture.llmResponses) },
    );
    fixture.check(report);
    return { fixture, report, passed: true, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      fixture,
      report: null as unknown as ResearchReport,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}

/** Run the whole applicability gold set and compute metrics. */
export async function runApplicabilityGoldSet(): Promise<GoldSetMetrics> {
  const results: GoldFixtureResult[] = [];
  for (const fixture of GOLD_FIXTURES) {
    results.push(await runFixture(fixture));
  }

  const passed = results.filter((r) => r.passed).length;

  // §81 — false applicability: expected NOT applicable (or unavailable) but
  // engine concluded materially applicable.
  const applicabilityTargets = results.filter(
    (r) => r.passed && r.fixture.expectedConclusion && r.fixture.targetEvidenceId,
  );
  const falseApplicable = applicabilityTargets.filter((r) => {
    const expected = r.fixture.expectedConclusion!;
    const app = r.report.applicability.find((a) => a.precedentId === r.fixture.targetEvidenceId);
    if (!app) return true; // missing analysis where one was expected
    return (
      (expected === "NOT_MATERIALLY_APPLICABLE" ||
        expected === "ANALOGICAL_ONLY" ||
        expected === "ANALYSIS_UNAVAILABLE") &&
      (app.conclusion === "DIRECTLY_RELEVANT" || app.conclusion === "RELEVANT_WITH_DISTINCTIONS")
    );
  }).length;

  // §82 — holding accuracy over all surviving (verified) holdings.
  const allHoldings = results.flatMap((r) => (r.passed ? r.report.holdings : []));
  const supported = allHoldings.filter((h) => h.verification !== "REJECT").length;
  const holdingAccuracy = allHoldings.length > 0 ? supported / allHoldings.length : 1;

  // §83 — party-claim confusion: any holding whose rule matches a party
  // assertion phrase (checked structurally in fixtures; here as aggregate).
  const partyClaimConfusion = results.filter((r) => !r.passed && /§83|G11/.test(r.fixture.id + r.error)).length;

  // §84 — temporal warning rate for the stale-law fixture.
  const staleFixtures = results.filter((r) => r.fixture.id === "G4-temporal-stale");
  const temporalHits = staleFixtures.filter(
    (r) => r.passed && r.report.temporal.some((t) => t.compatibility === "POTENTIALLY_STALE"),
  ).length;
  const temporalWarningRate = staleFixtures.length > 0 ? temporalHits / staleFixtures.length : 1;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    falseApplicable,
    falseApplicableRate: applicabilityTargets.length > 0 ? falseApplicable / applicabilityTargets.length : 0,
    holdingAccuracy,
    partyClaimConfusion,
    temporalWarningRate,
    results,
  };
}
