// src/lib/ai-runtime/providers/zai.ts
// Z-AI provider — wraps z-ai-web-dev-sdk with a SHARED COOLDOWN (§23–§25).
//
// The Z-AI SDK exposes a project-wide quota. When any call returns 429, we
// mark the provider RATE_LIMITED for cooldownMs; subsequent calls return
// RATE_LIMITED WITHOUT calling the SDK until cooldown expires (§25).
//
// The previous src/lib/legal-research/llm.ts triggerCooldown logic is the
// reference implementation; this is its runtime form. Task 4 will migrate
// llm.ts onto this provider.

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
import { ZAI_CONFIG } from "../config";
import {
  extractJson,
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

const ZAI_CAPABILITIES: AiProviderCapabilities = {
  structuredOutput: true,
  streaming: true,
  caseAnalysis: false,
  maxTokens: ZAI_CONFIG.maxTokens,
  defaultTimeoutMs: ZAI_CONFIG.defaultTimeoutMs,
};

/**
 * Z-AI provider. Singleton (constructed by the registry).
 *
 * Health is computed lazily — Z-AI is always configured (the SDK is the
 * project baseline), but the registry may have marked it RATE_LIMITED or
 * CIRCUIT_OPEN from prior calls. health() reflects those transient states.
 */
export class ZaiProvider implements AiProvider {
  readonly id: AiProviderId = "zai";
  readonly capabilities: AiProviderCapabilities = ZAI_CAPABILITIES;

  async health(): Promise<AiProviderHealth> {
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        detail: `cooldown ${remainingCooldownMs(this.id)}ms`,
        lastCheckedAt: Date.now(),
      };
    }
    return {
      status: "HEALTHY",
      detail: "z-ai-web-dev-sdk bundled",
      lastCheckedAt: Date.now(),
    };
  }

  async generateText(
    req: AiTextRequest,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<string>> {
    // §25 — short-circuit without calling the SDK while in cooldown.
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }

    const timeoutMs =
      req.timeoutMs ?? ZAI_CONFIG.defaultTimeoutMs;
    const startedAt = Date.now();
    incActive(this.id);
    try {
      const work = (async () => {
        const ZAI = (await import("z-ai-web-dev-sdk")).default;
        const zai = await ZAI.create();
        const resp = (await zai.chat.completions.create({
          messages: req.messages,
          thinking: ZAI_CONFIG.disableThinking
            ? { type: "disabled" }
            : undefined,
          max_tokens: req.maxTokens ?? ZAI_CONFIG.maxTokens,
          temperature: req.temperature,
        })) as { choices?: Array<{ message?: { content?: string } }> };
        const content = resp.choices?.[0]?.message?.content ?? "";
        return content;
      })();
      const { promise, cancel } = withTimeout<string>(work, timeoutMs, ctx);
      let content: string;
      try {
        content = await promise;
      } finally {
        cancel();
      }
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
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }
    const timeoutMs =
      req.timeoutMs ?? ZAI_CONFIG.defaultTimeoutMs;
    const startedAt = Date.now();
    incActive(this.id);
    try {
      const work = (async () => {
        const ZAI = (await import("z-ai-web-dev-sdk")).default;
        const zai = await ZAI.create();
        const resp = (await zai.chat.completions.create({
          messages: req.messages,
          thinking: ZAI_CONFIG.disableThinking
            ? { type: "disabled" }
            : undefined,
          max_tokens: req.maxTokens ?? ZAI_CONFIG.maxTokens,
          temperature: req.temperature,
        })) as { choices?: Array<{ message?: { content?: string } }> };
        return resp.choices?.[0]?.message?.content ?? "";
      })();
      const { promise, cancel } = withTimeout<string>(work, timeoutMs, ctx);
      let rawContent: string;
      try {
        rawContent = await promise;
      } finally {
        cancel();
      }
      // On success, clear any stale cooldown.
      clearCooldown(this.id);
      return finalizeStructuredResult(
        rawContent,
        req.schema,
        this.id,
        startedAt,
      );
    } catch (err) {
      return this.handleErr(err, startedAt);
    } finally {
      decActive(this.id);
    }
  }

  /**
   * Map errors → AiResult. 429 → RATE_LIMITED (trigger cooldown); timeout
   * (Error("ai timeout") or "aborted") → TIMEOUT; everything else → ERROR.
   */
  private handleErr<T>(
    err: unknown,
    startedAt: number,
  ): AiResult<T> {
    const msg = err instanceof Error ? err.message : String(err);
    const rl = isRateLimitError(err);
    if (rl.rateLimited) {
      triggerCooldown(this.id, ZAI_CONFIG.cooldownMs, rl.retryAfterMs);
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: rl.retryAfterMs ?? ZAI_CONFIG.cooldownMs,
      };
    }
    if (/ai timeout|aborted/i.test(msg)) {
      return { status: "TIMEOUT", provider: this.id };
    }
    return {
      status: "ERROR",
      provider: this.id,
      detail: msg,
    };
  }
}

// Re-export extractJson so legacy callers can transition off llm.ts.
export { extractJson };
