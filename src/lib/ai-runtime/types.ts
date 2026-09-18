// src/lib/ai-runtime/types.ts
// Unified AI Runtime — public type surface.
// Master prompt PART B §15–§22, PART C §23–§31, PART F §52–§58.
//
// This module is the single source of truth for the runtime contract:
//   - AiProviderId            (§18)
//   - AiResult<T>             (§19 — strict discriminated union)
//   - AiTaskType              (§48)
//   - AiProvider              (§17 interface)
//   - AiProviderCapabilities (§17)
//   - AiProviderHealth        (§17)
//   - AiRuntimeContext
//   - ProviderRuntimeState    (§52)
//
// Business code MUST depend on this file, never on a concrete provider SDK.

import type { ZodType } from "zod";

// ---------------------------------------------------------------------------
// §18 — Provider identifiers
// ---------------------------------------------------------------------------

export type AiProviderId =
  | "zai"
  | "ollama-cloud"
  | "codex-sdk"
  | "codex-cli";

// ---------------------------------------------------------------------------
// §48 — Task types (every LLM call site maps to exactly one of these)
// ---------------------------------------------------------------------------

export type AiTaskType =
  | "QUERY_DECOMPOSITION"
  | "LIGHT_HOLDING_EXTRACTION"
  | "MATERIAL_FACT_EXTRACTION"
  | "CASE_ANALYSIS"
  | "MULTI_CASE_COMPARISON"
  | "PRECEDENT_APPLICABILITY"
  | "DISTINGUISHING_ANALYSIS"
  | "PRECEDENT_LINEAGE"
  | "COUNTER_AUTHORITY_ANALYSIS"
  | "ARGUMENT_MAP"
  | "DEEP_CASE_SYNTHESIS"
  | "FINAL_ANSWER";

// ---------------------------------------------------------------------------
// §19 — AiResult strict discriminated union
// Every call to a provider returns exactly one of these statuses.
// Business code MUST switch on `status`, never on ad-hoc fields.
// ---------------------------------------------------------------------------

export type AiResult<T> =
  | { status: "SUCCESS"; value: T; provider: AiProviderId; latencyMs: number }
  | { status: "SUCCESS_EMPTY"; provider: AiProviderId; latencyMs: number }
  | { status: "RATE_LIMITED"; provider: AiProviderId; retryAfterMs?: number }
  | { status: "TIMEOUT"; provider: AiProviderId }
  | { status: "UNAVAILABLE"; provider: AiProviderId; detail?: string }
  | { status: "INVALID_SCHEMA"; provider: AiProviderId; detail?: string }
  | { status: "ERROR"; provider: AiProviderId; detail?: string };

// ---------------------------------------------------------------------------
// §17 — Provider capabilities (declared up front, never inferred)
// ---------------------------------------------------------------------------

export interface AiProviderCapabilities {
  /** Provider can return strict JSON validated by a Zod schema. */
  structuredOutput: boolean;
  /** Provider supports SSE/token streaming. (Runtime honors but does not require.) */
  streaming: boolean;
  /** True ONLY for codex variants (§32) — closed-evidence case analysis. */
  caseAnalysis: boolean;
  /** Hard cap on `max_tokens` the provider will accept. */
  maxTokens: number;
  /** Default per-call timeout if none specified in the request. */
  defaultTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// §17 — Provider health snapshot (returned by `provider.health()`)
// ---------------------------------------------------------------------------

export type AiProviderHealthStatus =
  | "HEALTHY"
  | "UNCONFIGURED"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "CIRCUIT_OPEN";

export interface AiProviderHealth {
  status: AiProviderHealthStatus;
  detail?: string;
  lastCheckedAt?: number;
}

// ---------------------------------------------------------------------------
// §52 — Runtime state tracked per provider (in-process, not persisted)
// ---------------------------------------------------------------------------

export type ProviderRuntimeStatus =
  | "HEALTHY"
  | "RATE_LIMITED"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "CIRCUIT_OPEN"
  | "UNCONFIGURED";

export interface ProviderRuntimeState {
  status: ProviderRuntimeStatus;
  /** Epoch ms until which the provider should NOT be called (429 cooldown). */
  rateLimitedUntil?: number;
  /** Number of consecutive failures since last SUCCESS. */
  failures: number;
  /** Currently in-flight calls (for concurrency + metrics). */
  activeRequests: number;
  /** Epoch ms of the last failure (for circuit-breaker window). */
  lastErrorAt?: number;
}

// ---------------------------------------------------------------------------
// Runtime context passed to every call
// ---------------------------------------------------------------------------

export interface AiRuntimeContext {
  signal?: AbortSignal;
  /** Hard epoch-ms deadline (§57). Router skips providers that cannot finish in time. */
  deadlineAt?: number;
  /** Workspace id — only meaningful for codex providers that need a sandbox. */
  workspaceId?: string;
  /** Free-form label for logs / traces (§109). */
  label?: string;
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiTextRequest {
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-call timeout in ms. Falls back to `capabilities.defaultTimeoutMs`. */
  timeoutMs?: number;
}

export interface AiStructuredRequest<T> {
  messages: AiMessage[];
  /** Zod schema the response JSON must satisfy. */
  schema: ZodType<T>;
  /** Hint sent to the provider (some providers can use JSON schema natively). */
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// §17 — AiProvider abstract interface
// ---------------------------------------------------------------------------

export interface AiProvider {
  readonly id: AiProviderId;
  readonly capabilities: AiProviderCapabilities;
  health(signal?: AbortSignal): Promise<AiProviderHealth>;
  generateText(
    req: AiTextRequest,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<string>>;
  generateStructured<T>(
    req: AiStructuredRequest<T>,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<T>>;
}

// ---------------------------------------------------------------------------
// Stage-trace entry (§109) — the runtime collects one per provider attempt
// ---------------------------------------------------------------------------

export interface AiStageTraceEntry {
  stage: string;
  provider: AiProviderId;
  status: string;
  latencyMs: number;
  /** Optional note (e.g. "RATE_LIMITED → cooldown 4000ms", "SKIPPED_DEADLINE"). */
  note?: string;
}
