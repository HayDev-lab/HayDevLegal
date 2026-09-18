// src/lib/ai-runtime/index.ts
// Public surface of the Unified AI Runtime.
//
// Master prompt PART B §15–§22, PART C §23–§31, PART F §52–§58.
//
// Business code imports from this file:
//   import { getAiRuntime } from "@/lib/ai-runtime";
//   const rt = getAiRuntime();
//   const result = await rt.generateStructured(req, "QUERY_DECOMPOSITION", ctx);
//
// NEVER import a provider class directly from business code. The runtime is
// the single entry point.

import type {
  AiProvider,
  AiProviderHealth,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStageTraceEntry,
  AiStructuredRequest,
  AiTaskType,
  AiTextRequest,
} from "./types";
import { healthSnapshot, getInstance, resetRegistry } from "./registry";
import {
  routeGenerateText,
  routeGenerateStructured,
  getStageTrace,
  resetStageTrace,
} from "./router";
import { getAllMetrics, latencyPercentiles, resetMetrics } from "./metrics";
import type { ProviderMetrics } from "./metrics";

// ---------------------------------------------------------------------------
// AiRuntime — the public interface business code talks to
// ---------------------------------------------------------------------------

export interface AiRuntime {
  generateText(
    req: AiTextRequest,
    task: AiTaskType,
    ctx?: AiRuntimeContext,
  ): Promise<AiResult<string>>;
  generateStructured<T>(
    req: AiStructuredRequest<T>,
    task: AiTaskType,
    ctx?: AiRuntimeContext,
  ): Promise<AiResult<T>>;
  health(): Promise<Record<AiProviderId, AiProviderHealth>>;
  metrics(): Record<AiProviderId, ProviderMetrics & { p50: number; p95: number }>;
  stageTrace(): AiStageTraceEntry[];
  /**
   * Direct access to a specific provider (escape hatch for advanced callers;
   * e.g. the codex closed-evidence case analysis, which bypasses routing).
   */
  provider(id: AiProviderId): AiProvider | undefined;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let runtime: AiRuntime | null = null;

export function getAiRuntime(): AiRuntime {
  if (runtime) return runtime;
  runtime = {
    async generateText(req, task, ctx) {
      return routeGenerateText(req, task, ctx);
    },
    async generateStructured(req, task, ctx) {
      return routeGenerateStructured(req, task, ctx);
    },
    async health() {
      return healthSnapshot();
    },
    metrics() {
      const all = getAllMetrics();
      // Augment with p50/p95 latency.
      const out = {} as Record<
        AiProviderId,
        ProviderMetrics & { p50: number; p95: number }
      >;
      for (const id of Object.keys(all) as AiProviderId[]) {
        const p = latencyPercentiles(id);
        out[id] = { ...all[id], p50: p.p50, p95: p.p95 };
      }
      return out;
    },
    stageTrace() {
      return getStageTrace();
    },
    provider(id) {
      return getInstance(id);
    },
  };
  return runtime;
}

/** Test-only — wipe the singleton + the in-process state. */
export function resetAiRuntime(): void {
  runtime = null;
  resetStageTrace();
  resetRegistry();
  resetMetrics();
}

// ---------------------------------------------------------------------------
// Type + helper re-exports (public API)
// ---------------------------------------------------------------------------

export type {
  AiMessage,
  AiProvider,
  AiProviderCapabilities,
  AiProviderHealth,
  AiProviderHealthStatus,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStageTraceEntry,
  AiStructuredRequest,
  AiTaskType,
  AiTextRequest,
  ProviderRuntimeState,
  ProviderRuntimeStatus,
} from "./types";

export {
  ROUTING_POLICY,
  SCHEDULER_CONFIG,
  CIRCUIT_BREAKER_CONFIG,
  describeProviderConfig,
} from "./config";

export type {
  ProviderMetrics,
  AiOutcome,
} from "./metrics";

export {
  extractJson,
  requestStructured,
  validateStructured,
  isRateLimitError,
  withTimeout,
} from "./structured-generation";

export {
  healthSnapshot,
  getInstance,
} from "./registry";

export {
  routeGenerateText,
  routeGenerateStructured,
  explainRoutingFor,
} from "./router";
