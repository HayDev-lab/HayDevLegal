// tests/unit/codex-routing.test.ts
// Codex routing ladder contract (master prompt §32–§37, §49, §83).
//
// Phase 4.1 Finalization SWAPPED the Codex routing order: codex-cli is
// now PRIMARY (was codex-sdk primary). Per §7/§15, codex-cli uses
// ChatGPT account auth (no API billing); codex-sdk is the OPTIONAL
// API-key path governed by CODEX_SDK_ENABLED (default false).
//
// For task = CASE_ANALYSIS the routing policy is (§25):
//   1. codex-cli   (PRIMARY — ChatGPT account auth, no API billing)
//   2. codex-sdk   (OPTIONAL — @openai/codex-sdk, API-key billed;
//                   only enabled when CODEX_SDK_ENABLED=true explicitly)
//   3. ollama-cloud (structured-capable cloud provider)
//
// (Z-AI is no longer in the CASE_ANALYSIS ladder per §25 — Codex is the
// sole deep-case-analysis engine. Z-AI remains the primary for
// QUERY_DECOMPOSITION and FINAL_ANSWER.)
//
// The router MUST:
//   - prefer codex-cli when it can serve the request (§33)
//   - fall back to codex-sdk when codex-cli is UNAVAILABLE (binary not
//     found — §36) AND CODEX_SDK_ENABLED=true explicitly set (§14)
//   - fall back to ollama-cloud when codex-sdk is also UNAVAILABLE
//   - return a structured UNAVAILABLE AiResult (NOT a thrown exception)
//     when every provider on the ladder is unavailable (§84 "all providers
//     down" deterministic-engine contract).
//   - per §41 (no-silent-billing-switch), NEVER silently switch to the
//     API-billed codex-sdk path when codex-cli returns RATE_LIMITED or
//     AUTH_REQUIRED, unless the operator has explicitly set
//     CODEX_SDK_ENABLED=true.
//
// Implementation note:
// The registry module is mocked via `mock.module()` so we can inject fake
// providers that return canned AiResults. This isolates the routing
// decision from real network / binary availability. The real rate-limit
// module is used so cooldowns work as in production.

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import { resetRateLimits, isInCooldown } from "@/lib/ai-runtime/rate-limit";
import { resetBreakers } from "@/lib/ai-runtime/circuit-breaker";
import type {
  AiProvider,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
  AiTextRequest,
} from "@/lib/ai-runtime/types";

// ---------------------------------------------------------------------------
// Test fixture — per-provider call log + stateful mock registry
// ---------------------------------------------------------------------------

interface CallEntry {
  provider: AiProviderId;
  method: "generateStructured" | "generateText";
}

let callLog: CallEntry[] = [];

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
    async generateText(_req: AiTextRequest, _ctx: AiRuntimeContext): Promise<AiResult<string>> {
      callLog.push({ provider: id, method: "generateText" });
      // Coerce — the canned result for tests is small and shape-stable.
      return { ...(canned as unknown as AiResult<string>) } as AiResult<string>;
    },
    async generateStructured<U>(
      _req: AiStructuredRequest<U>,
      _ctx: AiRuntimeContext,
    ): Promise<AiResult<U>> {
      callLog.push({ provider: id, method: "generateStructured" });
      return { ...(canned as unknown as AiResult<U>) } as AiResult<U>;
    },
  };
}

function installMockRegistry(providers: Partial<Record<AiProviderId, AiProvider>>): void {
  mock.module("@/lib/ai-runtime/registry", () => {
    return {
      getInstance: (id: AiProviderId) => providers[id],
      quickStatus: (id: AiProviderId) => {
        if (providers[id] === undefined) return "UNCONFIGURED" as const;
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
// Tests
// ---------------------------------------------------------------------------

describe("Codex routing ladder (§32–§37, §49, §83)", () => {
  beforeEach(() => {
    callLog = [];
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("codex-cli is the first provider selected for CASE_ANALYSIS", async () => {
    // Phase 4.1 Finalization: codex-cli is now PRIMARY (was codex-sdk).
    // All providers return SUCCESS — the router should call codex-cli FIRST
    // and return its result (no fallback needed when the preferred provider
    // succeeds).
    installMockRegistry({
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "SUCCESS",
        provider: "codex-cli",
        value: "case-analysis-from-cli",
        latencyMs: 100,
      }),
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "SUCCESS",
        provider: "codex-sdk",
        value: "case-analysis-from-sdk",
        latencyMs: 100,
      }),
      "ollama-cloud": makeFakeProvider("ollama-cloud", {
        status: "SUCCESS",
        provider: "ollama-cloud",
        value: "case-analysis-from-ollama",
        latencyMs: 100,
      }),
      zai: makeFakeProvider("zai", {
        status: "SUCCESS",
        provider: "zai",
        value: "case-analysis-from-zai",
        latencyMs: 100,
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

    // §83 contract: codex-cli is selected first.
    expect(callLog.length).toBeGreaterThan(0);
    expect(callLog[0].provider).toBe("codex-cli");
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-cli");
    }
  });

  test("codex-cli UNAVAILABLE (binary not found) → fall back to codex-sdk", async () => {
    // Phase 4.1 Finalization: codex-cli is PRIMARY, codex-sdk is SECOND.
    // When codex-cli is UNAVAILABLE (binary not found per §36), the router
    // MUST fall through to codex-sdk.
    //
    // NOTE: per §41, this scenario in production requires CODEX_SDK_ENABLED=true
    // to be set EXPLICITLY by the operator. The router itself doesn't enforce
    // billing — it just falls through per the routing policy. The §41
    // protection (no-silent-billing-switch) lives in the registry's
    // quickStatus() returning UNAVAILABLE when CODEX_SDK_ENABLED=false.
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

    // §83 contract: codex-cli UNAVAILABLE → router falls through to codex-sdk.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-sdk");
    }
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).toContain("codex-sdk");
  });

  test("codex-cli + codex-sdk both UNAVAILABLE → fall back to ollama-cloud", async () => {
    // Phase 4.1 Finalization: codex-cli is PRIMARY, codex-sdk is SECOND.
    // When both Codex transports are UNAVAILABLE, the router falls through
    // to ollama-cloud (the third rung of the CASE_ANALYSIS ladder).
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

    // §83 contract: full codex ladder down → ollama-cloud.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("ollama-cloud");
  });

  test("all codex providers UNAVAILABLE → structured UNAVAILABLE result (NOT thrown)", async () => {
    // §84 contract: when every provider on the ladder is unavailable, the
    // router MUST return a structured UNAVAILABLE AiResult — it MUST NOT
    // throw an exception. The deterministic engine must still be able to
    // produce a partial report.
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
    expect(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "ERROR"]).toContain(result!.status);
  });

  test("CASE_ANALYSIS routing policy is [codex-cli, codex-sdk, ollama-cloud]", async () => {
    // Static contract (Phase 4.1 Finalization §25): the routing policy
    // itself documents the codex ladder. Phase 4.1 Finalization SWAPPED
    // the order: codex-cli is now PRIMARY (was codex-sdk). Z-AI is
    // intentionally NOT in the CASE_ANALYSIS ladder — Codex is the sole
    // deep-case analyzer.
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    const policy = ROUTING_POLICY.CASE_ANALYSIS;
    expect(policy[0]).toBe("codex-cli");
    expect(policy[1]).toBe("codex-sdk");
    expect(policy[2]).toBe("ollama-cloud");
    expect(policy.length).toBe(3);
  });

  test("§41 — codex-cli AUTH_REQUIRED does NOT silently trigger codex-sdk fallback when CODEX_SDK_ENABLED=false (default)", async () => {
    // Phase 4.1 Finalization §11 + §41: codex-cli can return AUTH_REQUIRED
    // (binary installed but ChatGPT not signed in). The router treats
    // AUTH_REQUIRED like any other non-SUCCESS status and falls through
    // to the next provider in the routing policy (codex-sdk).
    //
    // BUT per §41 (no-silent-billing-switch): the router MUST NOT silently
    // switch to the API-billed codex-sdk path. The protection is
    // structural: registry.quickStatus("codex-sdk") returns UNAVAILABLE
    // when CODEX_SDK_CONFIG.sdkInstalled is false, which is gated on
    // CODEX_SDK_CONFIG.enabled (default false). The router's
    // isEligible() check then returns false and codex-sdk is SKIPPED
    // without ever calling its generateStructured method.
    //
    // This test installs a custom mock whose quickStatus returns
    // UNAVAILABLE for codex-sdk (mirroring the real registry's behavior
    // when CODEX_SDK_ENABLED=false). The codex-sdk's generateStructured
    // is wired to a counter that MUST stay at 0.
    let codexSdkCallCount = 0;

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

    // §41 contract: codex-sdk MUST NOT have been called.
    expect(codexSdkCallCount).toBe(0);

    // The router fell through to ollama-cloud and returned its SUCCESS.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }

    // codex-cli was called (returning AUTH_REQUIRED). codex-sdk was NOT.
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-cli");
    expect(calledIds).not.toContain("codex-sdk");
    expect(calledIds).toContain("ollama-cloud");
  });
});
