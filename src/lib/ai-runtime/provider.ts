// src/lib/ai-runtime/provider.ts
// Re-exports the AiProvider interface so provider implementations depend on
// `./provider` (semantically "the provider contract"), while business code
// depends on `./types`. Both resolve to the same TypeScript type — this is a
// documentation seam, not a runtime one.

export type {
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
  AiMessage,
  ProviderRuntimeState,
  ProviderRuntimeStatus,
} from "./types";
