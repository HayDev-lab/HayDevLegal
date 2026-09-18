// tests/unit/router-fallback.test.ts
// AI Runtime router — sequential fallback contract (master prompt §56, §82).
//
// The router MUST try providers in routing-policy order, skipping those in
// cooldown / open-circuit / deadline-too-short, and STOP at the first
// SUCCESS or SUCCESS_EMPTY. Any other status (RATE_LIMITED, TIMEOUT,
// UNAVAILABLE, INVALID_SCHEMA, ERROR) MUST fall through to the next
// eligible provider (§56).
//
// Test contract (§82):
//   - Provider A (ollama-cloud) returns RATE_LIMITED.
//   - Provider B (zai) returns SUCCESS.
//   - router.route(task) → result.status === "SUCCESS", provider === "zai".
//   - Provider A's RATE_LIMITED is recorded so subsequent calls SKIP A
//     ("no provider storm", §85).
//
// Implementation note:
// The registry module is mocked via `mock.module()` so the router creates
// our fake providers instead of real ZaiProvider / OllamaCloudProvider
// instances (which would hit the network). The rate-limit module is NOT
// mocked — the router's `triggerCooldown` and `isInCooldown` calls go to
// the real per-provider cooldown tracker, which is exactly what production
// depends on.

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

// Real rate-limit / circuit-breaker / scheduler — we WANT the router to use
// the real cooldown tracker so we can verify the §85 contract.
import { isInCooldown, resetRateLimits, snapshotRateLimit } from "@/lib/ai-runtime/rate-limit";
import { resetBreakers } from "@/lib/ai-runtime/circuit-breaker";

// Type-only imports for safer mock construction.
import type { AiProvider, AiProviderId, AiResult } from "@/lib/ai-runtime/types";

// ---------------------------------------------------------------------------
// Test fixture — per-test call log + stateful mock registry
// ---------------------------------------------------------------------------

interface CallLogEntry {
  provider: string;
  method: "generateText" | "generateStructured";
  ts: number;
}

let callLog: CallLogEntry[] = [];

/**
 * Build a fake provider that records every call and returns the configured
 * canned AiResult. The router calls `generateText` / `generateStructured`
 * on this object — we only need `generateText` for the §82 contract.
 */
function makeFakeProvider(
  id: AiProviderId,
  canned: AiResult<string>,
): AiProvider {
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
      return { status: "HEALTHY", lastCheckedAt: Date.now() };
    },
    async generateText() {
      callLog.push({ provider: id, method: "generateText", ts: Date.now() });
      // Defensive copy so the router doesn't mutate the canned object.
      return { ...canned } as AiResult<string>;
    },
    async generateStructured<T>(): Promise<AiResult<T>> {
      callLog.push({ provider: id, method: "generateStructured", ts: Date.now() });
      // The mock returns the canned result regardless of T; cast through
      // unknown so the type-system doesn't fight us. The runtime shape is
      // verified by the assertions in each test case.
      return { ...canned } as unknown as AiResult<T>;
    },
  };
}

/**
 * Install a mock registry that maps id → fake provider. The mock is stateful
 * for `quickStatus` / `recordAttempt` so the router's eligibility check
 * behaves like production: after `recordAttempt(id, "RATE_LIMITED")`, the
 * subsequent `quickStatus(id)` returns "RATE_LIMITED".
 */
function installMockRegistry(providers: Partial<Record<AiProviderId, AiProvider>>): void {
  const states = new Map<AiProviderId, { status: string }>();

  mock.module("@/lib/ai-runtime/registry", () => {
    return {
      getInstance: (id: AiProviderId) => providers[id],
      quickStatus: (id: AiProviderId) => {
        const s = states.get(id);
        // Delegate to the real rate-limit module so cooldowns set by the
        // router's `triggerCooldown` are honored.
        if (isInCooldown(id)) return "RATE_LIMITED" as const;
        return (s?.status as "HEALTHY" | "RATE_LIMITED" | "UNCONFIGURED") ?? "HEALTHY";
      },
      recordAttempt: (id: AiProviderId, outcome: string) => {
        states.set(id, { status: outcome });
      },
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
      resetRegistry: () => states.clear(),
      ALL_PROVIDER_IDS: Object.keys(providers) as AiProviderId[],
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AI Runtime router — sequential fallback (§56, §82)", () => {
  beforeEach(() => {
    callLog = [];
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("Provider A (RATE_LIMITED) → fallback to Provider B (SUCCESS)", async () => {
    // QUERY_DECOMPOSITION routing policy is now [zai, ollama-cloud] per
    // Phase 4.1 Provider Finalization §25 (Z-AI is primary for fast
    // classification; Ollama Cloud is the cloud fallback; deterministic
    // parser is the implicit third tier).
    // zai returns RATE_LIMITED; ollama-cloud returns SUCCESS.
    installMockRegistry({
      zai: makeFakeProvider("zai", {
        status: "RATE_LIMITED",
        provider: "zai",
        retryAfterMs: 4000,
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "SUCCESS",
        provider: "ollama-cloud",
        value: "decomposed",
        latencyMs: 12,
      }),
    });

    // Dynamic import AFTER mock.module() is installed.
    const { routeGenerateText } = await import("@/lib/ai-runtime/router");
    const result = await routeGenerateText(
      { messages: [{ role: "user", content: "decompose this" }] },
      "QUERY_DECOMPOSITION",
      {},
    );

    // §82 contract: router MUST fall through to ollama-cloud and return its SUCCESS.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
      expect(result.value).toBe("decomposed");
    }

    // Both providers were called (ollama-cloud would have been skipped if
    // the router returned after the first RATE_LIMITED — that would be a
    // §56 violation).
    const calledIds = new Set(callLog.map((e) => e.provider));
    expect(calledIds.has("zai")).toBe(true);
    expect(calledIds.has("ollama-cloud")).toBe(true);
  });

  test("RATE_LIMITED provider enters cooldown — subsequent call skips it (§85 no provider storm)", async () => {
    // Per §25 QUERY_DECOMPOSITION: [zai, ollama-cloud]. After the first call,
    // zai is in cooldown (real rate-limit module). The second router call
    // MUST NOT touch zai — it should go straight to ollama-cloud.
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
                return {
                  status: "RATE_LIMITED" as const,
                  provider: id,
                  retryAfterMs: 60_000,
                };
              },
              async generateStructured() {
                zaiCallCount += 1;
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

    // First call: zai is healthy → it gets called, returns 429,
    // router falls through to ollama-cloud.
    const r1 = await routeGenerateText(
      { messages: [{ role: "user", content: "first" }] },
      "QUERY_DECOMPOSITION",
      {},
    );
    expect(r1.status).toBe("SUCCESS");
    if (r1.status === "SUCCESS") expect(r1.provider).toBe("ollama-cloud");

    // zai MUST now be in cooldown (router called triggerCooldown).
    expect(isInCooldown("zai")).toBe(true);
    const snap = snapshotRateLimit("zai");
    expect(snap.hits).toBeGreaterThanOrEqual(1);

    const zaiCallsAfterFirst = zaiCallCount;

    // Second call: zai is in cooldown → router MUST skip it.
    // It should go straight to ollama-cloud without touching zai again.
    const r2 = await routeGenerateText(
      { messages: [{ role: "user", content: "second" }] },
      "QUERY_DECOMPOSITION",
      {},
    );
    expect(r2.status).toBe("SUCCESS");
    if (r2.status === "SUCCESS") expect(r2.provider).toBe("ollama-cloud");

    // §85 contract: zai MUST NOT be called again while in cooldown.
    expect(zaiCallCount).toBe(zaiCallsAfterFirst);
  });

  test("All providers RATE_LIMITED → router returns RATE_LIMITED (not SUCCESS)", async () => {
    installMockRegistry({
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "RATE_LIMITED",
        provider: "ollama-cloud",
        retryAfterMs: 4000,
      }),
      zai: makeFakeProvider("zai", {
        status: "RATE_LIMITED",
        provider: "zai",
        retryAfterMs: 4000,
      }),
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "RATE_LIMITED",
        provider: "codex-sdk",
        retryAfterMs: 4000,
      }),
    });

    const { routeGenerateText } = await import("@/lib/ai-runtime/router");
    const result = await routeGenerateText(
      { messages: [{ role: "user", content: "x" }] },
      "QUERY_DECOMPOSITION",
      {},
    );

    // Contract: when every provider is rate-limited, the router MUST NOT
    // synthesize a SUCCESS. It returns a RATE_LIMITED AiResult (which one
    // depends on the implementation — could be the first or the last).
    expect(result.status).not.toBe("SUCCESS");
    // Most likely RATE_LIMITED, but UNAVAILABLE is also acceptable per the
    // "all providers exhausted" path in the router. The contract is: NEVER
    // claim SUCCESS when none was returned.
    expect(["RATE_LIMITED", "UNAVAILABLE", "ERROR", "TIMEOUT"]).toContain(result.status);
  });

  test("Provider returning SUCCESS_EMPTY short-circuits (router stops)", async () => {
    // SUCCESS_EMPTY is a valid terminal state (§20) — the document was
    // analyzed but no holding was found. The router MUST NOT fall through
    // to the next provider on SUCCESS_EMPTY.
    //
    // Per §25 QUERY_DECOMPOSITION: [zai, ollama-cloud]. zai returns
    // SUCCESS_EMPTY; ollama-cloud would have returned SUCCESS — the router
    // MUST stop at zai's SUCCESS_EMPTY.
    installMockRegistry({
      zai: makeFakeProvider("zai", {
        status: "SUCCESS_EMPTY",
        provider: "zai",
        latencyMs: 8,
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "SUCCESS",
        provider: "ollama-cloud",
        value: "should-not-be-returned",
        latencyMs: 5,
      }),
    });

    const { routeGenerateText } = await import("@/lib/ai-runtime/router");
    const result = await routeGenerateText(
      { messages: [{ role: "user", content: "extract" }] },
      "QUERY_DECOMPOSITION",
      {},
    );

    // §56: stop at the first SUCCESS or SUCCESS_EMPTY.
    expect(result.status).toBe("SUCCESS_EMPTY");
    if (result.status === "SUCCESS_EMPTY") {
      expect(result.provider).toBe("zai");
    }

    // ollama-cloud MUST NOT have been called.
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).not.toContain("ollama-cloud");
  });
});
