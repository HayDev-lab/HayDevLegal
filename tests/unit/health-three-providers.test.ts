// tests/unit/health-three-providers.test.ts
// /api/health endpoint contract — Phase 4.1 Provider Finalization
// (master prompt §29, §69, §70).
//
// After the Phase 4.1 cleanup, the user-facing health payload exposes
// EXACTLY 3 logical providers (Z-AI, Ollama Cloud, Codex with a
// `transport: "sdk" | "cli" | "unavailable"` field reflecting which
// underlying Codex transport is currently healthy). The two concrete Codex
// variants (codex-sdk, codex-cli) are collapsed into a single `codex`
// entry — they are NOT exposed as separate top-level keys.
//
// This is verified by directly invoking the route handler `GET()`:
//   import { GET } from "@/app/api/health/route";
//   const response = await GET();
//   const body = await response.json();
//
// The route already caches the AI runtime snapshot (§70 — 30s TTL) and
// fails open (returns empty providers + zero metrics) if the runtime is
// not yet built. So direct invocation is safe in the test environment —
// no network access required, no flaky external state.

import { describe, expect, test } from "bun:test";

describe("/api/health — Phase 4.1 three-logical-providers contract (§29, §69)", () => {
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

  test("§29 — codex.transport field is one of sdk | cli | unavailable", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    expect(typeof codex.transport).toBe("string");
    expect(["sdk", "cli", "unavailable"]).toContain(codex.transport);
  });

  test("§29 — codex.status field is a string from the known status set", async () => {
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    const body = await response.json();

    const codex = body.aiProviders.codex;
    expect(codex).toBeDefined();
    expect(typeof codex.status).toBe("string");
    // Status values come from AiProviderHealthStatus (§17):
    // HEALTHY | UNCONFIGURED | UNAVAILABLE | RATE_LIMITED | CIRCUIT_OPEN
    expect([
      "HEALTHY",
      "UNCONFIGURED",
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
