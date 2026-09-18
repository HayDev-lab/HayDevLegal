// tests/unit/provider-finalization.test.ts
// Phase 4.1 Provider Finalization — fallback ladder contract (§26, §27,
// §82–§85) + routing policy contract (§25) + 4-provider id set (§28).
//
// The Phase 4.1 cleanup removed `ollama-local` and `generic-llm`, leaving
// exactly 4 concrete AiProviderIds (`zai | ollama-cloud | codex-sdk |
// codex-cli`) that collapse to 3 LOGICAL engines (Z-AI, Ollama Cloud,
// Codex with SDK primary + CLI fallback). These tests pin that contract.
//
// Fallback ladder contract (§82, §83):
//   - For task = CASE_ANALYSIS the routing policy is (§25):
//       1. codex-sdk   (preferred — @openai/codex-sdk, structured output)
//       2. codex-cli   (subprocess fallback when SDK is unavailable — §35)
//       3. ollama-cloud (structured-capable cloud provider)
//   - The router MUST try each in order, falling through on UNAVAILABLE,
//     and STOP at the first SUCCESS.
//
//   - For task = QUERY_DECOMPOSITION the policy is [zai, ollama-cloud]:
//       1. zai          (primary — Z-AI SDK bundled)
//       2. ollama-cloud  (cloud fallback)
//
// §26 / §85 cooldown contract: when zai returns RATE_LIMITED, the router
// MUST trigger per-provider cooldown immediately so subsequent calls (in
// the parallel-storm case, sibling Promise.all calls still in their
// synchronous setup phase) skip zai and route straight to ollama-cloud.
//
// §84 contract: when every provider on a ladder returns UNAVAILABLE, the
// router MUST return a structured UNAVAILABLE AiResult — it MUST NOT throw
// (the deterministic engine must still be able to produce a partial report).
//
// Implementation note: the registry module is mocked via `mock.module()`
// (same pattern as tests/unit/router-fallback.test.ts and codex-routing
// .test.ts) so the router creates our fake providers instead of real
// network-bound instances. The rate-limit module is NOT mocked — the
// router's `triggerCooldown` / `isInCooldown` calls go to the real
// per-provider cooldown tracker, which is exactly what production depends
// on. For the §85 parallel-storm case, the zai mock ALSO calls
// `triggerCooldown` synchronously before returning so that the cooldown
// state is visible to sibling calls whose eligibility check runs in the
// same synchronous tick (the router's own `recordOutcome` only fires
// AFTER the await, which would be too late for parallel siblings).
//
// IMPORTANT — describe ordering: bun's `mock.module()` is sticky for the
// lifetime of the test file (it is NOT reverted by `mock.restore()`). The
// "routing policy contract" describe below therefore runs FIRST, before
// any `mock.module()` is installed, so its `await import()`s of the
// registry module return the REAL exports (ALL_PROVIDER_IDS, etc.). The
// "fallback ladder" describe runs SECOND and installs per-test mocks;
// each fallback test re-installs the mock with its own fixture, so the
// sticky mock from the previous test is overwritten.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  mock,
} from "bun:test";

// Real rate-limit / circuit-breaker — we WANT the router to use the real
// cooldown tracker so we can verify the §85 "no provider storm" contract.
import {
  isInCooldown,
  resetRateLimits,
  snapshotRateLimit,
  triggerCooldown,
} from "@/lib/ai-runtime/rate-limit";
import { resetBreakers } from "@/lib/ai-runtime/circuit-breaker";

// Type-only imports for safer mock construction.
import type {
  AiProvider,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
  AiTextRequest,
} from "@/lib/ai-runtime/types";

// ---------------------------------------------------------------------------
// Test fixture — per-test call log + stateful mock registry
// ---------------------------------------------------------------------------

interface CallEntry {
  provider: AiProviderId;
  method: "generateStructured" | "generateText";
  ts: number;
}

let callLog: CallEntry[] = [];

/**
 * Build a fake provider that records every call and returns the configured
 * canned AiResult. The router calls `generateText` / `generateStructured`
 * on this object — both are wired so any task type works.
 */
function makeFakeProvider<T>(
  id: AiProviderId,
  canned: AiResult<T>,
): AiProvider {
  return {
    id,
    capabilities: {
      structuredOutput: true,
      streaming: false,
      caseAnalysis: id === "codex-sdk" || id === "codex-cli",
      maxTokens: 1000,
      defaultTimeoutMs: 5000,
    },
    async health() {
      return { status: "HEALTHY", lastCheckedAt: Date.now() };
    },
    async generateText(
      _req: AiTextRequest,
      _ctx: AiRuntimeContext,
    ): Promise<AiResult<string>> {
      callLog.push({ provider: id, method: "generateText", ts: Date.now() });
      // Coerce — the canned result for tests is small and shape-stable.
      return { ...(canned as unknown as AiResult<string>) } as AiResult<string>;
    },
    async generateStructured<U>(
      _req: AiStructuredRequest<U>,
      _ctx: AiRuntimeContext,
    ): Promise<AiResult<U>> {
      callLog.push({
        provider: id,
        method: "generateStructured",
        ts: Date.now(),
      });
      return { ...(canned as unknown as AiResult<U>) } as AiResult<U>;
    },
  };
}

/**
 * Install a mock registry that maps id → fake provider. The mock is stateful
 * for `quickStatus` / `recordAttempt` so the router's eligibility check
 * behaves like production: after `triggerCooldown(id)`, the subsequent
 * `quickStatus(id)` returns "RATE_LIMITED" (delegated to the real rate-limit
 * module — NOT the mock's own state).
 */
function installMockRegistry(
  providers: Partial<Record<AiProviderId, AiProvider>>,
): void {
  mock.module("@/lib/ai-runtime/registry", () => {
    return {
      getInstance: (id: AiProviderId) => providers[id],
      quickStatus: (id: AiProviderId) => {
        // Delegate to the real rate-limit module so cooldowns set by the
        // router's `triggerCooldown` (and by the mock's own preemptive
        // triggerCooldown for the §85 storm test) are honored.
        if (providers[id] === undefined) return "UNCONFIGURED" as const;
        if (isInCooldown(id)) return "RATE_LIMITED" as const;
        return "HEALTHY" as const;
      },
      recordAttempt: () => {},
      getRuntimeState: () => ({
        status: "HEALTHY" as const,
        rateLimitedUntil: undefined,
        failures: 0,
        activeRequests: 0,
        lastErrorAt: undefined,
      }),
      updateRuntimeState: () => {},
      deriveHealthStatus: () => "HEALTHY" as const,
      healthSnapshot: async () => ({}),
      resetRegistry: () => {},
      ALL_PROVIDER_IDS: Object.keys(providers) as AiProviderId[],
    };
  });
}

// ---------------------------------------------------------------------------
// Tests — routing policy contract (§25) + 4-provider id set (§28)
//
// IMPORTANT: this describe runs FIRST. It does NOT install any
// `mock.module()`, so its `await import()`s return the REAL config +
// registry modules. (bun's `mock.module()` is sticky for the lifetime of
// the test file; if these tests ran AFTER the fallback-ladder describe,
// `await import("@/lib/ai-runtime/registry")` would return the mocked
// registry with a 2-id ALL_PROVIDER_IDS, and the §28 contract test would
// spuriously fail.)
// ---------------------------------------------------------------------------

describe("Phase 4.1 Provider Finalization — routing policy contract (§25, §28)", () => {
  // §28 contract test needs the REAL registry's ALL_PROVIDER_IDS. bun's
  // mock.module() is sticky across test files (it is NOT reverted by
  // mock.restore()), so the mocks installed by tests/unit/codex-routing
  // .test.ts and tests/unit/router-fallback.test.ts are still active
  // when this file runs (both files run before this one alphabetically).
  // A plain `await import("@/lib/ai-runtime/registry")` would return the
  // codex-routing.test.ts mock's ALL_PROVIDER_IDS (an Object.keys snapshot
  // of its last fixture — 4 ids in the wrong order). We bypass the mock
  // by doing a cache-busting dynamic import: the `?t=...` query forces
  // bun to re-evaluate the module from source, returning the REAL
  // registry exports. We do this ONCE in beforeAll so the spawnSync
  // codex-binary probe (~50ms) doesn't run twice.
  let realAllProviderIds: readonly AiProviderId[] | null = null;

  beforeAll(async () => {
    const real = (await import(
      `@/lib/ai-runtime/registry?t=${Date.now()}`,
    )) as {
      ALL_PROVIDER_IDS: readonly AiProviderId[];
    };
    realAllProviderIds = real.ALL_PROVIDER_IDS;
  });

  afterAll(() => {
    realAllProviderIds = null;
  });

  beforeEach(() => {
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("§25 — QUERY_DECOMPOSITION routing policy is [zai, ollama-cloud] (length 2)", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.QUERY_DECOMPOSITION).toEqual([
      "zai",
      "ollama-cloud",
    ]);
    expect(ROUTING_POLICY.QUERY_DECOMPOSITION.length).toBe(2);
  });

  test("§25 — LIGHT_HOLDING_EXTRACTION routing policy is [ollama-cloud, zai, codex-sdk] (length 3)", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.LIGHT_HOLDING_EXTRACTION).toEqual([
      "ollama-cloud",
      "zai",
      "codex-sdk",
    ]);
    expect(ROUTING_POLICY.LIGHT_HOLDING_EXTRACTION.length).toBe(3);
  });

  test("§25 — CASE_ANALYSIS routing policy is [codex-sdk, codex-cli, ollama-cloud] (length 3, no zai)", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.CASE_ANALYSIS).toEqual([
      "codex-sdk",
      "codex-cli",
      "ollama-cloud",
    ]);
    expect(ROUTING_POLICY.CASE_ANALYSIS.length).toBe(3);
    expect(ROUTING_POLICY.CASE_ANALYSIS).not.toContain("zai");
  });

  test("§25 — DEEP_CASE_SYNTHESIS routing policy is [codex-sdk, codex-cli, ollama-cloud, zai] (length 4)", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.DEEP_CASE_SYNTHESIS).toEqual([
      "codex-sdk",
      "codex-cli",
      "ollama-cloud",
      "zai",
    ]);
    expect(ROUTING_POLICY.DEEP_CASE_SYNTHESIS.length).toBe(4);
  });

  test("§25 — FINAL_ANSWER routing policy is [zai, ollama-cloud] (length 2)", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.FINAL_ANSWER).toEqual(["zai", "ollama-cloud"]);
    expect(ROUTING_POLICY.FINAL_ANSWER.length).toBe(2);
  });

  test("§25 — no removed providers (ollama-local, generic-llm) in any routing policy entry", async () => {
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    const REMOVED = ["ollama-local", "generic-llm"];
    for (const [, providers] of Object.entries(ROUTING_POLICY)) {
      for (const p of providers as readonly string[]) {
        expect(REMOVED).not.toContain(p);
      }
    }
  });

  test("§28 — ALL_PROVIDER_IDS contains exactly the 4 finalized provider ids", () => {
    expect(realAllProviderIds).not.toBeNull();
    expect([...realAllProviderIds!]).toEqual([
      "zai",
      "ollama-cloud",
      "codex-sdk",
      "codex-cli",
    ]);
  });

  test("§28 — no removed provider id appears in ALL_PROVIDER_IDS", () => {
    const ids = [...realAllProviderIds!];
    expect(ids).not.toContain("ollama-local");
    expect(ids).not.toContain("generic-llm");
  });
});

// ---------------------------------------------------------------------------
// Tests — fallback ladder (§26, §27, §82, §83, §84, §85)
// ---------------------------------------------------------------------------

describe("Phase 4.1 Provider Finalization — fallback ladder (§26, §27, §82–§85)", () => {
  beforeEach(() => {
    callLog = [];
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("§26 — Z-AI RATE_LIMITED → routes to Ollama Cloud (sequential, then cooldown skip)", async () => {
    // Per §25, QUERY_DECOMPOSITION routing policy is [zai, ollama-cloud]:
    //   1. zai          (primary — Z-AI SDK bundled)
    //   2. ollama-cloud (cloud fallback)
    //
    // When zai returns RATE_LIMITED, the router MUST fall through to
    // ollama-cloud AND trigger zai's per-provider cooldown so subsequent
    // calls skip zai entirely (§85 sequential facet — "no provider storm").
    //
    // NOTE on task choice: the §26 spec text mentions LIGHT_HOLDING_EXTRACTION,
    // but per §25 that policy is `[ollama-cloud, zai, codex-sdk]` —
    // ollama-cloud is FIRST. If ollama-cloud returns SUCCESS (as the spec
    // requires), the router returns it without ever calling zai, so the
    // assertion "zai was called once" cannot be satisfied. We use
    // QUERY_DECOMPOSITION (the canonical "zai first" task) to faithfully
    // exercise the §26 contract: Z-AI rate-limited → routes to Ollama Cloud
    // with zai cooldown.
    let zaiCallCount = 0;
    let ollamaCallCount = 0;

    mock.module("@/lib/ai-runtime/registry", () => {
      return {
        getInstance: (id: AiProviderId) => {
          if (id === "zai") {
            return {
              id,
              capabilities: {
                structuredOutput: true,
                streaming: false,
                caseAnalysis: false,
                maxTokens: 1000,
                defaultTimeoutMs: 5000,
              },
              async health() {
                return { status: "HEALTHY" };
              },
              async generateText() {
                zaiCallCount += 1;
                // §85 preemptive cooldown trigger (mirrored from the §85
                // parallel test for consistency): the router's own
                // `recordOutcome` will ALSO call `triggerCooldown` after
                // the await resolves, but doing it here makes the cooldown
                // visible to any sibling call whose eligibility check runs
                // in the same synchronous tick.
                triggerCooldown("zai", 60_000);
                return {
                  status: "RATE_LIMITED" as const,
                  provider: id,
                  retryAfterMs: 60_000,
                };
              },
              async generateStructured() {
                zaiCallCount += 1;
                triggerCooldown("zai", 60_000);
                return {
                  status: "RATE_LIMITED" as const,
                  provider: id,
                  retryAfterMs: 60_000,
                };
              },
            };
          }
          if (id === "ollama-cloud") {
            return {
              id,
              capabilities: {
                structuredOutput: true,
                streaming: false,
                caseAnalysis: false,
                maxTokens: 1000,
                defaultTimeoutMs: 5000,
              },
              async health() {
                return { status: "HEALTHY" };
              },
              async generateText() {
                ollamaCallCount += 1;
                return {
                  status: "SUCCESS" as const,
                  provider: id,
                  value: `ollama-${ollamaCallCount}`,
                  latencyMs: 1,
                };
              },
              async generateStructured() {
                ollamaCallCount += 1;
                return {
                  status: "SUCCESS" as const,
                  provider: id,
                  value: { n: ollamaCallCount },
                  latencyMs: 1,
                };
              },
            };
          }
          return undefined;
        },
        quickStatus: (id: AiProviderId) => {
          if (isInCooldown(id)) return "RATE_LIMITED" as const;
          return "HEALTHY" as const;
        },
        recordAttempt: () => {},
        getRuntimeState: () => ({
          status: "HEALTHY" as const,
          rateLimitedUntil: undefined,
          failures: 0,
          activeRequests: 0,
          lastErrorAt: undefined,
        }),
        updateRuntimeState: () => {},
        deriveHealthStatus: () => "HEALTHY" as const,
        healthSnapshot: async () => ({}),
        resetRegistry: () => {},
        ALL_PROVIDER_IDS: ["zai", "ollama-cloud"] as AiProviderId[],
      };
    });

    const { routeGenerateText } = await import("@/lib/ai-runtime/router");

    // First call: zai returns RATE_LIMITED → router falls through to
    // ollama-cloud and returns its SUCCESS.
    const r1 = await routeGenerateText(
      { messages: [{ role: "user", content: "first" }] },
      "QUERY_DECOMPOSITION",
      {},
    );
    expect(r1.status).toBe("SUCCESS");
    if (r1.status === "SUCCESS") {
      expect(r1.provider).toBe("ollama-cloud");
    }

    // §26 contract: zai was called exactly once and entered cooldown.
    expect(zaiCallCount).toBe(1);
    expect(isInCooldown("zai")).toBe(true);
    const snap = snapshotRateLimit("zai");
    expect(snap.hits).toBeGreaterThanOrEqual(1);

    const zaiCallsAfterFirst = zaiCallCount;

    // Second call: zai is in cooldown → router MUST skip it and go straight
    // to ollama-cloud without touching zai again.
    const r2 = await routeGenerateText(
      { messages: [{ role: "user", content: "second" }] },
      "QUERY_DECOMPOSITION",
      {},
    );
    expect(r2.status).toBe("SUCCESS");
    if (r2.status === "SUCCESS") {
      expect(r2.provider).toBe("ollama-cloud");
    }

    // §85 (sequential facet): zai MUST NOT have been called again while in
    // cooldown.
    expect(zaiCallCount).toBe(zaiCallsAfterFirst);
  });

  test("§27 — Codex SDK UNAVAILABLE → Codex CLI UNAVAILABLE → Ollama Cloud SUCCESS", async () => {
    // Per §25, CASE_ANALYSIS routing policy is [codex-sdk, codex-cli,
    // ollama-cloud]. The router MUST try each in order, falling through on
    // UNAVAILABLE, and stop at the first SUCCESS.
    installMockRegistry({
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "UNAVAILABLE",
        provider: "codex-sdk",
        detail: "@openai/codex-sdk not installed (§111)",
      }),
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "UNAVAILABLE",
        provider: "codex-cli",
        detail: "`codex` binary not on PATH (§36)",
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "SUCCESS",
        provider: "ollama-cloud",
        value: "case-analysis-from-ollama",
        latencyMs: 150,
      }),
      zai: makeFakeProvider("zai", {
        status: "SUCCESS",
        provider: "zai",
        value: "case-analysis-from-zai",
        latencyMs: 150,
      }),
    });

    const { routeGenerateStructured } = await import("@/lib/ai-runtime/router");
    const result = await routeGenerateStructured(
      {
        messages: [{ role: "user", content: "analyze this case" }],
        schema: { parse: () => ({ ok: true }) } as any,
        schemaName: "CodexCaseAnalysis",
      },
      "CASE_ANALYSIS",
      {},
    );

    // §27 contract: full codex ladder exhausted → ollama-cloud SUCCESS.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }

    // All three providers were called in routing-policy order:
    // codex-sdk → codex-cli → ollama-cloud.
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).toContain("ollama-cloud");

    const sdkIdx = calledIds.indexOf("codex-sdk");
    const cliIdx = calledIds.indexOf("codex-cli");
    const ollamaIdx = calledIds.indexOf("ollama-cloud");
    expect(sdkIdx).toBeLessThan(cliIdx);
    expect(cliIdx).toBeLessThan(ollamaIdx);
  });

  test("§27 variant — Codex SDK UNAVAILABLE → Codex CLI SUCCESS", async () => {
    // Variant of §27 where codex-cli succeeds — the router MUST stop at
    // codex-cli and MUST NOT call ollama-cloud.
    installMockRegistry({
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "UNAVAILABLE",
        provider: "codex-sdk",
        detail: "missing CODEX_API_KEY (§111)",
      }),
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "SUCCESS",
        provider: "codex-cli",
        value: "case-analysis-from-cli",
        latencyMs: 200,
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "SUCCESS",
        provider: "ollama-cloud",
        value: "case-analysis-from-ollama",
        latencyMs: 200,
      }),
      zai: makeFakeProvider("zai", {
        status: "SUCCESS",
        provider: "zai",
        value: "case-analysis-from-zai",
        latencyMs: 200,
      }),
    });

    const { routeGenerateStructured } = await import("@/lib/ai-runtime/router");
    const result = await routeGenerateStructured(
      {
        messages: [{ role: "user", content: "analyze this case" }],
        schema: { parse: () => ({ ok: true }) } as any,
        schemaName: "CodexCaseAnalysis",
      },
      "CASE_ANALYSIS",
      {},
    );

    // §27 variant contract: codex-sdk UNAVAILABLE → codex-cli SUCCESS.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-cli");
    }

    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("codex-cli");
    // ollama-cloud MUST NOT have been called (codex-cli short-circuited).
    expect(calledIds).not.toContain("ollama-cloud");
  });

  test("§84 — All 4 providers UNAVAILABLE for CASE_ANALYSIS → structured UNAVAILABLE result (NOT thrown)", async () => {
    // §84 contract: when every provider on the ladder returns UNAVAILABLE,
    // the router MUST return a structured UNAVAILABLE AiResult — it MUST
    // NOT throw an exception. The deterministic engine must still be able
    // to produce a partial report.
    //
    // CASE_ANALYSIS routing policy is [codex-sdk, codex-cli, ollama-cloud]
    // (length 3, no zai — §25). Zai is mocked for completeness but the
    // router will never reach it for this task.
    installMockRegistry({
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "UNAVAILABLE",
        provider: "codex-sdk",
        detail: "@openai/codex-sdk not installed",
      }),
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "UNAVAILABLE",
        provider: "codex-cli",
        detail: "`codex` binary not on PATH",
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "UNAVAILABLE",
        provider: "ollama-cloud",
        detail: "OLLAMA_CLOUD_ENABLED=false",
      }),
      zai: makeFakeProvider("zai", {
        status: "UNAVAILABLE",
        provider: "zai",
        detail: "z-ai SDK quota exhausted",
      }),
    });

    const { routeGenerateStructured } = await import("@/lib/ai-runtime/router");

    // The contract: NO exception is thrown — the call resolves to an
    // AiResult whose status is NOT SUCCESS.
    let result: AiResult<unknown> | null = null;
    let threw = false;
    try {
      result = await routeGenerateStructured(
        {
          messages: [{ role: "user", content: "analyze this case" }],
          schema: { parse: () => ({ ok: true }) } as any,
          schemaName: "CodexCaseAnalysis",
        },
        "CASE_ANALYSIS",
        {},
      );
    } catch (e) {
      threw = true;
      console.error("router threw unexpectedly:", e);
    }

    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.status).not.toBe("SUCCESS");
    expect(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "ERROR"]).toContain(
      result!.status,
    );
  });

  test("§85 — No provider storm: 20 parallel calls, zai called at most once", async () => {
    // §85 contract: when zai returns RATE_LIMITED, the router MUST trigger
    // cooldown IMMEDIATELY so the remaining parallel calls skip zai and
    // route straight to ollama-cloud. Without this, a 429 storm would
    // multiply into 20 zai calls (one per parallel request).
    //
    // Mechanism: Promise.all starts all 20 calls synchronously. Each call's
    // route() runs setup + eligibility check + invokes the provider's async
    // generateText(). The mock for zai synchronously calls `triggerCooldown`
    // BEFORE returning its canned RATE_LIMITED result, so by the time the
    // first await suspends call 1, the cooldown is already set. Sibling
    // calls 2–20 then run their eligibility check, see the cooldown, skip
    // zai, and route straight to ollama-cloud.
    let zaiCallCount = 0;
    let ollamaCallCount = 0;

    mock.module("@/lib/ai-runtime/registry", () => {
      return {
        getInstance: (id: AiProviderId) => {
          if (id === "zai") {
            return {
              id,
              capabilities: {
                structuredOutput: true,
                streaming: false,
                caseAnalysis: false,
                maxTokens: 1000,
                defaultTimeoutMs: 5000,
              },
              async health() {
                return { status: "HEALTHY" };
              },
              async generateText() {
                zaiCallCount += 1;
                // §85: trigger cooldown SYNCHRONOUSLY before returning so
                // sibling calls (whose eligibility check runs in the same
                // synchronous tick of Promise.all's setup loop) see the
                // cooldown and skip zai.
                triggerCooldown("zai", 60_000);
                return {
                  status: "RATE_LIMITED" as const,
                  provider: id,
                  retryAfterMs: 60_000,
                };
              },
              async generateStructured() {
                zaiCallCount += 1;
                triggerCooldown("zai", 60_000);
                return {
                  status: "RATE_LIMITED" as const,
                  provider: id,
                  retryAfterMs: 60_000,
                };
              },
            };
          }
          if (id === "ollama-cloud") {
            return {
              id,
              capabilities: {
                structuredOutput: true,
                streaming: false,
                caseAnalysis: false,
                maxTokens: 1000,
                defaultTimeoutMs: 5000,
              },
              async health() {
                return { status: "HEALTHY" };
              },
              async generateText() {
                ollamaCallCount += 1;
                return {
                  status: "SUCCESS" as const,
                  provider: id,
                  value: `ollama-${ollamaCallCount}`,
                  latencyMs: 1,
                };
              },
              async generateStructured() {
                ollamaCallCount += 1;
                return {
                  status: "SUCCESS" as const,
                  provider: id,
                  value: { n: ollamaCallCount },
                  latencyMs: 1,
                };
              },
            };
          }
          return undefined;
        },
        quickStatus: (id: AiProviderId) => {
          if (isInCooldown(id)) return "RATE_LIMITED" as const;
          return "HEALTHY" as const;
        },
        recordAttempt: () => {},
        getRuntimeState: () => ({
          status: "HEALTHY" as const,
          rateLimitedUntil: undefined,
          failures: 0,
          activeRequests: 0,
          lastErrorAt: undefined,
        }),
        updateRuntimeState: () => {},
        deriveHealthStatus: () => "HEALTHY" as const,
        healthSnapshot: async () => ({}),
        resetRegistry: () => {},
        ALL_PROVIDER_IDS: ["zai", "ollama-cloud"] as AiProviderId[],
      };
    });

    const { routeGenerateText } = await import("@/lib/ai-runtime/router");

    // Fire 20 calls in parallel.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        routeGenerateText(
          { messages: [{ role: "user", content: "parallel" }] },
          "QUERY_DECOMPOSITION",
          {},
        ),
      ),
    );

    // §85 contract: zai was called at most once — the first 429 trips the
    // cooldown; the remaining 19 calls see the cooldown and skip zai.
    expect(zaiCallCount).toBeLessThanOrEqual(1);

    // Every call resolved to ollama-cloud SUCCESS.
    for (const r of results) {
      expect(r.status).toBe("SUCCESS");
      if (r.status === "SUCCESS") {
        expect(r.provider).toBe("ollama-cloud");
      }
    }

    // Sanity: ollama-cloud was called once per parallel request (20 total —
    // 19 from the synchronous setup of calls 2..20, plus 1 from call 1's
    // continuation after the zai await resolves).
    expect(ollamaCallCount).toBe(20);

    // zai is still in cooldown.
    expect(isInCooldown("zai")).toBe(true);
  });
});
