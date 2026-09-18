// tests/unit/codex-chatgpt-auth.test.ts
// Codex ChatGPT auth detection contract — Phase 4.1 Finalization
// (master prompt §10, §11, §13, §14, §15, §36, §41).
//
// Phase 4.1 Finalization changes the Codex auth model:
//   - codex-cli is now the PRIMARY transport (was codex-sdk primary).
//   - Codex CLI uses ChatGPT account auth (NOT an API key). The user
//     MUST be signed in to ChatGPT for codex-cli to work; otherwise the
//     provider returns AUTH_REQUIRED (distinct from UNAVAILABLE for
//     "binary not found" and RATE_LIMITED for "signed in but quota
//     exhausted").
//   - codex-sdk (the OPTIONAL API-key billed path) is governed by
//     CODEX_SDK_ENABLED (default false). Per §41, the router MUST NEVER
//     silently switch to the API-billed path when codex-cli is
//     rate-limited or auth-required.
//
// ChatGPT auth detection lives in CodexCliProvider.health() (and in
// generateStructured()'s pre-check). The provider runs `codex login status`
// via spawnSync (no shell, 3s timeout — cheap; does NOT consume ChatGPT
// plan quota per §11). The auth probe is cached on the instance for 60s
// per §10 ("Cache auth/health state for a short TTL").
//
// Verified actual behavior of codex-cli 0.155.0 (per source comment):
//   - NOT logged in  → stdout empty, stderr="Not logged in\n", exit=1
//   - logged in      → stdout="Logged in as <email>\n", exit=0
//
// This test file covers:
//   1. Type contract: AiResult AUTH_REQUIRED variant + AiProviderHealthStatus
//      + ProviderRuntimeStatus all include AUTH_REQUIRED (§11).
//   2. Config defaults: CODEX_CLI_ENABLED=true (was false; Phase 4.1
//      Finalization §15 — CLI is PRIMARY), CODEX_SDK_ENABLED=false (§14 —
//      OPTIONAL only, never silent billing).
//   3. codex-cli health() behavior with mocked `node:child_process`:
//      - UNCONFIGURED when CODEX_CLI_ENABLED=false
//      - UNAVAILABLE when binary not found (spawnSync returns non-zero
//        for `--version`)
//      - AUTH_REQUIRED when binary available but `codex login status`
//        says "Not logged in"
//      - HEALTHY when binary available and `codex login status` says
//        "Logged in as ..."
//      - RATE_LIMITED when in cooldown (quota exhaustion — distinct from
//        AUTH_REQUIRED per §13; signed in but allowance exhausted)
//   4. No-silent-billing-switch rule (§41): codex-cli AUTH_REQUIRED does
//      NOT trigger codex-sdk fallback unless CODEX_SDK_ENABLED=true
//      explicitly. The router's isEligible() check + registry's
//      quickStatus() return UNAVAILABLE for codex-sdk when
//      CODEX_SDK_ENABLED=false, so codex-sdk is SKIPPED without ever
//      calling its generateStructured method.
//
// Implementation note:
// We mock `node:child_process` via `mock.module()` to inject a fake
// spawnSync that returns canned output for `--version` and
// `codex login status`. The mock is sticky across test files (per the
// existing pattern in provider-finalization.test.ts); each test
// re-installs the mock to override the previous one. CodexCliProvider is
// cache-bust-imported per test so the binaryCache + authCache on the
// instance start fresh.

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";

import { resetRateLimits, isInCooldown, triggerCooldown } from "@/lib/ai-runtime/rate-limit";
import { resetBreakers } from "@/lib/ai-runtime/circuit-breaker";

// Type-only imports for safer mock construction.
import type {
  AiProvider,
  AiProviderHealth,
  AiProviderHealthStatus,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
  ProviderRuntimeStatus,
} from "@/lib/ai-runtime/types";

// ---------------------------------------------------------------------------
// Mock helpers — install a fake `node:child_process` whose spawnSync
// returns canned output based on the args. We also export no-op stubs
// for `spawn` / `execFile` etc. so other modules that import the same
// node builtin don't blow up on missing exports.
// ---------------------------------------------------------------------------

interface SpawnSyncMockOpts {
  /** What `--version` should return. Default: status 0, stdout codex-cli 0.155.0. */
  versionStatus?: number;
  versionStdout?: string;
  /** What `codex login status` should return. Default: status 1, stderr "Not logged in". */
  loginStatusExit?: number;
  loginStatusStdout?: string;
  loginStatusStderr?: string;
}

/**
 * Install a mock for `node:child_process` whose spawnSync returns canned
 * output for `--version` and `codex login status` based on the args.
 *
 * The mock also exports no-op stubs for `spawn`, `execFile`, `exec`,
 * `execFileSync`, `fork` so other modules that import these named
 * exports don't fail on "Export named X not found in module
 * 'node:child_process'".
 */
function installChildProcessMock(opts: SpawnSyncMockOpts = {}): void {
  const versionStatus = opts.versionStatus ?? 0;
  const versionStdout = opts.versionStdout ?? "codex-cli 0.155.0\n";
  const loginExit = opts.loginStatusExit ?? 1;
  const loginStdout = opts.loginStatusStdout ?? "";
  const loginStderr = opts.loginStatusStderr ?? "Not logged in\n";

  const fakeSpawnSync = (cmd: string, args: string[]): {
    status: number;
    stdout: string;
    stderr: string;
  } => {
    if (args[0] === "--version") {
      return { status: versionStatus, stdout: versionStdout, stderr: "" };
    }
    if (args[0] === "login" && args[1] === "status") {
      return { status: loginExit, stdout: loginStdout, stderr: loginStderr };
    }
    // Default — unknown command.
    return { status: 1, stdout: "", stderr: "unknown command\n" };
  };

  mock.module("node:child_process", () => ({
    spawnSync: fakeSpawnSync,
    // No-op stubs — only spawnSync is exercised by the health() tests.
    spawn: () => ({
      stdout: { on() {} },
      stderr: { on() {} },
      on() {},
      kill() {},
    }),
    execFile: () => {},
    exec: () => {},
    execFileSync: () => {},
    fork: () => ({}),
  }));
}

// ---------------------------------------------------------------------------
// Tests — type contract (§11)
// ---------------------------------------------------------------------------

describe("Codex ChatGPT auth detection — type contract (§11)", () => {
  test("AiResult AUTH_REQUIRED variant exists in the discriminated union", () => {
    // The compile-time check is the exhaustive-switch test in
    // ai-result-states.test.ts; this is the value-level check.
    const r: AiResult<string> = {
      status: "AUTH_REQUIRED",
      provider: "codex-cli",
      detail: "ChatGPT sign-in required",
    };
    expect(r.status).toBe("AUTH_REQUIRED");
    if (r.status === "AUTH_REQUIRED") {
      expect(r.provider).toBe("codex-cli");
      expect(r.detail).toBe("ChatGPT sign-in required");
    }
  });

  test("AiProviderHealthStatus includes AUTH_REQUIRED", () => {
    // Compile-time check: if AUTH_REQUIRED is not in the union, this
    // assignment won't type-check.
    const s: AiProviderHealthStatus = "AUTH_REQUIRED";
    expect(s).toBe("AUTH_REQUIRED");
  });

  test("ProviderRuntimeStatus includes AUTH_REQUIRED", () => {
    const s: ProviderRuntimeStatus = "AUTH_REQUIRED";
    expect(s).toBe("AUTH_REQUIRED");
  });

  test("AiProviderHealth can carry AUTH_REQUIRED + detail", () => {
    const h: AiProviderHealth = {
      status: "AUTH_REQUIRED",
      detail: "ChatGPT sign-in required",
      lastCheckedAt: 12345,
    };
    expect(h.status).toBe("AUTH_REQUIRED");
    expect(h.detail).toBe("ChatGPT sign-in required");
    expect(h.lastCheckedAt).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Tests — config defaults (Phase 4.1 Finalization §14, §15)
// ---------------------------------------------------------------------------

describe("Codex config defaults — Phase 4.1 Finalization §14, §15", () => {
  test("§15 — CODEX_CLI_ENABLED defaults to true (CLI is PRIMARY transport)", async () => {
    // The config module reads process.env at module load. We need the
    // REAL default, so we cache-bust the import (any prior mock.module
    // for the config module would shadow the real one). The default
    // value is `true` per config.ts line 137 (envBool default = true).
    // NOTE: we DO NOT set process.env.CODEX_CLI_ENABLED here — we want
    // to verify the default, which means the env var must be undefined.
    const prev = process.env.CODEX_CLI_ENABLED;
    delete process.env.CODEX_CLI_ENABLED;
    try {
      const { CODEX_CLI_CONFIG } = await import(
        `@/lib/ai-runtime/config?t=${Date.now()}`
      );
      expect(CODEX_CLI_CONFIG.enabled).toBe(true);
    } finally {
      if (prev !== undefined) process.env.CODEX_CLI_ENABLED = prev;
    }
  });

  test("§14 — CODEX_SDK_ENABLED defaults to false (OPTIONAL API-key path; never silent billing)", async () => {
    // Per §14, the API-key path is OPTIONAL only. Default false so the
    // router never silently switches to API-billed codex-sdk when
    // codex-cli is rate-limited (§41).
    const prev = process.env.CODEX_SDK_ENABLED;
    delete process.env.CODEX_SDK_ENABLED;
    try {
      const { CODEX_SDK_CONFIG } = await import(
        `@/lib/ai-runtime/config?t=${Date.now()}`
      );
      expect(CODEX_SDK_CONFIG.enabled).toBe(false);
    } finally {
      if (prev !== undefined) process.env.CODEX_SDK_ENABLED = prev;
    }
  });

  test("§25 — ROUTING_POLICY.CASE_ANALYSIS is [codex-cli, codex-sdk, ollama-cloud] (codex-cli FIRST)", async () => {
    // Phase 4.1 Finalization SWAPPED the Codex order: codex-cli is
    // PRIMARY (was codex-sdk primary).
    const { ROUTING_POLICY } = await import("@/lib/ai-runtime/config");
    expect(ROUTING_POLICY.CASE_ANALYSIS[0]).toBe("codex-cli");
    expect(ROUTING_POLICY.CASE_ANALYSIS[1]).toBe("codex-sdk");
    expect(ROUTING_POLICY.CASE_ANALYSIS[2]).toBe("ollama-cloud");
  });
});

// ---------------------------------------------------------------------------
// Tests — CodexCliProvider.health() with mocked spawnSync
// (§10, §11, §13, §15, §36, §111)
//
// We mock `node:child_process` to control what `codex --version` and
// `codex login status` return. Each test cache-bust-imports the codex-cli
// provider module so the instance's binaryCache + authCache start fresh
// (the cache TTL is 60s per §10 — we don't want test 1's cached AUTH_REQUIRED
// to leak into test 2's HEALTHY assertion).
// ---------------------------------------------------------------------------

describe("CodexCliProvider.health() — ChatGPT auth detection (§10, §11, §36, §111)", () => {
  beforeEach(() => {
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("§11 — health() returns AUTH_REQUIRED when CLI binary available but `codex login status` says 'Not logged in'", async () => {
    // Simulate: codex binary IS installed (version probe succeeds) but
    // ChatGPT account is NOT signed in (login status says "Not logged in").
    // Expected: health() returns AUTH_REQUIRED (NOT UNAVAILABLE, NOT
    // RATE_LIMITED, NOT ERROR). Distinct from UNAVAILABLE (binary missing)
    // and RATE_LIMITED (signed in but quota exhausted).
    installChildProcessMock({
      versionStatus: 0,
      versionStdout: "codex-cli 0.155.0\n",
      loginStatusExit: 1,
      loginStatusStdout: "",
      loginStatusStderr: "Not logged in\n",
    });

    // Cache-bust the provider module so the instance starts fresh.
    const providerMod = await import(
      `@/lib/ai-runtime/providers/codex-cli?t=${Date.now()}`
    );
    const provider = new providerMod.CodexCliProvider();
    const health = await provider.health();

    expect(health.status).toBe("AUTH_REQUIRED");
    expect(health.detail).toContain("sign-in");
    expect(health.lastCheckedAt).toBeDefined();
    // Negative assertions: AUTH_REQUIRED is NOT UNAVAILABLE (binary IS
    // installed), NOT RATE_LIMITED (we don't yet know about quota), NOT
    // ERROR (the probe succeeded).
    expect(health.status).not.toBe("UNAVAILABLE");
    expect(health.status).not.toBe("RATE_LIMITED");
    expect(health.status).not.toBe("ERROR");
  });

  test("§11 — health() returns HEALTHY when CLI binary available and `codex login status` says 'Logged in as ...'", async () => {
    // Simulate: codex binary installed + ChatGPT account signed in.
    // Expected: health() returns HEALTHY.
    installChildProcessMock({
      versionStatus: 0,
      versionStdout: "codex-cli 0.155.0\n",
      loginStatusExit: 0,
      loginStatusStdout: "Logged in as user@example.com\n",
      loginStatusStderr: "",
    });

    const providerMod = await import(
      `@/lib/ai-runtime/providers/codex-cli?t=${Date.now()}`
    );
    const provider = new providerMod.CodexCliProvider();
    const health = await provider.health();

    expect(health.status).toBe("HEALTHY");
    expect(health.lastCheckedAt).toBeDefined();
  });

  test("§36 — health() returns UNAVAILABLE when CLI binary not found (§111 — never fake a pass)", async () => {
    // Simulate: codex binary not on PATH (version probe returns non-zero
    // for all candidate paths). Expected: health() returns UNAVAILABLE
    // (NOT AUTH_REQUIRED — the binary itself is missing, so we can't
    // even run `codex login status`).
    //
    // NOTE: probeCodexBinary() uses `require("node:child_process").spawnSync`
    // (line 388 of codex-cli.ts). In bun, the require()'d spawnSync does NOT
    // respect mock.module for node:child_process — the ESM-imported
    // spawnSync (used by probeChatGptAuth) DOES. To make this test work,
    // we override the provider's resolveBinary() method to return
    // {available:false, path:null} directly, bypassing the require() path.
    // This mirrors the production code path: when the binary is truly
    // unavailable, resolveBinary returns {available:false}.
    installChildProcessMock({
      versionStatus: 0, // mocked but not used (we override resolveBinary)
    });

    const providerMod = await import(
      `@/lib/ai-runtime/providers/codex-cli?t=${Date.now()}`
    );
    const provider = new providerMod.CodexCliProvider();

    // Override the binary probe result to simulate "binary not found".
    // This bypasses probeCodexBinary's require() call (which doesn't
    // respect mock.module in bun) and directly returns the not-found state.
    (provider as unknown as {
      resolveBinary: () => { available: boolean; path: string | null };
    }).resolveBinary = () => ({ available: false, path: null });

    const health = await provider.health();

    expect(health.status).toBe("UNAVAILABLE");
    expect(health.detail).toContain("binary");
    // Negative: NOT AUTH_REQUIRED (we couldn't even probe auth).
    expect(health.status).not.toBe("AUTH_REQUIRED");
  });

  test("§15 — health() returns UNCONFIGURED when CODEX_CLI_ENABLED=false", async () => {
    // Per §15, CODEX_CLI_ENABLED defaults to true. When the operator
    // explicitly disables it, health() returns UNCONFIGURED (the
    // provider is intentionally off).
    //
    // We can't reliably set CODEX_CLI_ENABLED=false via env because
    // config.ts reads it at module load time, and the config module is
    // already cached (loaded by previous tests). We can't cache-bust
    // the config module in a way that propagates to codex-cli's
    // `import "../config"` (the standard import path doesn't pick up
    // the cache-bust version).
    //
    // Instead, we directly mutate CODEX_CLI_CONFIG.enabled (the codebase
    // already does this in registry.ts line 75-77). This is a runtime
    // override that health() honors — CODEX_CLI_CONFIG.enabled is read
    // at health() call time, not at module load.
    installChildProcessMock({
      versionStatus: 0,
    });

    // Import the REAL config module (not cache-bust, so we get the
    // same instance codex-cli.ts uses).
    const { CODEX_CLI_CONFIG } = await import("@/lib/ai-runtime/config");
    const prevEnabled = CODEX_CLI_CONFIG.enabled;
    // Mutate the .enabled field — this is read at health() call time.
    (CODEX_CLI_CONFIG as { enabled: boolean }).enabled = false;

    try {
      const providerMod = await import(
        `@/lib/ai-runtime/providers/codex-cli?t=${Date.now()}`
      );
      const provider = new providerMod.CodexCliProvider();
      const health = await provider.health();

      expect(health.status).toBe("UNCONFIGURED");
      expect(health.detail).toContain("CODEX_CLI_ENABLED=false");
    } finally {
      // Restore the .enabled field.
      (CODEX_CLI_CONFIG as { enabled: boolean }).enabled = prevEnabled;
    }
  });

  test("§13 — health() returns RATE_LIMITED when in cooldown (quota exhaustion; NOT AUTH_FAILED, NOT UNAVAILABLE, NOT ERROR)", async () => {
    // Per §13, codex-cli quota exhaustion (signed in but ChatGPT plan
    // Codex allowance exhausted) is classified as RATE_LIMITED — NOT
    // AUTH_FAILED, NOT UNAVAILABLE, NOT ERROR. The cooldown is triggered
    // by the generateStructured() error path when stderr matches a quota
    // exhaustion indicator; for health(), we test that being IN cooldown
    // (regardless of how we got there) returns RATE_LIMITED.
    //
    // The cooldown check runs BEFORE the ChatGPT auth probe — if we're
    // in cooldown, the auth state is irrelevant (we already know we hit
    // a quota limit and are waiting it out).
    installChildProcessMock({
      versionStatus: 0,
      versionStdout: "codex-cli 0.155.0\n",
      // Even if `codex login status` would say "Logged in", the cooldown
      // check returns RATE_LIMITED before the auth probe runs.
      loginStatusExit: 0,
      loginStatusStdout: "Logged in as user@example.com\n",
    });

    const providerMod = await import(
      `@/lib/ai-runtime/providers/codex-cli?t=${Date.now()}`
    );
    const provider = new providerMod.CodexCliProvider();

    // Trigger cooldown BEFORE calling health().
    triggerCooldown("codex-cli", 60_000);
    expect(isInCooldown("codex-cli")).toBe(true);

    const health = await provider.health();

    expect(health.status).toBe("RATE_LIMITED");
    expect(health.detail).toContain("cooldown");
    // Negative: NOT AUTH_REQUIRED (we're signed in but exhausted), NOT
    // UNAVAILABLE (binary IS installed), NOT ERROR.
    expect(health.status).not.toBe("AUTH_REQUIRED");
    expect(health.status).not.toBe("UNAVAILABLE");
    expect(health.status).not.toBe("ERROR");
  });
});

// ---------------------------------------------------------------------------
// Tests — no-silent-billing-switch rule (§41)
//
// Per §41: when codex-cli returns RATE_LIMITED or AUTH_REQUIRED, the
// router MUST NOT silently switch to the API-billed codex-sdk path. The
// protection is structural:
//   - registry.quickStatus("codex-sdk") returns UNAVAILABLE when
//     CODEX_SDK_CONFIG.sdkInstalled is false (which is gated on
//     CODEX_SDK_CONFIG.enabled — default false).
//   - The router's isEligible() check then returns false → codex-sdk
//     is SKIPPED without ever calling its generateStructured method.
//
// We verify this by mocking the registry and asserting that codex-sdk's
// generateStructured counter stays at 0.
// ---------------------------------------------------------------------------

describe("§41 — no-silent-billing-switch (Codex SDK fallback protection)", () => {
  beforeEach(() => {
    resetRateLimits();
    resetBreakers();
  });

  afterEach(() => {
    mock.restore();
  });

  test("§41 — codex-cli AUTH_REQUIRED does NOT trigger codex-sdk fallback when CODEX_SDK_ENABLED=false (default)", async () => {
    // Mock the registry: codex-cli returns AUTH_REQUIRED, codex-sdk's
    // quickStatus returns UNAVAILABLE (mirroring real registry behavior
    // when CODEX_SDK_ENABLED=false: sdkInstalled=false → UNAVAILABLE).
    // codex-sdk's generateStructured is wired to a counter that MUST
    // stay at 0 — the router's isEligible check skips codex-sdk before
    // calling it.
    let codexSdkCallCount = 0;
    let codexCliCallCount = 0;
    let ollamaCallCount = 0;

    mock.module("@/lib/ai-runtime/registry", () => {
      const fakeProvider = (id: AiProviderId, behavior: {
        status: AiResult<unknown>["status"];
        detail?: string;
      }): AiProvider => ({
        id,
        capabilities: {
          structuredOutput: true,
          streaming: false,
          caseAnalysis: id === "codex-cli" || id === "codex-sdk",
          maxTokens: 1000,
          defaultTimeoutMs: 5000,
        },
        async health() {
          return { status: "HEALTHY" };
        },
        async generateText() {
          return { status: "UNAVAILABLE", provider: id, detail: "not impl" } as AiResult<string>;
        },
        async generateStructured<U>(): Promise<AiResult<U>> {
          if (id === "codex-cli") {
            codexCliCallCount += 1;
            return {
              status: behavior.status,
              provider: id,
              detail: behavior.detail ?? "AUTH_REQUIRED",
            } as AiResult<U>;
          }
          if (id === "codex-sdk") {
            codexSdkCallCount += 1;
            return {
              status: "SUCCESS",
              provider: id,
              value: "should-never-be-returned" as unknown as U,
              latencyMs: 100,
            } as AiResult<U>;
          }
          if (id === "ollama-cloud") {
            ollamaCallCount += 1;
            return {
              status: "SUCCESS",
              provider: id,
              value: "case-from-ollama" as unknown as U,
              latencyMs: 100,
            } as AiResult<U>;
          }
          return { status: "UNAVAILABLE", provider: id, detail: "not impl" } as AiResult<U>;
        },
      });

      return {
        getInstance: (id: AiProviderId) => {
          if (id === "codex-cli") return fakeProvider("codex-cli", { status: "AUTH_REQUIRED" });
          if (id === "codex-sdk") return fakeProvider("codex-sdk", { status: "SUCCESS" });
          if (id === "ollama-cloud") return fakeProvider("ollama-cloud", { status: "SUCCESS" });
          if (id === "zai") return fakeProvider("zai", { status: "SUCCESS" });
          return undefined;
        },
        // §41 protection: codex-sdk returns UNAVAILABLE (sdkInstalled=false
        // when CODEX_SDK_ENABLED=false).
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
    // codex-cli WAS called (returned AUTH_REQUIRED).
    expect(codexCliCallCount).toBe(1);
    // ollama-cloud WAS called (returned SUCCESS).
    expect(ollamaCallCount).toBe(1);

    // The router fell through to ollama-cloud.
    expect(result.status).toBe("SUCCESS");
    if (result.status === "SUCCESS") {
      expect(result.provider).toBe("ollama-cloud");
    }
  });

  test("§41 — codex-cli RATE_LIMITED does NOT trigger codex-sdk fallback when CODEX_SDK_ENABLED=false (default) + accidental CODEX_API_KEY in env", async () => {
    // The most dangerous scenario: codex-cli is RATE_LIMITED (quota
    // exhausted) AND CODEX_API_KEY happens to be in env (leftover from
    // a previous operator). The router MUST NOT silently switch to
    // the API-billed codex-sdk path.
    //
    // The protection is structural: registry.quickStatus("codex-sdk")
    // returns UNAVAILABLE when CODEX_SDK_CONFIG.sdkInstalled is false,
    // which is gated on CODEX_SDK_CONFIG.enabled (default false).
    let codexSdkCallCount = 0;

    // Set the dangerous env state.
    const prevKey = process.env.CODEX_API_KEY;
    const prevSdkEnabled = process.env.CODEX_SDK_ENABLED;
    process.env.CODEX_API_KEY = "sk-accidental-leftover-key";
    process.env.CODEX_SDK_ENABLED = "false";

    try {
      mock.module("@/lib/ai-runtime/registry", () => {
        const fakeProvider = (id: AiProviderId): AiProvider => ({
          id,
          capabilities: {
            structuredOutput: true,
            streaming: false,
            caseAnalysis: id === "codex-cli" || id === "codex-sdk",
            maxTokens: 1000,
            defaultTimeoutMs: 5000,
          },
          async health() {
            return { status: "HEALTHY" };
          },
          async generateText() {
            return { status: "UNAVAILABLE", provider: id, detail: "not impl" } as AiResult<string>;
          },
          async generateStructured<U>(): Promise<AiResult<U>> {
            if (id === "codex-cli") {
              return {
                status: "RATE_LIMITED",
                provider: id,
                retryAfterMs: 60_000,
              } as AiResult<U>;
            }
            if (id === "codex-sdk") {
              codexSdkCallCount += 1;
              return {
                status: "SUCCESS",
                provider: id,
                value: "should-never-be-returned" as unknown as U,
                latencyMs: 100,
              } as AiResult<U>;
            }
            if (id === "ollama-cloud") {
              return {
                status: "SUCCESS",
                provider: id,
                value: "case-from-ollama" as unknown as U,
                latencyMs: 100,
              } as AiResult<U>;
            }
            return { status: "UNAVAILABLE", provider: id, detail: "not impl" } as AiResult<U>;
          },
        });

        return {
          getInstance: (id: AiProviderId) => {
            if (id === "codex-cli") return fakeProvider("codex-cli");
            if (id === "codex-sdk") return fakeProvider("codex-sdk");
            if (id === "ollama-cloud") return fakeProvider("ollama-cloud");
            if (id === "zai") return fakeProvider("zai");
            return undefined;
          },
          // §41 critical: codex-sdk quickStatus returns UNAVAILABLE
          // (mirrors real registry when CODEX_SDK_ENABLED=false:
          // sdkInstalled=false → UNAVAILABLE).
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
      // The router fell through to ollama-cloud.
      expect(result.status).toBe("SUCCESS");
      if (result.status === "SUCCESS") {
        expect(result.provider).toBe("ollama-cloud");
      }
    } finally {
      if (prevKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = prevKey;
      if (prevSdkEnabled === undefined) delete process.env.CODEX_SDK_ENABLED;
      else process.env.CODEX_SDK_ENABLED = prevSdkEnabled;
    }
  });
});
