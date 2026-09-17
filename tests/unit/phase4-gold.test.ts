// tests/unit/phase4-gold.test.ts
// Applicability Gold Set (master prompt §78-§87) + precedent gold set
// (§29-§32). Runs fully offline with the scripted mock LLM.

import { describe, expect, test } from "bun:test";
import { runApplicabilityGoldSet } from "@/lib/legal-research/evaluation/evaluator";
import {
  runPrecedentGoldSet,
  contextWindowIsolation,
  PRECEDENT_GOLD_CASES,
} from "@/lib/legal-research/evaluation/precedent-gold-set";

describe("Applicability Gold Set (§78-§87)", () => {
  test("all fixtures pass their structured expectations", async () => {
    const metrics = await runApplicabilityGoldSet();
    const failures = metrics.results.filter((r) => !r.passed);
    if (failures.length > 0) {
      console.error(
        "GOLD FAILURES:\n" +
          failures.map((f) => `  ${f.fixture.id} (${f.fixture.testType}): ${f.error}`).join("\n"),
      );
    }
    expect(metrics.total).toBeGreaterThanOrEqual(15);
    expect(metrics.passed).toBe(metrics.total);
  });

  test("false applicability rate is 0 (§81 — the Phase 4 metric)", async () => {
    const metrics = await runApplicabilityGoldSet();
    expect(metrics.falseApplicable).toBe(0);
    expect(metrics.falseApplicableRate).toBe(0);
  });

  test("every surviving holding is grounded (§82 — no unsupported holdings)", async () => {
    const metrics = await runApplicabilityGoldSet();
    expect(metrics.holdingAccuracy).toBe(1);
  });

  test("no party-claim confusion (§83)", async () => {
    const metrics = await runApplicabilityGoldSet();
    expect(metrics.partyClaimConfusion).toBe(0);
  });

  test("stale-law fixture is flagged (§84)", async () => {
    const metrics = await runApplicabilityGoldSet();
    expect(metrics.temporalWarningRate).toBe(1);
  });
});

describe("Precedent relation gold set (§29-§32)", () => {
  test("safe default REFERENCES; strong labels need textual confirmation", () => {
    const res = runPrecedentGoldSet();
    if (res.failures.length > 0) console.error("PRECEDENT FAILURES:\n" + res.failures.join("\n"));
    expect(res.total).toBe(PRECEDENT_GOLD_CASES.length);
    expect(res.passed).toBe(res.total);
  });

  test("confirmation markers outside the window do not count (§29)", () => {
    expect(contextWindowIsolation()).toBe(true);
  });
});
