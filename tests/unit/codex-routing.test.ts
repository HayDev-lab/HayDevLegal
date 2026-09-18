// tests/unit/codex-routing.test.ts
// Codex routing ladder contract (master prompt §32–§37, §49, §83).
//
// For task = CASE_ANALYSIS the routing policy is (Phase 4.1 Provider
// Finalization §25):
//   1. codex-sdk   (preferred — @openai/codex-sdk, structured output)
//   2. codex-cli   (subprocess fallback when SDK is unavailable)
//   3. ollama-cloud (structured-capable cloud provider)
//
// (Z-AI is no longer in the CASE_ANALYSIS ladder per §25 — Codex is the
// sole deep-case-analysis engine. Z-AI remains the primary for
// QUERY_DECOMPOSITION and FINAL_ANSWER.)
//
// The router MUST:
//   - prefer codex-sdk when it can serve the request (§33)
//   - fall back to codex-cli when codex-sdk is UNAVAILABLE (no key / SDK
//     not installed — §35)
//   - fall back to ollama-cloud when codex-cli is also UNAVAILABLE (binary
//     not found — §36)
//   - return a structured UNAVAILABLE AiResult (NOT a thrown exception)
//     when every provider on the ladder is unavailable (§84 "all providers
//     down" deterministic-engine contract).
//
// Implementation note:
// The registry module is mocked via `mock.module()` so we can inject fake
// providers that return canned AiResults. This isolates the routing
// decision from real network / binary availability. The real rate-limit
// module is used so cooldowns work as in production.

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import { resetRateLimits } from "@/lib/ai-runtime/rate-limit";
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

  test("codex-sdk is the first provider selected for CASE_ANALYSIS", async () => {
    // All providers return SUCCESS — the router should call codex-sdk FIRST
    // and return its result (no fallback needed when the preferred provider
    // succeeds).
    installMockRegistry({
      "codex-sdk": makeFakeProvider("codex-sdk", {
        status: "SUCCESS",
        provider: "codex-sdk",
        value: "case-analysis-from-sdk",
        latencyMs: 100,
      }),
      "codex-cli": makeFakeProvider("codex-cli", {
        status: "SUCCESS",
        provider: "codex-cli",
        value: "case-analysis-from-cli",
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

    // §83 contract: codex-sdk is selected first.
    expect(callLog.length).toBeGreaterThan(0);
    expect(callLog[0].provider).toBe("codex-sdk");
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-sdk");
    }
  });

  test("codex-sdk UNAVAILABLE (no key) → fall back to codex-cli", async () => {
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

    // §83 contract: codex-sdk UNAVAILABLE → router falls through to codex-cli.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("codex-cli");
    }
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("codex-cli");
  });

  test("codex-sdk + codex-cli both UNAVAILABLE → fall back to ollama-cloud", async () => {
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

    // §83 contract: full codex ladder down → ollama-cloud.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }
    const calledIds = callLog.map((e) => e.provider);
    expect(calledIds).toContain("codex-sdk");
    expect(calledIds).toContain("codex-cli");
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

  test("CASE_ANALYSIS routing policy is [codex-sdk, codex-cli, ollama-cloud]", async () => {
    // Static contract (Phase 4.1 Provider Finalization §25): the routing
    // policy itself documents the codex ladder. Z-AI is intentionally NOT
    // in the CASE_ANALYSIS ladder — Codex is the sole deep-case analyzer.
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    const policy = ROUTING_POLICY.CASE_ANALYSIS;
    expect(policy[0]).toBe("codex-sdk");
    expect(policy[1]).toBe("codex-cli");
    expect(policy[2]).toBe("ollama-cloud");
    expect(policy.length).toBe(3);
  });
});
