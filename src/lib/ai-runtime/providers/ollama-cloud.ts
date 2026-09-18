// src/lib/ai-runtime/providers/ollama-cloud.ts
// Ollama Cloud provider (§26–§29).
//
// Uses the Ollama Cloud REST API:
//   POST ${host}/api/chat
//   body: { model, messages, stream: false, format?: "json" }
//   Authorization: Bearer ${OLLAMA_API_KEY}
//
// IMPORTANT (§31): this provider uses `fetch()` DIRECTLY. It is NOT routed
// through fetchGuarded — that hardening applies to USER-SUPPLIED URLs in
// the legal-search engine. The Ollama transport here is a controlled
// internal provider, not a user-supplied URL.
//
// If OLLAMA_CLOUD_ENABLED is false (the default) or OLLAMA_API_KEY is
// missing, `health()` returns UNCONFIGURED (§111 — never fake a pass).

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
import { OLLAMA_CLOUD_CONFIG } from "../config";
import {
  finalizeStructuredResult,
  isRateLimitError,
  withTimeout,
} from "../structured-generation";
import {
  isInCooldown,
  remainingCooldownMs,
  triggerCooldown,
  clearCooldown,
} from "../rate-limit";
import { incActive, decActive } from "../metrics";

const CAPABILITIES: AiProviderCapabilities = {
  structuredOutput: true,
  streaming: true,
  caseAnalysis: false,
  maxTokens: OLLAMA_CLOUD_CONFIG.maxTokens,
  defaultTimeoutMs: OLLAMA_CLOUD_CONFIG.defaultTimeoutMs,
};

interface OllamaChatResponse {
  message?: { content?: string; role?: string };
  error?: string;
}

export class OllamaCloudProvider implements AiProvider {
  readonly id: AiProviderId = "ollama-cloud";
  readonly capabilities: AiProviderCapabilities = CAPABILITIES;

  private get configured(): boolean {
    return (
      OLLAMA_CLOUD_CONFIG.enabled &&
      Boolean(OLLAMA_CLOUD_CONFIG.apiKey) &&
      Boolean(OLLAMA_CLOUD_CONFIG.model)
    );
  }

  async health(): Promise<AiProviderHealth> {
    if (!OLLAMA_CLOUD_CONFIG.enabled) {
      return {
        status: "UNCONFIGURED",
        detail: "OLLAMA_CLOUD_ENABLED=false",
        lastCheckedAt: Date.now(),
      };
    }
    if (!this.configured) {
      return {
        status: "UNCONFIGURED",
        detail:
          "missing OLLAMA_API_KEY or OLLAMA_CLOUD_MODEL — provider disabled per §111",
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
      detail: `model=${OLLAMA_CLOUD_CONFIG.model}`,
      lastCheckedAt: Date.now(),
    };
  }

  async generateText(
    req: AiTextRequest,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<string>> {
    if (!this.configured) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "ollama-cloud not configured (§111)",
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }
    const timeoutMs = req.timeoutMs ?? OLLAMA_CLOUD_CONFIG.defaultTimeoutMs;
    const startedAt = Date.now();
    incActive(this.id);
    try {
      const work = this.callChat(req.messages, /* structured */ false, req);
      const { promise, cancel } = withTimeout<OllamaChatResponse>(work, timeoutMs, ctx);
      let resp: OllamaChatResponse;
      try {
        resp = await promise;
      } finally {
        cancel();
      }
      if (resp.error) {
        // Ollama surfaces errors in the response body (e.g. model not found).
        const rl = isRateLimitError(resp.error);
        if (rl.rateLimited) {
          triggerCooldown(this.id, undefined, rl.retryAfterMs);
          return {
            status: "RATE_LIMITED",
            provider: this.id,
            retryAfterMs: rl.retryAfterMs,
          };
        }
        return { status: "ERROR", provider: this.id, detail: resp.error };
      }
      const content = resp.message?.content ?? "";
      const latencyMs = Date.now() - startedAt;
      if (!content || content.trim() === "") {
        return { status: "SUCCESS_EMPTY", provider: this.id, latencyMs };
      }
      clearCooldown(this.id);
      return { status: "SUCCESS", value: content, provider: this.id, latencyMs };
    } catch (err) {
      return this.handleErr(err, startedAt);
    } finally {
      decActive(this.id);
    }
  }

  async generateStructured<T>(
    req: AiStructuredRequest<T>,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<T>> {
    if (!this.configured) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "ollama-cloud not configured (§111)",
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }
    const timeoutMs = req.timeoutMs ?? OLLAMA_CLOUD_CONFIG.defaultTimeoutMs;
    const startedAt = Date.now();
    incActive(this.id);
    try {
      const work = this.callChat(req.messages, /* structured */ true, req);
      const { promise, cancel } = withTimeout<OllamaChatResponse>(work, timeoutMs, ctx);
      let resp: OllamaChatResponse;
      try {
        resp = await promise;
      } finally {
        cancel();
      }
      if (resp.error) {
        const rl = isRateLimitError(resp.error);
        if (rl.rateLimited) {
          triggerCooldown(this.id, undefined, rl.retryAfterMs);
          return {
            status: "RATE_LIMITED",
            provider: this.id,
            retryAfterMs: rl.retryAfterMs,
          };
        }
        return { status: "ERROR", provider: this.id, detail: resp.error };
      }
      const rawContent = resp.message?.content ?? "";
      clearCooldown(this.id);
      return finalizeStructuredResult(rawContent, req.schema, this.id, startedAt);
    } catch (err) {
      return this.handleErr(err, startedAt);
    } finally {
      decActive(this.id);
    }
  }

  /**
   * Raw HTTP POST to ${host}/api/chat.
   * Uses `format: "json"` for structured requests so Ollama returns valid
   * JSON directly (no need to fence-parse — but finalizeStructuredResult
   * still handles it via extractJson for safety).
   */
  private async callChat(
    messages: AiTextRequest["messages"],
    structured: boolean,
    opts: { maxTokens?: number; temperature?: number },
  ): Promise<OllamaChatResponse> {
    const host = OLLAMA_CLOUD_CONFIG.host.replace(/\/+$/, "");
    const url = `${host}/api/chat`;
    const body: Record<string, unknown> = {
      model: OLLAMA_CLOUD_CONFIG.model,
      messages,
      stream: false,
      options: {
        num_predict: opts.maxTokens ?? OLLAMA_CLOUD_CONFIG.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };
    if (structured) body.format = "json";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OLLAMA_CLOUD_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter
        ? Number.parseInt(retryAfter, 10) * 1000
        : undefined;
      throw new Error(
        `429 too many requests${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama-cloud HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as OllamaChatResponse;
  }

  private handleErr<T>(err: unknown, startedAt: number): AiResult<T> {
    void startedAt; // (no latency on error variants in the type)
    const msg = err instanceof Error ? err.message : String(err);
    const rl = isRateLimitError(err);
    if (rl.rateLimited) {
      triggerCooldown(this.id, undefined, rl.retryAfterMs);
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: rl.retryAfterMs,
      };
    }
    if (/ai timeout|aborted/i.test(msg)) {
      return { status: "TIMEOUT", provider: this.id };
    }
    return { status: "ERROR", provider: this.id, detail: msg };
  }
}
