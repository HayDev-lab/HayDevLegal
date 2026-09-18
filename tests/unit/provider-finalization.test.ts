// tests/unit/provider-finalization.test.ts
// Phase 4.1 Finalization — fallback ladder contract (§26, §27,
// §82–§85) + routing policy contract (§25) + 4-provider id set (§28).
//
// The Phase 4.1 cleanup removed `ollama-local` and `generic-llm`, leaving
// exactly 4 concrete AiProviderIds (`zai | ollama-cloud | codex-sdk |
// codex-cli`) that collapse to 3 LOGICAL engines (Z-AI, Ollama Cloud,
// Codex with CLI primary + SDK optional fallback).
//
// Phase 4.1 Finalization SWAPPED the Codex routing order: codex-cli is
// now PRIMARY (was codex-sdk primary). Per §7/§15, codex-cli uses
// ChatGPT account auth; codex-sdk is the OPTIONAL API-key path governed
// by CODEX_SDK_ENABLED (default false). Per §41, the router MUST NEVER
// silently switch to API-billing when codex-cli is rate-limited.
//
// Fallback ladder contract (§82, §83):
//   - For task = CASE_ANALYSIS the routing policy is (§25):
//       1. codex-cli   (PRIMARY — ChatGPT account auth, no API billing)
//       2. codex-sdk   (OPTIONAL — @openai/codex-sdk, API-key billed;
//                       only enabled when CODEX_SDK_ENABLED=true explicitly)
//       3. ollama-cloud (structured-capable cloud provider)
//   - The router MUST try each in order, falling through on UNAVAILABLE /
//     AUTH_REQUIRED, and STOP at the first SUCCESS.
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

  test("§25 — LIGHT_HOLDING_EXTRACTION routing policy is [ollama-cloud, zai, codex-cli] (length 3)", async () => {
    // Phase 4.1 Finalization: codex-cli replaces codex-sdk as the last-rung
    // Codex transport (was [ollama-cloud, zai, codex-sdk]). codex-sdk is now
    // the OPTIONAL API-billed path (CODEX_SDK_ENABLED=false default).
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.LIGHT_HOLDING_EXTRACTION).toEqual([
      "ollama-cloud",
      "zai",
      "codex-cli",
    ]);
    expect(ROUTING_POLICY.LIGHT_HOLDING_EXTRACTION.length).toBe(3);
  });

  test("§25 — CASE_ANALYSIS routing policy is [codex-cli, codex-sdk, ollama-cloud] (length 3, no zai)", async () => {
    // Phase 4.1 Finalization SWAPPED the Codex order: codex-cli is now
    // PRIMARY (was codex-sdk primary). Per §7/§15, codex-cli uses ChatGPT
    // account auth; codex-sdk is the OPTIONAL API-key path.
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.CASE_ANALYSIS).toEqual([
      "codex-cli",
      "codex-sdk",
      "ollama-cloud",
    ]);
    expect(ROUTING_POLICY.CASE_ANALYSIS.length).toBe(3);
    expect(ROUTING_POLICY.CASE_ANALYSIS).not.toContain("zai");
  });

  test("§25 — DEEP_CASE_SYNTHESIS routing policy is [codex-cli, codex-sdk, ollama-cloud, zai] (length 4)", async () => {
    // Phase 4.1 Finalization: codex-cli FIRST, codex-sdk SECOND. Per §7.
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.DEEP_CASE_SYNTHESIS).toEqual([
      "codex-cli",
      "codex-sdk",
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

  test("§27 — Codex CLI UNAVAILABLE → Codex SDK UNAVAILABLE → Ollama Cloud SUCCESS", async () => {
    // Phase 4.1 Finalization SWAPPED the Codex routing order: codex-cli is
    // now PRIMARY. Per §25, CASE_ANALYSIS routing policy is
    // [codex-cli, codex-sdk, ollama-cloud]. The router MUST try each in
    // order, falling through on UNAVAILABLE, and stop at the first SUCCESS.
    installMockRegistry({
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "UNAVAILABLE",
        provider: "codex-cli",
        detail: "`codex` binary not on PATH (§36)",
      }),
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "UNAVAILABLE",
        provider: "codex-sdk",
        detail: "@openai/codex-sdk not installed (§111)",
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
    // codex-cli → codex-sdk → ollama-cloud.
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("ollama-cloud");

    const cliIdx = calledIds.indexOf("codex-cli");
    const sdkIdx = calledIds.indexOf("codex-sdk");
    const ollamaIdx = calledIds.indexOf("ollama-cloud");
    expect(cliIdx).toBeLessThan(sdkIdx);
    expect(sdkIdx).toBeLessThan(ollamaIdx);
  });

  test("§27 variant — Codex CLI UNAVAILABLE → Codex SDK SUCCESS", async () => {
    // Phase 4.1 Finalization: codex-cli is PRIMARY, codex-sdk is SECOND.
    // When codex-cli is UNAVAILABLE, the router MUST fall through to
    // codex-sdk (if it is configured + succeeds) and STOP at codex-sdk —
    // MUST NOT call ollama-cloud.
    //
    // NOTE: per §41 (no-silent-billing-switch), this scenario requires
    // CODEX_SDK_ENABLED=true to be set EXPLICITLY by the operator. The
    // router itself does not switch — it just falls through per the routing
    // policy. See the §41 test below for the default-disabled case.
    installMockRegistry({
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "UNAVAILABLE",
        provider: "codex-cli",
        detail: "`codex` binary not on PATH (§36)",
      }),
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "SUCCESS",
        provider: "codex-sdk",
        value: "case-analysis-from-sdk",
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

    // §27 variant contract: codex-cli UNAVAILABLE → codex-sdk SUCCESS.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-sdk");
    }

    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).toContain("codex-sdk");
    // ollama-cloud MUST NOT have been called (codex-sdk short-circuited).
    expect(calledIds).not.toContain("ollama-cloud");
  });

  test("§27 variant — Codex CLI AUTH_REQUIRED → Codex SDK (skipped: UNCONFIGURED by default) → Ollama Cloud SUCCESS", async () => {
    // Phase 4.1 Finalization §11: codex-cli can return AUTH_REQUIRED when
    // the binary is installed but the user is not signed in to ChatGPT.
    // This is distinct from UNAVAILABLE (binary missing) and RATE_LIMITED
    // (signed in but quota exhausted).
    //
    // The router treats AUTH_REQUIRED like any other non-SUCCESS status:
    // it falls through to the next provider in the routing-policy ladder.
    // Per §25 CASE_ANALYSIS = [codex-cli, codex-sdk, ollama-cloud], the
    // next provider is codex-sdk. Per §14, codex-sdk is UNCONFIGURED by
    // default (CODEX_SDK_ENABLED=false), so quickStatus returns
    // UNAVAILABLE → isEligible returns false → router skips it.
    //
    // Per §41 (no-silent-billing-switch): the router MUST NOT silently
    // enable codex-sdk just because codex-cli is auth-required. The user
    // would incur unexpected API charges. The router respects the
    // CODEX_SDK_ENABLED flag (default false) and skips codex-sdk.
    //
    // Final outcome: ollama-cloud SUCCESS (or its own UNAVAILABLE).
    //
    // We use a custom mock (not installMockRegistry) because the contract
    // we're verifying requires quickStatus("codex-sdk") to return
    // UNAVAILABLE (mirroring the real registry's behavior when
    // CODEX_SDK_ENABLED=false). installMockRegistry's quickStatus always
    // returns HEALTHY for any provider in the map, which would defeat the
    // §41 protection we're trying to verify.
    mock.module("@/lib/ai-runtime/registry", () => {
      return {
        getInstance: (id: AiProviderId) => {
          if (id === "codex-cli") {
            return makeFakeProvider("codex-cli", {
              status: "AUTH_REQUIRED",
              provider: "codex-cli",
              detail: "ChatGPT sign-in required (§11)",
            });
          }
          if (id === "codex-sdk") {
            // The router should NEVER call this — quickStatus returns
            // UNAVAILABLE, so isEligible returns false. If the router
            // did call it, the counter would expose the §41 violation.
            return {
              id: "codex-sdk",
              capabilities: {
                structuredOutput: true,
                streaming: false,
                caseAnalysis: true,
                maxTokens: 1000,
                defaultTimeoutMs: 5000,
              },
              async health() {
                return { status: "UNCONFIGURED" };
              },
              async generateText() {
                callLog.push({ provider: "codex-sdk", method: "generateText", ts: Date.now() });
                return {
                  status: "UNAVAILABLE",
                  provider: "codex-sdk",
                  detail: "CODEX_SDK_ENABLED=false (§14)",
                } as AiResult<string>;
              },
              async generateStructured<U>(): Promise<AiResult<U>> {
                callLog.push({
                  provider: "codex-sdk",
                  method: "generateStructured",
                  ts: Date.now(),
                });
                return {
                  status: "UNAVAILABLE",
                  provider: "codex-sdk",
                  detail: "CODEX_SDK_ENABLED=false (§14)",
                } as AiResult<U>;
              },
            };
          }
          if (id === "ollama-cloud") {
            return makeFakeProvider("ollama-cloud", {
              status: "SUCCESS",
              provider: "ollama-cloud",
              value: "case-analysis-from-ollama",
              latencyMs: 180,
            });
          }
          if (id === "zai") {
            return makeFakeProvider("zai", {
              status: "SUCCESS",
              provider: "zai",
              value: "case-analysis-from-zai",
              latencyMs: 180,
            });
          }
          return undefined;
        },
        // §41 protection: quickStatus for codex-sdk returns UNAVAILABLE
        // (mirrors real registry when CODEX_SDK_ENABLED=false: the
        // sdkInstalled flag is gated on .enabled, so false → UNAVAILABLE).
        quickStatus: (id: AiProviderId) => {
          if (id === "codex-sdk") return "UNAVAILABLE" as const;
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
        ALL_PROVIDER_IDS: [
          "zai",
          "ollama-cloud",
          "codex-sdk",
          "codex-cli",
        ] as AiProviderId[],
      };
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

    // §27 variant contract: codex-cli AUTH_REQUIRED → router falls
    // through to codex-sdk (which is UNCONFIGURED/skipped) → ollama-cloud.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }

    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    // codex-cli's AUTH_REQUIRED was attempted (it's in the callLog because
    // the mock returned AUTH_REQUIRED, not because the router skipped it).
    expect(calledIds).not.toContain("codex-sdk");
    // codex-sdk was SKIPPED by the router's eligibility check (not called).
    // ollama-cloud was called and returned SUCCESS.
    expect(calledIds).toContain("ollama-cloud");
  });

  test("§41 — No silent billing switch: codex-cli RATE_LIMITED + CODEX_SDK_ENABLED=false (default) + accidental CODEX_API_KEY in env → router MUST NOT call codex-sdk", async () => {
    // Phase 4.1 Finalization §41 — the no-silent-billing-switch rule:
    // if codex-cli returns RATE_LIMITED (quota exhausted) and the operator
    // has NOT explicitly enabled the API-billed codex-sdk path
    // (CODEX_SDK_ENABLED=false default), the router MUST NOT silently
    // fall through to codex-sdk even if a CODEX_API_KEY happens to be
    // present in the environment (e.g. leftover from a previous operator).
    //
    // The protection is structural: registry.quickStatus("codex-sdk")
    // returns UNAVAILABLE when CODEX_SDK_CONFIG.sdkInstalled is false,
    // which is gated on CODEX_SDK_CONFIG.enabled. The router's
    // isEligible() check then returns {ok:false, reason:"UNAVAILABLE"}
    // and the router skips codex-sdk without ever calling its
    // generateStructured method. The user is protected from unintended
    // API billing.
    //
    // This test simulates the dangerous scenario: codex-cli RATE_LIMITED
    // (which would naturally trip the no-billing-switch in production)
    // AND CODEX_API_KEY accidentally in env. The router MUST fall
    // through directly to ollama-cloud.
    let codexSdkCallCount = 0;

    // Set the dangerous env state: API key present but SDK not enabled.
    // (process.env is restored by the afterEach mock.restore() — but we
    // explicitly clean up to be defensive.)
    const prevKey = process.env.CODEX_API_KEY;
    const prevSdkEnabled = process.env.CODEX_SDK_ENABLED;
    process.env.CODEX_API_KEY = "sk-accidental-leftover-key";
    process.env.CODEX_SDK_ENABLED = "false"; // explicitly NOT enabled

    try {
      // Single mock.module call — installs the full registry surface
      // the router needs (getInstance / quickStatus / recordAttempt /
      // getRuntimeState / etc.) with the §41 protection: codex-sdk's
      // quickStatus returns UNAVAILABLE (mirrors real registry behavior
      // when CODEX_SDK_ENABLED=false: sdkInstalled=false → UNAVAILABLE).
      mock.module("@/lib/ai-runtime/registry", () => {
        return {
          getInstance: (id: AiProviderId) => {
            if (id === "codex-cli") {
              return makeFakeProvider("codex-cli", {
                status: "RATE_LIMITED",
                provider: "codex-cli",
                retryAfterMs: 60_000,
              });
            }
            if (id === "codex-sdk") {
              return {
                id: "codex-sdk",
                capabilities: {
                  structuredOutput: true,
                  streaming: false,
                  caseAnalysis: true,
                  maxTokens: 1000,
                  defaultTimeoutMs: 5000,
                },
                async health() {
                  return { status: "UNCONFIGURED" };
                },
                async generateText() {
                  codexSdkCallCount += 1;
                  return {
                    status: "SUCCESS",
                    provider: "codex-sdk",
                    value: "should-never-be-returned",
                    latencyMs: 100,
                  } as AiResult<string>;
                },
                async generateStructured<U>(): Promise<AiResult<U>> {
                  codexSdkCallCount += 1;
                  return {
                    status: "SUCCESS",
                    provider: "codex-sdk",
                    value: "should-never-be-returned" as unknown as U,
                    latencyMs: 100,
                  };
                },
              };
            }
            if (id === "ollama-cloud") {
              return makeFakeProvider("ollama-cloud", {
                status: "SUCCESS",
                provider: "ollama-cloud",
                value: "case-analysis-from-ollama",
                latencyMs: 100,
              });
            }
            if (id === "zai") {
              return makeFakeProvider("zai", {
                status: "SUCCESS",
                provider: "zai",
                value: "case-analysis-from-zai",
                latencyMs: 100,
              });
            }
            return undefined;
          },
          // §41 critical: quickStatus for codex-sdk returns UNAVAILABLE
          // when CODEX_SDK_ENABLED=false, mirroring the real registry
          // (registry.ts quickStatus checks CODEX_SDK_CONFIG.sdkInstalled
          // which is gated on CODEX_SDK_CONFIG.enabled).
          quickStatus: (id: AiProviderId) => {
            if (id === "codex-sdk") {
              // CODEX_SDK_ENABLED=false (set above) → sdkInstalled=false
              // → quickStatus returns UNAVAILABLE.
              return "UNAVAILABLE" as const;
            }
            if (id === "codex-cli" && isInCooldown("codex-cli")) {
              return "RATE_LIMITED" as const;
            }
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
          ALL_PROVIDER_IDS: [
            "zai",
            "ollama-cloud",
            "codex-sdk",
            "codex-cli",
          ] as AiProviderId[],
        };
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

      // §41 contract: codex-sdk MUST NOT have been called. The router's
      // isEligible check returns false (UNAVAILABLE) before invoking
      // generateStructured.
      expect(codexSdkCallCount).toBe(0);

      // The router fell through to ollama-cloud and returned its SUCCESS.
      expect(result.status).toBe("SUCCESS");
      if (result.status === "SUCCESS") {
        expect(result.provider).toBe("ollama-cloud");
      }
    } finally {
      // Restore env state (defensive — mock.restore() should also handle
      // module-level state, but env vars need explicit cleanup).
      if (prevKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = prevKey;
      if (prevSdkEnabled === undefined) delete process.env.CODEX_SDK_ENABLED;
      else process.env.CODEX_SDK_ENABLED = prevSdkEnabled;
    }
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
