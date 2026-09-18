// tests/unit/ai-result-states.test.ts
// AiResult discriminated-union contract tests (master prompt §19, §81).
//
// AiResult<T> is the strict discriminated union returned by every call to an
// AiProvider (PART B §17, §19). Business code MUST switch on `.status` —
// `null | T` is explicitly forbidden because it conflates "provider failed"
// with "document has no holding" (§20).
//
// These tests assert the SHAPE of the contract:
//   - every documented status exists as a discriminator
//   - SUCCESS carries `value`, SUCCESS_EMPTY does NOT
//   - RATE_LIMITED carries optional `retryAfterMs`
//   - UNAVAILABLE / INVALID_SCHEMA / ERROR carry optional `detail`
//   - exhaustive switch on `.status` type-narrows without falling through
//
// The `typecheck` script (`tsc --noEmit`) is the PRIMARY gate for the
// type-narrowing assertions; the runtime assertions in `bun test` confirm
// the constructed shapes match the documented contract.

import { describe, expect, test } from "bun:test";
import type { AiProviderId, AiResult, AiTaskType } from "@/lib/ai-runtime/types";

describe("AiResult discriminated union (§19, §81)", () => {
  test("SUCCESS carries value + provider + latencyMs", () => {
    const r: AiResult<string> = {
      status: "SUCCESS",
      value: "hello",
      provider: "zai",
      latencyMs: 42,
    };
    expect(r.status).toBe("SUCCESS");
    // Type narrowing — `.value` is only accessible on the SUCCESS branch.
    if (r.status === "SUCCESS") {
      expect(r.value).toBe("hello");
      expect(r.provider).toBe("zai");
      expect(r.latencyMs).toBe(42);
    }
  });

  test("SUCCESS_EMPTY has NO value field (§20)", () => {
    const r: AiResult<string> = {
      status: "SUCCESS_EMPTY",
      provider: "zai",
      latencyMs: 5,
    };
    expect(r.status).toBe("SUCCESS_EMPTY");
    if (r.status === "SUCCESS_EMPTY") {
      expect(r.provider).toBe("zai");
      expect(r.latencyMs).toBe(5);
      // The branch MUST NOT carry a `value` field — the whole point of
      // splitting SUCCESS_EMPTY from SUCCESS (§20) is to remove the
      // ambiguity between "provider failed" and "no holding found".
      expect((r as Record<string, unknown>).value).toBeUndefined();
    }
  });

  test("RATE_LIMITED carries optional retryAfterMs", () => {
    const withRetry: AiResult<string> = {
      status: "RATE_LIMITED",
      provider: "zai",
      retryAfterMs: 4000,
    };
    expect(withRetry.status).toBe("RATE_LIMITED");
    if (withRetry.status === "RATE_LIMITED") {
      expect(withRetry.retryAfterMs).toBe(4000);
      expect(withRetry.provider).toBe("zai");
    }
  });

  test("RATE_LIMITED without retryAfterMs is also valid (server gave no Retry-After)", () => {
    const noRetry: AiResult<string> = {
      status: "RATE_LIMITED",
      provider: "ollama-cloud",
    };
    expect(noRetry.status).toBe("RATE_LIMITED");
    if (noRetry.status === "RATE_LIMITED") {
      expect(noRetry.retryAfterMs).toBeUndefined();
    }
  });

  test("TIMEOUT", () => {
    const r: AiResult<string> = { status: "TIMEOUT", provider: "zai" };
    expect(r.status).toBe("TIMEOUT");
    if (r.status === "TIMEOUT") {
      expect(r.provider).toBe("zai");
    }
  });

  test("INVALID_SCHEMA carries optional detail", () => {
    const r: AiResult<string> = {
      status: "INVALID_SCHEMA",
      provider: "ollama-cloud",
      detail: "missing required field 'holding'",
    };
    expect(r.status).toBe("INVALID_SCHEMA");
    if (r.status === "INVALID_SCHEMA") {
      expect(r.detail).toContain("holding");
    }
  });

  test("UNAVAILABLE carries optional detail", () => {
    const r: AiResult<string> = {
      status: "UNAVAILABLE",
      provider: "codex-sdk",
      detail: "no API key configured",
    };
    expect(r.status).toBe("UNAVAILABLE");
    if (r.status === "UNAVAILABLE") {
      expect(r.detail).toBe("no API key configured");
    }
  });

  test("ERROR carries optional detail", () => {
    const r: AiResult<string> = {
      status: "ERROR",
      provider: "zai",
      detail: "connection reset",
    };
    expect(r.status).toBe("ERROR");
    if (r.status === "ERROR") {
      expect(r.detail).toBe("connection reset");
    }
  });

  test("AUTH_REQUIRED carries optional detail (Phase 4.1 Finalization §11)", () => {
    // Phase 4.1 Finalization §11: AUTH_REQUIRED is a new AiResult status
    // for "Codex CLI binary installed but ChatGPT not signed in". Distinct
    // from UNAVAILABLE (binary missing) and RATE_LIMITED (signed in but
    // quota exhausted). The exhaustive-switch test above covers the type
    // narrowing; this test pins the value-level shape.
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

  test("AUTH_REQUIRED without detail is also valid (provider-only signal)", () => {
    // The detail field is OPTIONAL — providers MAY return AUTH_REQUIRED
    // with just the provider id (the status itself is self-explanatory
    // once you know it's the CLI transport).
    const r: AiResult<string> = {
      status: "AUTH_REQUIRED",
      provider: "codex-cli",
    };
    expect(r.status).toBe("AUTH_REQUIRED");
    if (r.status === "AUTH_REQUIRED") {
      expect(r.provider).toBe("codex-cli");
      expect(r.detail).toBeUndefined();
    }
  });

  test("exhaustive switch on status — TypeScript narrowing proof", () => {
    // This function will not compile if the switch is non-exhaustive or if
    // a branch accesses a field that doesn't exist on that status.
    function summarize(r: AiResult<string>): string {
      switch (r.status) {
        case "SUCCESS":
          return `success:${r.value}`;
        case "SUCCESS_EMPTY":
          return "empty";
        case "RATE_LIMITED":
          return `429:${r.retryAfterMs ?? 0}`;
        case "AUTH_REQUIRED":
          // §11 Phase 4.1 Finalization — new status for "CLI installed but
          // ChatGPT not signed in".
          return `auth:${r.detail ?? ""}`;
        case "TIMEOUT":
          return "timeout";
        case "INVALID_SCHEMA":
          return `invalid:${r.detail ?? ""}`;
        case "UNAVAILABLE":
          return `unavail:${r.detail ?? ""}`;
        case "ERROR":
          return `err:${r.detail ?? ""}`;
      }
    }

    expect(
      summarize({ status: "SUCCESS", value: "x", provider: "zai", latencyMs: 1 }),
    ).toBe("success:x");
    expect(
      summarize({ status: "SUCCESS_EMPTY", provider: "zai", latencyMs: 1 }),
    ).toBe("empty");
    expect(
      summarize({ status: "RATE_LIMITED", provider: "zai", retryAfterMs: 2000 }),
    ).toBe("429:2000");
    expect(summarize({ status: "TIMEOUT", provider: "zai" })).toBe("timeout");
    expect(
      summarize({ status: "INVALID_SCHEMA", provider: "zai" }),
    ).toBe("invalid:");
    expect(
      summarize({ status: "UNAVAILABLE", provider: "zai" }),
    ).toBe("unavail:");
    expect(
      summarize({ status: "ERROR", provider: "zai", detail: "boom" }),
    ).toBe("err:boom");
  });

  test("all AiProviderId values are valid provider discriminators", () => {
    // Phase 4.1 Provider Finalization §3: AiProviderId is now 4 ids only
    // (ollama-local + generic-llm removed; codex has sdk+cli transports).
    const ids: AiProviderId[] = [
      "zai",
      "ollama-cloud",
      "codex-sdk",
      "codex-cli",
    ];
    expect(ids.length).toBe(4);
    for (const id of ids) {
      const r: AiResult<null> = { status: "TIMEOUT", provider: id };
      expect(r.provider).toBe(id);
    }
  });

  test("all AiTaskType values are valid task discriminators", () => {
    const tasks: AiTaskType[] = [
      "QUERY_DECOMPOSITION",
      "LIGHT_HOLDING_EXTRACTION",
      "MATERIAL_FACT_EXTRACTION",
      "CASE_ANALYSIS",
      "MULTI_CASE_COMPARISON",
      "PRECEDENT_APPLICABILITY",
      "DISTINGUISHING_ANALYSIS",
      "PRECEDENT_LINEAGE",
      "COUNTER_AUTHORITY_ANALYSIS",
      "ARGUMENT_MAP",
      "DEEP_CASE_SYNTHESIS",
      "FINAL_ANSWER",
    ];
    expect(tasks.length).toBe(12);
  });
});
