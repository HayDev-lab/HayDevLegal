// tests/unit/health-three-providers.test.ts
// /api/health endpoint contract — Phase 4.1 Finalization
// (master prompt §29, §69, §70, §11).
//
// Phase 4.1 Finalization changed the user-facing health payload:
//   - codex.transport values: "cli-chatgpt" | "sdk-api" | "unavailable"
//     (was "sdk" | "cli" | "unavailable"). The new values make the
//     billing model explicit: "cli-chatgpt" = ChatGPT account auth,
//     "sdk-api" = API-key billed (only when CODEX_SDK_ENABLED=true).
//   - codex.status can include "AUTH_REQUIRED" (CLI installed but
//     ChatGPT not signed in — distinct from "UNAVAILABLE" for binary
//     missing and "RATE_LIMITED" for quota exhausted).
//   - codex.status can include "RATE_LIMITED" (signed in but ChatGPT
//     plan Codex allowance exhausted — distinct from "AUTH_REQUIRED";
//     per §41, do NOT silently switch to API-key billing).
//
// After the Phase 4.1 cleanup, the user-facing health payload exposes
// EXACTLY 3 logical providers (Z-AI, Ollama Cloud, Codex with a
// `transport: "cli-chatgpt" | "sdk-api" | "unavailable"` field reflecting
// which underlying Codex transport is currently healthy). The two concrete
// Codex variants (codex-sdk, codex-cli) are collapsed into a single `codex`
// entry — they are NOT exposed as separate top-level keys.
//
// This is verified by directly invoking the route handler `GET()`:
//   import { GET } from "@/app/api/health/route";
//   const response = await GET();
//   const body = await response.json();
//
// The route already caches the AI runtime snapshot (§70 — 30s TTL) and
// fails open (returns empty providers + zero metrics) if the runtime is
// not yet built. For tests that need to control the codex-cli health
// snapshot (e.g. AUTH_REQUIRED / RATE_LIMITED injection), we mock
// `@/lib/ai-runtime` and use a cache-busting dynamic import of the route
// module to bypass the 30s cache (each test gets a fresh module instance
// with cachedHealth.fetchedAt=0).

import { afterEach, describe, expect, test, mock } from "bun:test";

describe("/api/health — Phase 4.1 three-logical-providers contract (§29, §69)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("§29 — exposes exactly 3 logical providers (zai, ollama-cloud, codex)", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.aiProviders).toBeDefined();
    expect(typeof body.aiProviders).toBe("object");

    const keys = Object.keys(body.aiProviders).sort();
    expect(keys).toEqual(["codex", "ollama-cloud", "zai"]);

    // No removed provider ids leak through.
    expect(keys).not.toContain("ollama-local");
    expect(keys).not.toContain("generic-llm");
    // No codex-sdk / codex-cli as separate top-level entries — they are
    // collapsed into the single `codex` logical provider per §28–§29.
    expect(keys).not.toContain("codex-sdk");
    expect(keys).not.toContain("codex-cli");
  });

  test("§29 — codex.transport field is one of cli-chatgpt | sdk-api | unavailable", async () => {
    // Phase 4.1 Finalization: transport values renamed to make the
    // billing model explicit:
    //   - "cli-chatgpt" = ChatGPT account auth (PRIMARY per §15)
    //   - "sdk-api"     = API-key billed (OPTIONAL per §14; only when
    //                     CODEX_SDK_ENABLED=true explicitly)
    //   - "unavailable" = neither transport healthy
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    expect(typeof codex.transport).toBe("string");
    expect(["cli-chatgpt", "sdk-api", "unavailable"]).toContain(codex.transport);
  });

  test("§29 — codex.status field is a string from the known status set (incl. AUTH_REQUIRED)", async () => {
    // Phase 4.1 Finalization §11: AUTH_REQUIRED is a new AiProviderHealthStatus
    // for "CLI installed but ChatGPT not signed in" (distinct from UNAVAILABLE
    // for binary missing and RATE_LIMITED for quota exhausted).
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    expect(typeof codex.status).toBe("string");
    // Status values come from AiProviderHealthStatus (§17 + §11):
    // HEALTHY | UNCONFIGURED | AUTH_REQUIRED | UNAVAILABLE | RATE_LIMITED | CIRCUIT_OPEN
    expect([
      "HEALTHY",
      "UNCONFIGURED",
      "AUTH_REQUIRED",
      "UNAVAILABLE",
      "RATE_LIMITED",
      "CIRCUIT_OPEN",
    ]).toContain(codex.status);
  });

  test("Phase 4.1 marker — body.phase contains '4.1'", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    expect(typeof body.phase).toBe("string");
    expect(body.phase).toContain("4.1");
  });

  test("§69 — research.stages contains the 5 core stages", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    expect(body.research).toBeDefined();
    expect(Array.isArray(body.research.stages)).toBe(true);
    const stages: string[] = body.research.stages;
    const REQUIRED = [
      "issue-map",
      "holding",
      "material-facts",
      "applicability",
      "case-analysis",
    ];
    for (const stage of REQUIRED) {
      expect(stages).toContain(stage);
    }
  });

  test("§69 — security posture fields (SSRF redirect loop, rate limit, session isolation, etc.)", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    expect(body.security).toBeDefined();
    expect(typeof body.security).toBe("object");
    expect(body.security.ssrfRedirectLoop).toBe(true);
    expect(body.security.maxRedirects).toBe(5);
    expect(body.security.qaEndpointsGuarded).toBe(true);
    expect(body.security.rateLimit).toBe(true);
    expect(body.security.datalexSessionIsolation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — codex AUTH_REQUIRED + RATE_LIMITED handling (§11, §13, §41)
//
// The route's GET() collapses codex-cli + codex-sdk health snapshots into
// a single logical `codex` entry. The transport + status fields are
// derived from the codex-cli (PRIMARY) and codex-sdk (OPTIONAL) health:
//   - codexCli HEALTHY              → transport="cli-chatgpt", status="HEALTHY"
//   - codexCli AUTH_REQUIRED        → transport="cli-chatgpt", status="AUTH_REQUIRED"
//   - codexCli RATE_LIMITED         → transport="cli-chatgpt", status="RATE_LIMITED"
//   - codexSdk HEALTHY (cli down)   → transport="sdk-api",     status="HEALTHY"
//   - both unavailable              → transport="unavailable", status=derived
//
// These tests inject canned health snapshots via mock.module on
// `@/lib/ai-runtime` (the route's dynamic import target). To bypass the
// 30s health-snapshot cache (module-level state in route.ts), each test
// uses a cache-busting dynamic import of the route module:
//   `await import(\`@/app/api/health/route?t=${cacheBustKey()}\`)`
// This forces bun to re-evaluate the route module from source, returning
// a fresh module instance with cachedHealth.fetchedAt=0 (so GET() re-fetches).
//
// IMPORTANT — flakiness guard: bun's `mock.module` is sticky across cache-
// busts and the cache-bust key must be UNIQUE per test invocation. Using
// `Date.now()` alone can collide when two tests run in the same millisecond
// (the previous mock from test N would persist for test N+1 because the
// route module would be re-cached under the same key, returning the same
// `cachedHealth` snapshot from the previous test). The `cacheBustKey()`
// helper below combines a monotonic counter with Date.now() to guarantee
// uniqueness across all tests in the file.
// ---------------------------------------------------------------------------

let cacheBustCounter = 0;
function cacheBustKey(): string {
  cacheBustCounter += 1;
  return `${Date.now()}-${cacheBustCounter}`;
}

describe("/api/health — codex AUTH_REQUIRED + RATE_LIMITED state handling (§11, §13, §41)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("§11 — codex.status=AUTH_REQUIRED + codex.transport=cli-chatgpt when codex-cli is AUTH_REQUIRED", async () => {
    // Simulate: codex-cli binary available, ChatGPT not signed in.
    // The route MUST surface this as AUTH_REQUIRED + cli-chatgpt (NOT
    // "unavailable" — the binary IS installed; the user just needs to
    // sign in). Distinct from RATE_LIMITED (signed in but quota exhausted).
    mock.module("@/lib/ai-runtime", () => ({
      getAiRuntime: () => ({
        health: async () => ({
          zai: { status: "HEALTHY", detail: "z-ai-web-dev-sdk bundled" },
          "ollama-cloud": { status: "UNCONFIGURED", detail: "OLLAMA_CLOUD_ENABLED=false" },
          "codex-cli": {
            status: "AUTH_REQUIRED",
            detail: "Codex CLI installed; ChatGPT sign-in required.",
            lastCheckedAt: Date.now(),
          },
          "codex-sdk": {
            status: "UNCONFIGURED",
            detail: "CODEX_SDK_ENABLED=false (§14 optional API-key path)",
            lastCheckedAt: Date.now(),
          },
        }),
        metrics: () => ({}),
      }),
    }));

    // Cache-bust the route import to bypass the 30s health-snapshot cache
    // (module-level state in route.ts — each test needs a fresh module
    // instance so cachedHealth.fetchedAt=0 and GET() re-fetches).
    const routeMod = await import(`@/app/api/health/route?t=${cacheBustKey()}`);
    const response = await routeMod.GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    // §11: AUTH_REQUIRED + cli-chatgpt — the binary IS installed, the user
    // just needs to sign in. Distinct from UNAVAILABLE (binary missing).
    expect(codex.status).toBe("AUTH_REQUIRED");
    expect(codex.transport).toBe("cli-chatgpt");
    expect(typeof codex.detail).toBe("string");
    expect(codex.detail).toContain("sign-in");
  });

  test("§13 — codex.status=RATE_LIMITED + codex.transport=cli-chatgpt when codex-cli is RATE_LIMITED (quota exhausted)", async () => {
    // Simulate: codex-cli signed in but ChatGPT plan Codex allowance
    // exhausted (429 from ChatGPT plan). Per §41, do NOT silently switch
    // to API-key billing — the route surfaces RATE_LIMITED, NOT
    // "unavailable" and NOT a silent switch to sdk-api.
    mock.module("@/lib/ai-runtime", () => ({
      getAiRuntime: () => ({
        health: async () => ({
          zai: { status: "HEALTHY", detail: "z-ai-web-dev-sdk bundled" },
          "ollama-cloud": { status: "UNCONFIGURED", detail: "OLLAMA_CLOUD_ENABLED=false" },
          "codex-cli": {
            status: "RATE_LIMITED",
            detail: "Codex CLI ChatGPT allowance exhausted; will retry after cooldown.",
            lastCheckedAt: Date.now(),
          },
          "codex-sdk": {
            status: "UNCONFIGURED",
            detail: "CODEX_SDK_ENABLED=false (§14 optional API-key path)",
            lastCheckedAt: Date.now(),
          },
        }),
        metrics: () => ({}),
      }),
    }));

    const routeMod = await import(`@/app/api/health/route?t=${cacheBustKey()}`);
    const response = await routeMod.GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    // §13 + §41: RATE_LIMITED (signed in, quota exhausted) is distinct
    // from AUTH_REQUIRED (not signed in). transport stays cli-chatgpt
    // (NOT silently switched to sdk-api).
    expect(codex.status).toBe("RATE_LIMITED");
    expect(codex.transport).toBe("cli-chatgpt");
    expect(typeof codex.detail).toBe("string");
  });

  test("§41 — codex-cli RATE_LIMITED does NOT silently switch codex.transport to sdk-api when CODEX_SDK_ENABLED=false", async () => {
    // §41 no-silent-billing-switch: when codex-cli is RATE_LIMITED, the
    // route MUST NOT silently enable the API-billed codex-sdk path.
    // Even if codex-sdk were HEALTHY in the health snapshot, the route
    // checks codex-cli FIRST (per §7 — CLI is PRIMARY) and surfaces
    // RATE_LIMITED + cli-chatgpt (NOT sdk-api).
    //
    // This test injects BOTH codex-cli RATE_LIMITED AND codex-sdk HEALTHY
    // (which would be the dangerous case where the SDK is enabled). The
    // route's logic: codexCli RATE_LIMITED → return RATE_LIMITED +
    // cli-chatgpt (does NOT fall through to codex-sdk HEALTHY).
    mock.module("@/lib/ai-runtime", () => ({
      getAiRuntime: () => ({
        health: async () => ({
          zai: { status: "HEALTHY", detail: "z-ai-web-dev-sdk bundled" },
          "ollama-cloud": { status: "UNCONFIGURED", detail: "OLLAMA_CLOUD_ENABLED=false" },
          "codex-cli": {
            status: "RATE_LIMITED",
            detail: "ChatGPT allowance exhausted",
            lastCheckedAt: Date.now(),
          },
          "codex-sdk": {
            // DANGEROUS: SDK would be eligible if codex-cli weren't checked
            // first. The route MUST NOT use this — codex-cli takes priority
            // per §7, and RATE_LIMITED is a terminal codex state.
            status: "HEALTHY",
            detail: "codex-sdk via API key (optional transport)",
            lastCheckedAt: Date.now(),
          },
        }),
        metrics: () => ({}),
      }),
    }));

    const routeMod = await import(`@/app/api/health/route?t=${cacheBustKey()}`);
    const response = await routeMod.GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    // §41: codex-cli RATE_LIMITED wins (CLI is PRIMARY per §7). The route
    // surfaces RATE_LIMITED + cli-chatgpt. It does NOT silently switch to
    // sdk-api + HEALTHY (which would be silent API billing).
    expect(codex.status).toBe("RATE_LIMITED");
    expect(codex.transport).toBe("cli-chatgpt");
  });

  test("§14 — codex.status=HEALTHY + codex.transport=sdk-api when codex-sdk is HEALTHY and codex-cli is UNCONFIGURED", async () => {
    // The OPTIONAL API-key path is only surfaced when codex-sdk is
    // HEALTHY (i.e. CODEX_SDK_ENABLED=true explicitly + API key set +
    // SDK installed) AND codex-cli is not in a higher-priority state.
    mock.module("@/lib/ai-runtime", () => ({
      getAiRuntime: () => ({
        health: async () => ({
          zai: { status: "HEALTHY", detail: "z-ai-web-dev-sdk bundled" },
          "ollama-cloud": { status: "UNCONFIGURED", detail: "OLLAMA_CLOUD_ENABLED=false" },
          "codex-cli": {
            status: "UNCONFIGURED",
            detail: "CODEX_CLI_ENABLED=false",
            lastCheckedAt: Date.now(),
          },
          "codex-sdk": {
            status: "HEALTHY",
            detail: "codex-sdk via API key (optional transport)",
            lastCheckedAt: Date.now(),
          },
        }),
        metrics: () => ({}),
      }),
    }));

    const routeMod = await import(`@/app/api/health/route?t=${cacheBustKey()}`);
    const response = await routeMod.GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    // §14: codex-sdk HEALTHY (when codex-cli is UNCONFIGURED) → sdk-api.
    expect(codex.status).toBe("HEALTHY");
    expect(codex.transport).toBe("sdk-api");
  });

  test("§36 — codex.status=UNAVAILABLE + codex.transport=unavailable when both codex transports are UNAVAILABLE", async () => {
    // Honest "no codex transport available" state per §111 — never fake
    // a pass.
    mock.module("@/lib/ai-runtime", () => ({
      getAiRuntime: () => ({
        health: async () => ({
          zai: { status: "HEALTHY", detail: "z-ai-web-dev-sdk bundled" },
          "ollama-cloud": { status: "UNCONFIGURED", detail: "OLLAMA_CLOUD_ENABLED=false" },
          "codex-cli": {
            status: "UNAVAILABLE",
            detail: "`codex` binary not on PATH (§111)",
            lastCheckedAt: Date.now(),
          },
          "codex-sdk": {
            status: "UNAVAILABLE",
            detail: "@openai/codex-sdk not installed (§111)",
            lastCheckedAt: Date.now(),
          },
        }),
        metrics: () => ({}),
      }),
    }));

    const routeMod = await import(`@/app/api/health/route?t=${cacheBustKey()}`);
    const response = await routeMod.GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    expect(codex.status).toBe("UNAVAILABLE");
    expect(codex.transport).toBe("unavailable");
  });
});
