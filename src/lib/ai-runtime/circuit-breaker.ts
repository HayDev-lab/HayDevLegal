// src/lib/ai-runtime/circuit-breaker.ts
// Open / half-open / closed circuit breaker per provider (§52).
//
// After N consecutive failures (TIMEOUT/UNAVAILABLE/ERROR/INVALID_SCHEMA
// but NOT RATE_LIMITED — that's handled by rate-limit.ts) the breaker
// opens: subsequent calls short-circuit to UNAVAILABLE without touching
// the provider. After `openStateMs` it goes half-open and allows ONE probe
// request; success closes, failure re-opens for another `openStateMs`.

import type { AiProviderId } from "./types";
import { CIRCUIT_BREAKER_CONFIG } from "./config";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  openedAt?: number;
  /** Number of probe requests currently allowed in half-open. */
  halfOpenTokens: number;
}

const store = new Map<AiProviderId, CircuitBreakerState>();

function ensure(provider: AiProviderId): CircuitBreakerState {
  let s = store.get(provider);
  if (!s) {
    s = { state: "CLOSED", failures: 0, halfOpenTokens: 0 };
    store.set(provider, s);
  }
  return s;
}

/**
 * Returns the current state, possibly transitioning OPEN → HALF_OPEN if
 * enough time has elapsed. The caller (router) treats HALF_OPEN as "try
 * exactly one probe".
 */
export function getState(
  provider: AiProviderId,
  now = Date.now(),
): CircuitBreakerState {
  const s = ensure(provider);
  if (s.state === "OPEN" && s.openedAt !== undefined) {
    if (now - s.openedAt >= CIRCUIT_BREAKER_CONFIG.openStateMs) {
      s.state = "HALF_OPEN";
      s.halfOpenTokens = CIRCUIT_BREAKER_CONFIG.halfOpenProbes;
    }
  }
  return s;
}

/**
 * Should the router attempt a call to this provider right now?
 * - CLOSED → yes
 * - HALF_OPEN with token → yes (and consume one token)
 * - OPEN → no
 */
export function shouldAttempt(provider: AiProviderId, now = Date.now()): boolean {
  const s = getState(provider, now);
  if (s.state === "CLOSED") return true;
  if (s.state === "HALF_OPEN" && s.halfOpenTokens > 0) {
    s.halfOpenTokens -= 1;
    return true;
  }
  return false;
}

/** Record a SUCCESS — close the breaker, reset failures. */
export function recordSuccess(provider: AiProviderId): void {
  const s = ensure(provider);
  s.state = "CLOSED";
  s.failures = 0;
  s.openedAt = undefined;
  s.halfOpenTokens = 0;
}

/**
 * Record a failure. RATE_LIMITED does NOT count (§52 — rate limiting is
 * a separate concern; cooldown is handled in rate-limit.ts).
 *
 * After N consecutive failures, the breaker opens.
 */
export function recordFailure(provider: AiProviderId, now = Date.now()): void {
  const s = ensure(provider);
  // If we were HALF_OPEN and the probe failed, re-open.
  if (s.state === "HALF_OPEN") {
    s.state = "OPEN";
    s.openedAt = now;
    s.halfOpenTokens = 0;
    return;
  }
  s.failures += 1;
  if (s.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    s.state = "OPEN";
    s.openedAt = now;
    s.halfOpenTokens = 0;
  }
}

/** True if the breaker is currently OPEN or HALF_OPEN. */
export function isOpen(provider: AiProviderId, now = Date.now()): boolean {
  const s = getState(provider, now);
  return s.state === "OPEN" || s.state === "HALF_OPEN";
}

/** Snapshot for diagnostics. */
export function snapshotBreaker(provider: AiProviderId): CircuitBreakerState {
  return { ...ensure(provider) };
}

/** Test-only — wipe all breaker state. */
export function resetBreakers(): void {
  store.clear();
}
