// src/lib/ai-runtime/config.ts
// Env-driven provider configuration + routing policy + scheduler config.
// Master prompt PART B §15–§22, PART F §52–§58.
//
// All environment reads happen here — providers and the router read typed
// constants from this module, never from `process.env` directly. This makes
// the runtime injectable in tests (swap the constants) and prevents the
// "where did this magic number come from" problem.

import type { AiProviderId, AiTaskType } from "./types";

// ---------------------------------------------------------------------------
// Env reading helpers — strict, never throws (missing env → UNCONFIGURED).
// ---------------------------------------------------------------------------

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// §23–§25 — Z-AI (z-ai-web-dev-sdk) — always configured (SDK is bundled)
// ---------------------------------------------------------------------------

export interface ZaiProviderConfig {
  /** Z-AI is always enabled in this project — the SDK is the baseline. */
  enabled: boolean;
  /** 429 cooldown in ms (§24 — shared cooldown). */
  cooldownMs: number;
  /** Hard max tokens the runtime will ever request. */
  maxTokens: number;
  /** Default per-call timeout. */
  defaultTimeoutMs: number;
  /** Whether `thinking` is disabled by default. */
  disableThinking: boolean;
}

export const ZAI_CONFIG: ZaiProviderConfig = {
  enabled: true,
  cooldownMs: envInt("ZAI_COOLDOWN_MS", 4_000),
  maxTokens: envInt("ZAI_MAX_TOKENS", 4_000),
  defaultTimeoutMs: envInt("ZAI_DEFAULT_TIMEOUT_MS", 18_000),
  disableThinking: envBool("ZAI_DISABLE_THINKING", true),
};

// ---------------------------------------------------------------------------
// §26–§29 — Ollama Cloud
// ---------------------------------------------------------------------------

export interface OllamaCloudConfig {
  enabled: boolean;
  apiKey: string;
  host: string;
  model: string;
  maxTokens: number;
  defaultTimeoutMs: number;
}

export const OLLAMA_CLOUD_CONFIG: OllamaCloudConfig = {
  enabled: envBool("OLLAMA_CLOUD_ENABLED", false),
  apiKey: envStr("OLLAMA_API_KEY", ""),
  host: envStr("OLLAMA_CLOUD_HOST", "https://ollama.com"),
  model: envStr("OLLAMA_CLOUD_MODEL", ""),
  maxTokens: envInt("OLLAMA_CLOUD_MAX_TOKENS", 8_000),
  defaultTimeoutMs: envInt("OLLAMA_CLOUD_TIMEOUT_MS", 30_000),
};

// ---------------------------------------------------------------------------
// §14 — Codex SDK / API-key transport (OPTIONAL only)
// Per Phase 4.1 Finalization §14: CODEX_SDK_ENABLED defaults to false.
// The API-key path is a SEPARATE API-billed transport; never silently
// enabled when CLI is rate-limited (§13, §41).
// ---------------------------------------------------------------------------

export interface CodexSdkConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  workspaceRoot: string;
  maxTokens: number;
  defaultTimeoutMs: number;
  /** Whether the @openai/codex-sdk package has been installed. */
  sdkInstalled: boolean;
}

export const CODEX_SDK_CONFIG: CodexSdkConfig = {
  // §14 — OPTIONAL only. Never auto-enable when CLI is rate-limited (§41).
  enabled: envBool("CODEX_SDK_ENABLED", false),
  apiKey: envStr("CODEX_API_KEY", ""),
  model: envStr("CODEX_MODEL", "gpt-5-codex"),
  workspaceRoot: envStr("CODEX_SDK_WORKSPACE_ROOT", "/tmp/haydevlegal-case"),
  maxTokens: envInt("CODEX_SDK_MAX_TOKENS", 16_000),
  defaultTimeoutMs: envInt("CODEX_SDK_TIMEOUT_MS", 120_000),
  // Probed at registry init; false until proven otherwise (§111).
  sdkInstalled: false,
};

// ---------------------------------------------------------------------------
// §15 — Codex CLI (PRIMARY transport via ChatGPT account auth)
// Per Phase 4.1 Finalization: CODEX_CLI_ENABLED defaults to true; the
// primary Codex path uses the user's ChatGPT plan allowance, NOT an API
// key. The optional API-key path is governed by CODEX_SDK_ENABLED below.
// ---------------------------------------------------------------------------

export interface CodexCliConfig {
  /** Default true — Codex CLI is the primary deep-analysis engine. */
  enabled: boolean;
  /** Explicit override for the codex binary path (§9.1). */
  cliPath: string;
  /** Model name (optional; CLI uses account-default when unset). */
  model: string;
  /** Reasoning effort: minimal|low|medium|high|xhigh|max|ultra|persistent. */
  reasoningEffort: string;
  workspaceRoot: string;
  maxTokens: number;
  defaultTimeoutMs: number;
  /** Probed at registry init via 3-path detection (§9). */
  binaryAvailable: boolean;
}

export const CODEX_CLI_CONFIG: CodexCliConfig = {
  // §15 — Codex CLI is the PRIMARY transport; enabled by default.
  enabled: envBool("CODEX_CLI_ENABLED", true),
  cliPath: envStr("CODEX_CLI_PATH", ""),
  model: envStr("CODEX_MODEL", ""),
  reasoningEffort: envStr("CODEX_REASONING_EFFORT", "medium"),
  workspaceRoot: envStr("CODEX_CLI_WORKSPACE_ROOT", "/tmp/haydevlegal-case"),
  maxTokens: envInt("CODEX_CLI_MAX_TOKENS", 16_000),
  defaultTimeoutMs: envInt("CODEX_CLI_TIMEOUT_MS", 180_000),
  binaryAvailable: false,
};

// ---------------------------------------------------------------------------
// §49 — Routing policy (task → ordered provider list, sequential fallback)
// Promise.any is FORBIDDEN (§56) — we MUST try providers in order.
// ---------------------------------------------------------------------------

export const ROUTING_POLICY: Record<AiTaskType, AiProviderId[]> = {
  // §8 — QUERY_DECOMPOSITION: Z-AI → Ollama Cloud → (deterministic implicit)
  QUERY_DECOMPOSITION: ["zai", "ollama-cloud"],
  // §8 — LIGHT_HOLDING_EXTRACTION: Ollama Cloud → Z-AI → codex-cli only if budget allows
  LIGHT_HOLDING_EXTRACTION: ["ollama-cloud", "zai", "codex-cli"],
  // §8 — MATERIAL_FACT_EXTRACTION: Ollama Cloud → Z-AI → codex-cli only if budget allows
  MATERIAL_FACT_EXTRACTION: ["ollama-cloud", "zai", "codex-cli"],
  // §7 — CASE_ANALYSIS: codex-cli (PRIMARY) → codex-sdk (optional API) → ollama-cloud
  CASE_ANALYSIS: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — MULTI_CASE_COMPARISON: codex-cli → codex-sdk → ollama-cloud
  MULTI_CASE_COMPARISON: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — PRECEDENT_APPLICABILITY: codex-cli → codex-sdk → ollama-cloud
  PRECEDENT_APPLICABILITY: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — DISTINGUISHING_ANALYSIS: codex-cli → codex-sdk → ollama-cloud
  DISTINGUISHING_ANALYSIS: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — PRECEDENT_LINEAGE: codex-cli → codex-sdk → ollama-cloud
  PRECEDENT_LINEAGE: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — COUNTER_AUTHORITY_ANALYSIS: codex-cli → codex-sdk → ollama-cloud
  COUNTER_AUTHORITY_ANALYSIS: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — ARGUMENT_MAP: codex-cli → codex-sdk → ollama-cloud
  ARGUMENT_MAP: ["codex-cli", "codex-sdk", "ollama-cloud"],
  // §7 — DEEP_CASE_SYNTHESIS: codex-cli → codex-sdk → ollama-cloud → zai (4th fallback)
  DEEP_CASE_SYNTHESIS: ["codex-cli", "codex-sdk", "ollama-cloud", "zai"],
  // §8 — FINAL_ANSWER: configured healthy fast cloud provider
  FINAL_ANSWER: ["zai", "ollama-cloud"],
};

// ---------------------------------------------------------------------------
// §57 — Scheduler config (attempt budget, deadline, provider min-time)
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** Max providers to try per call (after which we give up). */
  maxAttempts: number;
  /** Skip a provider if remaining time < providerMinTimeMs (§57). */
  providerMinTimeMs: number;
  /** Default hard deadline (ms from now) if ctx.deadlineAt not supplied. */
  defaultDeadlineMs: number;
}

export const SCHEDULER_CONFIG: SchedulerConfig = {
  maxAttempts: envInt("AI_RUNTIME_MAX_ATTEMPTS", 3),
  providerMinTimeMs: envInt("AI_RUNTIME_PROVIDER_MIN_TIME_MS", 2_000),
  defaultDeadlineMs: envInt("AI_RUNTIME_DEFAULT_DEADLINE_MS", 30_000),
};

// ---------------------------------------------------------------------------
// §52 — Circuit-breaker config
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** Open state duration in ms. */
  openStateMs: number;
  /** Half-open: allow 1 probe request after open state elapses. */
  halfOpenProbes: number;
}

export const CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: envInt("AI_CB_FAILURE_THRESHOLD", 3),
  openStateMs: envInt("AI_CB_OPEN_MS", 60_000),
  halfOpenProbes: envInt("AI_CB_HALF_OPEN_PROBES", 1),
};

// ---------------------------------------------------------------------------
// Allow test harnesses to override env-derived config without touching
// process.env. (Production code reads the exported constants above.)
// ---------------------------------------------------------------------------

export type ProviderConfigMap = {
  zai: ZaiProviderConfig;
  "ollama-cloud": OllamaCloudConfig;
  "codex-sdk": CodexSdkConfig;
  "codex-cli": CodexCliConfig;
};

/** Snapshot the env-derived config for diagnostics (does NOT include secrets). */
export function describeProviderConfig(): Record<
  AiProviderId,
  { enabled: boolean; configured: boolean; detail: string }
> {
  return {
    zai: {
      enabled: ZAI_CONFIG.enabled,
      configured: true,
      detail: "z-ai-web-dev-sdk bundled",
    },
    "ollama-cloud": {
      enabled: OLLAMA_CLOUD_CONFIG.enabled,
      configured: Boolean(OLLAMA_CLOUD_CONFIG.apiKey && OLLAMA_CLOUD_CONFIG.model),
      detail: OLLAMA_CLOUD_CONFIG.enabled
        ? `model=${OLLAMA_CLOUD_CONFIG.model || "(unset)"}`
        : "OLLAMA_CLOUD_ENABLED=false",
    },
    "codex-sdk": {
      enabled: CODEX_SDK_CONFIG.enabled,
      configured: Boolean(CODEX_SDK_CONFIG.apiKey && CODEX_SDK_CONFIG.sdkInstalled),
      detail: CODEX_SDK_CONFIG.enabled
        ? CODEX_SDK_CONFIG.sdkInstalled
          ? `model=${CODEX_SDK_CONFIG.model}`
          : "enabled but @openai/codex-sdk not installed"
        : "CODEX_SDK_ENABLED=false",
    },
    "codex-cli": {
      enabled: CODEX_CLI_CONFIG.enabled,
      configured: CODEX_CLI_CONFIG.binaryAvailable,
      detail: CODEX_CLI_CONFIG.enabled
        ? CODEX_CLI_CONFIG.binaryAvailable
          ? "binary available (cli-chatgpt transport)"
          : "enabled but `codex` binary not found in CODEX_CLI_PATH / node_modules/.bin / PATH"
        : "CODEX_CLI_ENABLED=false",
    },
  };
}
