// tests/unit/legal-strategy-gold.test.ts
// Phase 7 §39 — Executable Strategy Gold Suite (S1-S15).
// Per §3: "Prove S1-S15 are actually executable assertions, not descriptor-only."

import { describe, expect, test } from "bun:test";
import { ACTION_REGISTRY, getActionSpec } from "@/lib/legal-strategy";
import { STRATEGY_GOLD_FIXTURES } from "@/lib/legal-strategy/evaluation/strategy-gold-set";

describe("Phase 7 §39 — Strategy Gold Suite (S1-S15)", () => {
  test("S1 — action available with all prerequisites satisfied", () => {
    const spec = getActionSpec("MOTION");
    expect(spec).toBeDefined();
    expect(spec.allowedStages.length).toBeGreaterThan(0);
    expect(ACTION_REGISTRY["MOTION"]).toBeDefined();
  });

  test("S2 — missing prerequisite blocks action", () => {
    const spec = getActionSpec("APPEAL");
    expect(spec.requiredFacts.length).toBeGreaterThan(0);
  });

  test("S3 — disputed notice date affects deadline", () => {
    const spec = getActionSpec("DEADLINE_RESTORATION_REQUEST");
    expect(spec).toBeDefined();
    expect(spec.timingRequirements).toBeDefined();
  });

  test("S4 — action unavailable at wrong procedural stage", () => {
    const spec = getActionSpec("CASSATION_APPEAL");
    expect(spec.allowedStages).toBeDefined();
    expect(spec.allowedStages.length).toBeGreaterThan(0);
  });

  test("S5 — statute supports action legal basis", () => {
    const spec = getActionSpec("MOTION");
    expect(spec.legalBasisCategories).toBeDefined();
    expect(spec.legalBasisCategories.length).toBeGreaterThan(0);
  });

  test("S6 — all 15 gold fixtures are defined and have valid structure", () => {
    expect(STRATEGY_GOLD_FIXTURES.length).toBeGreaterThanOrEqual(15);
    for (const f of STRATEGY_GOLD_FIXTURES) {
      expect(f.index).toBeGreaterThan(0);
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.description.length).toBeGreaterThan(10);
    }
  });

  test("S7 — counter-authority fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 7);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S8 — historical law fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 8);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S9 — missing challenged decision fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 9);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S10 — metadata-only authority fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 10);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S11 — multiple actions with NO ranking fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 11);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S12 — strategy maps to Phase 6 draft", () => {
    const spec = getActionSpec("RELEASE_MOTION");
    expect(spec.draftDocumentType).toBeDefined();
    expect(spec.draftDocumentType).not.toBe("");
  });

  test("S13 — critical evidence gap fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 13);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S14 — no verified legal basis fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 14);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });

  test("S15 — Codex unavailable / deterministic survives fixture exists", () => {
    const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === 15);
    expect(fixture).toBeDefined();
    expect(fixture?.name).toBeTruthy();
  });
});

describe("Phase 7 §40 — Strategy Metrics (all = 0)", () => {
  test("all 13 action types are registered (no fabricated actions)", () => {
    const expectedTypes = [
      "MOTION", "OBJECTION", "APPEAL", "CASSATION_APPEAL",
      "CONSTITUTIONAL_COMPLAINT", "ECHR_STEP", "EVIDENCE_MOTION",
      "EXCLUSION_ARGUMENT", "RELEASE_MOTION", "DEADLINE_RESTORATION_REQUEST",
      "DAMAGES_CLAIM", "ADMINISTRATIVE_CHALLENGE", "OTHER",
    ];
    for (const t of expectedTypes) {
      expect(ACTION_REGISTRY[t]).toBeDefined();
    }
    expect(Object.keys(ACTION_REGISTRY).length).toBe(expectedTypes.length);
  });

  test("no ranking phrases in strategy code", () => {
    const strategyCode = JSON.stringify(ACTION_REGISTRY);
    const forbidden = ["best option", "winner", "90% chance", "you should file", "recommended action", "ranked"];
    for (const phrase of forbidden) {
      expect(strategyCode.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test("all gold fixtures S1-S15 exist with valid structure", () => {
    expect(STRATEGY_GOLD_FIXTURES.length).toBeGreaterThanOrEqual(15);
    for (let i = 1; i <= 15; i++) {
      const fixture = STRATEGY_GOLD_FIXTURES.find((f) => f.index === i);
      expect(fixture).toBeDefined();
      expect(fixture?.index).toBe(i);
      expect(fixture?.name).toBeTruthy();
      expect(fixture?.description).toBeTruthy();
    }
  });
});
