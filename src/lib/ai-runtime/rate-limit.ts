// src/lib/ai-runtime/rate-limit.ts
// Per-provider 429 cooldown tracker (§24, §53).
//
// IMPORTANT: this is PER-PROVIDER, not global. A 429 from Ollama Cloud must
// NOT block Z-AI. The only exception in the entire runtime is the Z-AI SDK
// shared quota (§24) — but that is modeled by setting this same tracker on
// the Z-AI provider only; no other provider consults it.
//
// The registry holds one RateLimitState per AiProviderId; providers and the
// router ask "should I skip?" before calling the underlying SDK/HTTP.

import type { AiProviderId } from "./types";

export interface RateLimitState {
  /** Epoch ms until which the provider should NOT be called. */
  cooldownUntil: number;
  /** Last observed retry-after hint from the upstream (if any). */
  lastRetryAfterMs?: number;
  /** Count of 429s observed (for diagnostics / metrics). */
  hits: number;
}

const store = new Map<AiProviderId, RateLimitState>();

function ensure(provider: AiProviderId): RateLimitState {
  let s = store.get(provider);
  if (!s) {
    s = { cooldownUntil: 0, hits: 0 };
    store.set(provider, s);
  }
  return s;
}

/** Returns true if the provider is currently in cooldown. */
export function isInCooldown(provider: AiProviderId, now = Date.now()): boolean {
  const s = ensure(provider);
  return s.cooldownUntil > now;
}

/** Remaining cooldown ms (>=0). Returns 0 if expired or never set. */
export function remainingCooldownMs(provider: AiProviderId, now = Date.now()): number {
  const s = ensure(provider);
  if (s.cooldownUntil <= now) return 0;
  return s.cooldownUntil - now;
}

/**
 * Mark a provider as RATE_LIMITED.
 * @param cooldownMs If omitted, uses `lastRetryAfterMs` (or default 4000).
 */
export function triggerCooldown(
  provider: AiProviderId,
  cooldownMs?: number,
  retryAfterMs?: number,
  now = Date.now(),
): void {
  const s = ensure(provider);
  s.hits += 1;
  if (retryAfterMs !== undefined) s.lastRetryAfterMs = retryAfterMs;
  const cd =
    cooldownMs ?? retryAfterMs ?? s.lastRetryAfterMs ?? 4_000;
  s.cooldownUntil = Math.max(s.cooldownUntil, now + cd);
}

/** Clear cooldown (called after a SUCCESS — provider is healthy again). */
export function clearCooldown(provider: AiProviderId): void {
  const s = ensure(provider);
  s.cooldownUntil = 0;
}

/** Read-only snapshot for the health endpoint. */
export function snapshotRateLimit(provider: AiProviderId): RateLimitState {
  const s = ensure(provider);
  return { cooldownUntil: s.cooldownUntil, lastRetryAfterMs: s.lastRetryAfterMs, hits: s.hits };
}

/** Test-only — wipe all cooldown state. */
export function resetRateLimits(): void {
  store.clear();
}
