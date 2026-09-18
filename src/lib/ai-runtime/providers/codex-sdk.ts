// src/lib/ai-runtime/providers/codex-sdk.ts
// Codex SDK provider — REAL implementation (Phase 4.1 §33–§34, §40–§46, §58).
//
// This provider is the ONLY closed-evidence case-analysis engine in the
// runtime. It is built on the official `@openai/codex-sdk` package, which
// spawns the `codex` binary (auto-installed at `node_modules/.bin/codex`
// by `@openai/codex` v0.155.0) as a subprocess under a controlled env.
//
// The flow per call (master prompt §33, §37, §38, §40, §41, §42, §43–§44,
// §45, §46, §58):
//
//   1. Pre-checks: enabled / sdkInstalled / apiKey / cooldown
//   2. Parse the CaseAnalysisPack out of the request's user message
//   3. Create an isolated workspace under /tmp/haydevlegal-case/<req-id>/
//   4. Build a Codex instance with controlled env (§36 — when `env` is
//      provided, the SDK does NOT inherit process.env; we control exactly
//      what the codex binary sees)
//   5. Start a thread with: sandboxMode="read-only" (§21), networkAccess
//      Enabled=false (§20), webSearchMode="disabled" (§20),
//      approvalPolicy="never" (autonomous), workingDirectory=workspace
//   6. Convert CodexCaseAnalysisSchema → JSON Schema for outputSchema (§23,
//      §45) and pass it via TurnOptions
//   7. Build the input as a single user message (system + "---" + user)
//   8. Wrap thread.run in withTimeout (§58 — honors ctx.signal too)
//   9. Extract JSON from finalResponse, validate against req.schema
//   10. Run validateCodexOutput() (§46 firewall); reject if it fails
//   11. Return SUCCESS or map errors (RATE_LIMITED/TIMEOUT/INVALID_SCHEMA)
//   12. Cleanup workspace in finally (§44 lifecycle)
//
// §111 — never fake a pass: if the SDK is not installed, the api key is
// missing, or any pre-check fails, we return UNAVAILABLE/UNCONFIGURED
// honestly. We DO NOT synthesize a fake CodexCaseAnalysis.

import { Codex } from "@openai/codex-sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderHealth,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
  AiTextRequest,
} from "../types";
import { CODEX_SDK_CONFIG } from "../config";
import type { CaseAnalysisPack, CodexCaseAnalysis } from "../codex";
import {
  CodexCaseAnalysisSchema,
  buildCasePrompt,
  cleanupWorkspace,
  createWorkspace,
  validateCodexOutput,
} from "../codex";
import {
  extractJson,
  isRateLimitError,
  withTimeout,
} from "../structured-generation";
import {
  clearCooldown,
  isInCooldown,
  remainingCooldownMs,
  triggerCooldown,
} from "../rate-limit";
import { incActive, decActive, recordProviderCall } from "../metrics";

const CAPABILITIES: AiProviderCapabilities = {
  structuredOutput: true,
  streaming: false,
  caseAnalysis: true,
  maxTokens: CODEX_SDK_CONFIG.maxTokens,
  defaultTimeoutMs: CODEX_SDK_CONFIG.defaultTimeoutMs,
};

// ---------------------------------------------------------------------------
// JSON Schema construction for `outputSchema` (§23, §45)
// ---------------------------------------------------------------------------
//
// The spec calls for `zodToJsonSchema(CodexCaseAnalysisSchema, "CodexCaseAnalysis")`
// from the `zod-to-json-schema` package. We honor that literally FIRST.
// However, `zod-to-json-schema@3.x` was written for zod v3 internals and
// produces EMPTY definitions when handed a zod v4 schema (zod v4 changed
// the internal `_def` shape). We detect that failure mode (the named
// definition is an empty object) and fall back to zod v4's native
// `schema.toJSONSchema({ target: "draft-7" })`, which produces a correct
// schema with all properties / required / additionalProperties.
//
// Either way, the result is a JSON Schema object passed as `outputSchema`
// in TurnOptions — the codex CLI uses it to constrain the final response
// shape, so the model's `finalResponse` will be a JSON string conforming
// to the schema.
function buildJsonSchema(): unknown {
  // Primary: zod-to-json-schema (spec says to use this package).
  try {
    const viaLib = zodToJsonSchema(
      CodexCaseAnalysisSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
      "CodexCaseAnalysis",
    ) as {
      $ref?: string;
      definitions?: Record<string, unknown>;
      [k: string]: unknown;
    };
    // Detect the zod-v4 incompatibility signature: a top-level $ref to a
    // named definition that is empty.
    const def =
      viaLib.definitions &&
      typeof viaLib.definitions === "object" &&
      "CodexCaseAnalysis" in viaLib.definitions
        ? (viaLib.definitions.CodexCaseAnalysis as Record<string, unknown>)
        : undefined;
    const looksEmpty =
      viaLib.$ref !== undefined &&
      def !== undefined &&
      Object.keys(def).length === 0;
    if (!looksEmpty) {
      return viaLib;
    }
    // else: fall through to native
  } catch {
    // fall through to native
  }

  // Fallback: zod v4 native toJSONSchema (works correctly with zod v4).
  const schema = CodexCaseAnalysisSchema as unknown as {
    toJSONSchema?: (opts?: { target?: string }) => unknown;
  };
  if (schema.toJSONSchema && typeof schema.toJSONSchema === "function") {
    try {
      return schema.toJSONSchema({ target: "draft-7" });
    } catch {
      // fall through
    }
  }

  // Last resort: an extremely permissive schema — at least tells codex
  // "produce a JSON object". The validateCodexOutput firewall (§46) plus
  // req.schema.safeParse (§45) are the real correctness gates.
  return {
    type: "object",
    additionalProperties: true,
  };
}

// ---------------------------------------------------------------------------
// Locate the codex binary for `codexPathOverride` (§33).
// ---------------------------------------------------------------------------
//
// The SDK's `codexPathOverride` should point at the codex CLI entry. We
// try, in order:
//   1. `require.resolve("@openai/codex/bin/codex.js")` via the global
//      `require` (works in Bun + Next.js server bundles).
//   2. `<cwd>/node_modules/.bin/codex` (the symlink the package installer
//      creates).
//   3. `undefined` — let the SDK find `codex` on the PATH itself.
//
// Returns `undefined` when no override can be computed; the SDK will
// then resolve `codex` from PATH (which usually works on dev machines
// where the bin symlink is on PATH anyway).
function findCodexBinary(): string | undefined {
  type GlobalWithRequire = { require?: NodeRequire };
  const g = globalThis as unknown as GlobalWithRequire;
  if (typeof g.require === "function") {
    try {
      return g.require.resolve("@openai/codex/bin/codex.js");
    } catch {
      // ignore — fall through
    }
  }
  const fallback = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    "codex",
  );
  if (existsSync(fallback)) {
    return fallback;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pack extraction (§38, §40)
// ---------------------------------------------------------------------------
//
// The caller passes a CaseAnalysisPack embedded in the user message of the
// structured request — typically via `buildCasePrompt(pack)` from
// `../codex`. We:
//   1. Find the LAST user message in req.messages.
//   2. Look for the "EVIDENCE PACK:" header (the marker buildCasePrompt
//      emits). If present, search for JSON AFTER the marker.
//   3. Else, try JSON.parse(content) directly.
//   4. Else, use extractJson(content) to find the first JSON object/array.
//
// Returns the parsed pack, or null if no pack could be extracted.
function findLastUserMessage<T>(
  req: AiStructuredRequest<T>,
): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return undefined;
}

function extractCaseAnalysisPack(content: string): CaseAnalysisPack | null {
  if (!content || content.trim().length === 0) return null;

  // 1. Look for the EVIDENCE PACK: marker.
  const marker = "EVIDENCE PACK:";
  const idx = content.indexOf(marker);
  const after = idx >= 0 ? content.slice(idx + marker.length) : content;
  const fromMarker = extractJson(after);
  if (fromMarker && typeof fromMarker === "object") {
    return fromMarker as CaseAnalysisPack;
  }

  // 2. Try parsing the whole content as JSON.
  try {
    const whole = JSON.parse(content);
    if (whole && typeof whole === "object") {
      return whole as CaseAnalysisPack;
    }
  } catch {
    // ignore — fall through
  }

  // 3. extractJson on the whole content (handles ```json fences + prose).
  const whole = extractJson(content);
  if (whole && typeof whole === "object") {
    return whole as CaseAnalysisPack;
  }

  return null;
}

// ---------------------------------------------------------------------------
// CodexSdkProvider
// ---------------------------------------------------------------------------

/**
 * Real codex-sdk provider. Spawns the codex binary via `@openai/codex-sdk`
 * under a controlled env (§36), in a read-only sandbox (§21), with no
 * network access (§20), producing a CodexCaseAnalysis JSON document that
 * passes the §46 verification firewall before being returned.
 */
export class CodexSdkProvider implements AiProvider {
  readonly id: AiProviderId = "codex-sdk";
  readonly capabilities: AiProviderCapabilities = CAPABILITIES;

  async health(): Promise<AiProviderHealth> {
    if (!CODEX_SDK_CONFIG.enabled) {
      return {
        status: "UNCONFIGURED",
        detail: "CODEX_SDK_ENABLED=false",
        lastCheckedAt: Date.now(),
      };
    }
    if (!CODEX_SDK_CONFIG.sdkInstalled) {
      // §111 — never fake a pass. Report UNAVAILABLE honestly.
      return {
        status: "UNAVAILABLE",
        detail: "@openai/codex-sdk not installed (CODEX_SDK_ENABLED=true)",
        lastCheckedAt: Date.now(),
      };
    }
    if (!CODEX_SDK_CONFIG.apiKey) {
      return {
        status: "UNCONFIGURED",
        detail: "missing CODEX_API_KEY — provider disabled per §111",
        lastCheckedAt: Date.now(),
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        detail: `cooldown ${remainingCooldownMs(this.id)}ms`,
        lastCheckedAt: Date.now(),
      };
    }
    return {
      status: "HEALTHY",
      detail: `model=${CODEX_SDK_CONFIG.model}`,
      lastCheckedAt: Date.now(),
    };
  }

  async generateText(
    _req: AiTextRequest,
    _ctx: AiRuntimeContext,
  ): Promise<AiResult<string>> {
    // §33 — codex is closed-evidence-only. Free-form text generation is
    // NOT supported. Return UNAVAILABLE so the router falls through.
    return {
      status: "UNAVAILABLE",
      provider: this.id,
      detail:
        "codex-sdk generateText not implemented (codex is closed-evidence-only per §33)",
    };
  }

  async generateStructured<T>(
    req: AiStructuredRequest<T>,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<T>> {
    // -----------------------------------------------------------------
    // 1. Pre-checks (§111 — never fake a pass)
    // -----------------------------------------------------------------
    if (!CODEX_SDK_CONFIG.enabled) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "codex-sdk not enabled",
      };
    }
    if (!CODEX_SDK_CONFIG.sdkInstalled) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "@openai/codex-sdk not installed (§111)",
      };
    }
    if (!CODEX_SDK_CONFIG.apiKey) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "missing CODEX_API_KEY (§111)",
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }

    const startedAt = Date.now();
    incActive(this.id);

    // Track the workspace root so we can clean it up in `finally`.
    let workspaceRootDir: string | undefined;

    try {
      // -----------------------------------------------------------------
      // 2. Parse the CaseAnalysisPack from the request's user message (§38).
      // -----------------------------------------------------------------
      const userContent = findLastUserMessage(req);
      if (!userContent) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: "no user message in request (§38 pack missing)",
        };
      }
      const pack = extractCaseAnalysisPack(userContent);
      if (!pack) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: "could not extract CaseAnalysisPack from user message (§38)",
        };
      }

      // -----------------------------------------------------------------
      // 3. Create the isolated workspace (§22, §43–§44).
      // -----------------------------------------------------------------
      const workspaceId = ctx.workspaceId || ctx.label;
      const workspace = await createWorkspace(workspaceId, pack);
      workspaceRootDir = workspace.rootDir;

      // -----------------------------------------------------------------
      // 4. Build the Codex instance (§33, §36 — controlled env).
      //
      // When `env` is provided, the SDK does NOT inherit process.env —
      // we control exactly what the codex binary sees. Only CODEX_API_KEY
      // and PATH are passed; everything else (any ambient OPENAI_* keys,
      // HTTP_PROXY, etc.) is excluded by design.
      // -----------------------------------------------------------------
      const codexPathOverride = findCodexBinary();
      const env: Record<string, string> = {
        CODEX_API_KEY: CODEX_SDK_CONFIG.apiKey,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
      };
      const codex = new Codex({
        apiKey: CODEX_SDK_CONFIG.apiKey,
        codexPathOverride,
        env,
      });

      // -----------------------------------------------------------------
      // 5. Start a thread with §20 / §21 / §41 / §42 settings.
      // -----------------------------------------------------------------
      const thread = codex.startThread({
        model: CODEX_SDK_CONFIG.model,
        // §21 — read-only sandbox. The model cannot mutate the workspace.
        sandboxMode: "read-only",
        // §20 — no network access, no web search. The closed-evidence
        // guarantee depends on this.
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        webSearchEnabled: false,
        // Autonomous operation — never ask for approval.
        approvalPolicy: "never",
        // The workspace is the working directory. The codex CLI can READ
        // every file we wrote (case.json, issues.json, evidence.json, ...)
        // but cannot mutate anything (read-only sandbox).
        workingDirectory: workspace.rootDir,
        skipGitRepoCheck: true,
        // "medium" is a reasonable default for case analysis — high
        // enough to follow the issue graph, not so high we blow the
        // token budget.
        modelReasoningEffort: "medium",
      });

      // -----------------------------------------------------------------
      // 6. Build the JSON Schema for outputSchema (§23, §45).
      // -----------------------------------------------------------------
      const jsonSchema = buildJsonSchema();

      // -----------------------------------------------------------------
      // 7. Build the input (§17, §40). Combine system + user into a
      //    single user message — Codex handles system directives inside
      //    the first user prompt.
      // -----------------------------------------------------------------
      const { system, user } = buildCasePrompt(pack);
      const combined = `${system}\n\n---\n\n${user}`;
      const input = [{ type: "text" as const, text: combined }];

      // -----------------------------------------------------------------
      // 8. Run the turn with timeout + abort (§58).
      //    ctx.signal is BOTH passed to TurnOptions (so codex itself
      //    gets aborted) AND wired through withTimeout (so even if the
      //    SDK doesn't honor signal, we still race against the timeout
      //    and the user's abort).
      // -----------------------------------------------------------------
      const timeoutMs = req.timeoutMs ?? CODEX_SDK_CONFIG.defaultTimeoutMs;
      const turnOptions: { outputSchema: unknown; signal?: AbortSignal } = {
        outputSchema: jsonSchema,
      };
      if (ctx.signal) {
        turnOptions.signal = ctx.signal;
      }

      const work = thread.run(input, turnOptions);
      const racer = withTimeout(work, timeoutMs, ctx);

      let turn: {
        items: unknown[];
        finalResponse: string;
        usage: unknown | null;
      };
      try {
        turn = await racer.promise;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 429 / rate-limit → cooldown + RATE_LIMITED
        if (isRateLimitError(err).rateLimited) {
          const { retryAfterMs } = isRateLimitError(err);
          triggerCooldown(this.id, undefined, retryAfterMs);
          const result: AiResult<T> = {
            status: "RATE_LIMITED",
            provider: this.id,
            retryAfterMs: remainingCooldownMs(this.id),
          };
          recordProviderCall(this.id, "RATE_LIMITED", Date.now() - startedAt);
          return result;
        }
        // timeout / aborted → TIMEOUT
        if (/timeout|aborted|abort/i.test(msg)) {
          const result: AiResult<T> = { status: "TIMEOUT", provider: this.id };
          recordProviderCall(this.id, "TIMEOUT", Date.now() - startedAt);
          return result;
        }
        // other → ERROR
        const result: AiResult<T> = {
          status: "ERROR",
          provider: this.id,
          detail: `codex run failed: ${msg}`,
        };
        return result;
      } finally {
        racer.cancel();
      }

      // -----------------------------------------------------------------
      // 9. Process the turn result.
      // -----------------------------------------------------------------
      const latencyMs = Date.now() - startedAt;
      const raw = turn.finalResponse ?? "";

      if (!raw || raw.trim() === "") {
        recordProviderCall(this.id, "SUCCESS_EMPTY", latencyMs);
        return { status: "SUCCESS_EMPTY", provider: this.id, latencyMs };
      }

      const parsed = extractJson(raw);
      if (parsed === null || parsed === undefined) {
        const result: AiResult<T> = {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: "no JSON object/array found in codex finalResponse",
        };
        recordProviderCall(this.id, "INVALID_SCHEMA", latencyMs);
        return result;
      }

      // Validate against the request's Zod schema (§45).
      const validated = req.schema.safeParse(parsed);
      if (!validated.success) {
        const issueMsg = validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        const result: AiResult<T> = {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: `Zod validation failed: ${issueMsg}`,
        };
        recordProviderCall(this.id, "INVALID_SCHEMA", latencyMs);
        return result;
      }

      // -----------------------------------------------------------------
      // 10. §46 — verification firewall. The output MUST pass
      //     validateCodexOutput (every evidenceId referenced exists in
      //     the pack; synthesis is non-empty). If the request's schema
      //     is CodexCaseAnalysisSchema (the expected contract), we run
      //     the firewall. If the caller passed a different schema, the
      //     best we can do is attempt the cast — validateCodexOutput
      //     will reject any analysis that doesn't conform.
      // -----------------------------------------------------------------
      const analysisCandidate = validated.data as unknown as CodexCaseAnalysis;
      const verdict = validateCodexOutput(analysisCandidate, pack);
      if (!verdict.ok) {
        const result: AiResult<T> = {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: `codex firewall rejected: ${verdict.reason}`,
        };
        recordProviderCall(this.id, "INVALID_SCHEMA", latencyMs);
        return result;
      }

      // -----------------------------------------------------------------
      // 11. SUCCESS — clear cooldown, record metrics.
      // -----------------------------------------------------------------
      clearCooldown(this.id);
      recordProviderCall(this.id, "SUCCESS", latencyMs);
      return {
        status: "SUCCESS",
        value: validated.data,
        provider: this.id,
        latencyMs,
      };
    } catch (err) {
      // ---------------------------------------------------------------
      // Top-level error handling. Map to AiResult per the spec.
      // ---------------------------------------------------------------
      const msg = err instanceof Error ? err.message : String(err);

      // 429 / rate-limit
      if (isRateLimitError(err).rateLimited) {
        const { retryAfterMs } = isRateLimitError(err);
        triggerCooldown(this.id, undefined, retryAfterMs);
        const result: AiResult<T> = {
          status: "RATE_LIMITED",
          provider: this.id,
          retryAfterMs: remainingCooldownMs(this.id),
        };
        recordProviderCall(this.id, "RATE_LIMITED", Date.now() - startedAt);
        return result;
      }

      // timeout / aborted
      if (/timeout|aborted|abort/i.test(msg)) {
        const result: AiResult<T> = { status: "TIMEOUT", provider: this.id };
        recordProviderCall(this.id, "TIMEOUT", Date.now() - startedAt);
        return result;
      }

      const result: AiResult<T> = {
        status: "ERROR",
        provider: this.id,
        detail: `codex-sdk failure: ${msg}`,
      };
      return result;
    } finally {
      // ---------------------------------------------------------------
      // 12. Cleanup the workspace (§44 lifecycle). Best-effort, never
      //     throws — cleanupWorkspace swallows errors internally, but
      //     we add a try/catch here as defense-in-depth so a failure
      //     can't mask the real result.
      // ---------------------------------------------------------------
      decActive(this.id);
      if (workspaceRootDir) {
        try {
          await cleanupWorkspace(workspaceRootDir);
        } catch {
          // best-effort — ignore
        }
      }
    }
  }
}
