// src/lib/ai-runtime/metrics.ts
// Per-provider metrics: counts, latency samples for p50/p95, active requests.
// Master prompt §71.

import type { AiProviderId } from "./types";

export type AiOutcome =
  | "SUCCESS"
  | "SUCCESS_EMPTY"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_SCHEMA"
  | "ERROR";

export interface ProviderMetrics {
  requests: number;
  success: number;
  successEmpty: number;
  rateLimited: number;
  timeouts: number;
  schemaFailures: number;
  verificationRejects: number;
  activeRequests: number;
  /** Recent latency samples (bounded ring buffer) — for p50/p95. */
  latencySamples: number[];
}

const LATENCY_SAMPLE_CAP = 200;

function fresh(): ProviderMetrics {
  return {
    requests: 0,
    success: 0,
    successEmpty: 0,
    rateLimited: 0,
    timeouts: 0,
    schemaFailures: 0,
    verificationRejects: 0,
    activeRequests: 0,
    latencySamples: [],
  };
}

const store = new Map<AiProviderId, ProviderMetrics>();

function ensure(id: AiProviderId): ProviderMetrics {
  let m = store.get(id);
  if (!m) {
    m = fresh();
    store.set(id, m);
  }
  return m;
}

/**
 * Record the outcome of one provider call.
 * Call this in the provider implementations (or the router) once per call.
 */
export function recordProviderCall(
  provider: AiProviderId,
  outcome: AiOutcome,
  latencyMs: number,
): void {
  const m = ensure(provider);
  m.requests += 1;
  // activeRequests is tracked separately via incActive/decActive; we don't
  // touch it here to avoid double-counting.
  switch (outcome) {
    case "SUCCESS":
      m.success += 1;
      m.latencySamples.push(latencyMs);
      if (m.latencySamples.length > LATENCY_SAMPLE_CAP) m.latencySamples.shift();
      break;
    case "SUCCESS_EMPTY":
      m.successEmpty += 1;
      m.latencySamples.push(latencyMs);
      if (m.latencySamples.length > LATENCY_SAMPLE_CAP) m.latencySamples.shift();
      break;
    case "RATE_LIMITED":
      m.rateLimited += 1;
      break;
    case "TIMEOUT":
      m.timeouts += 1;
      break;
    case "INVALID_SCHEMA":
      m.schemaFailures += 1;
      break;
    // UNAVAILABLE and ERROR do not have a dedicated counter — they are
    // implicitly `requests - (everything else)`. If we need finer breakdown
    // in the future, add explicit counters without breaking the interface.
    default:
      break;
  }
}

/** Incremented at call start, decremented at call end. */
export function incActive(provider: AiProviderId): void {
  ensure(provider).activeRequests += 1;
}
export function decActive(provider: AiProviderId): void {
  const m = ensure(provider);
  if (m.activeRequests > 0) m.activeRequests -= 1;
}

/** Mark a verification rejection (§71) — kept separate from schema failures. */
export function recordVerificationReject(provider: AiProviderId): void {
  ensure(provider).verificationRejects += 1;
}

/** Get a defensive copy of provider metrics (with p50/p95 computed). */
export function getProviderMetrics(provider: AiProviderId): ProviderMetrics {
  const m = ensure(provider);
  // Return a shallow copy with a cloned sample array so callers can't mutate.
  return {
    ...m,
    latencySamples: m.latencySamples.slice(),
  };
}

/** Get all metrics (e.g. for /api/health). */
export function getAllMetrics(): Record<AiProviderId, ProviderMetrics> {
  const ids: AiProviderId[] = [
    "zai",
    "ollama-cloud",
    "codex-sdk",
    "codex-cli",
  ];
  const out = {} as Record<AiProviderId, ProviderMetrics>;
  for (const id of ids) out[id] = getProviderMetrics(id);
  return out;
}

/** Compute p50/p95 latency (ms) from the samples. Returns 0 if no samples. */
export function latencyPercentiles(
  provider: AiProviderId,
): { p50: number; p95: number; samples: number } {
  const m = ensure(provider);
  if (m.latencySamples.length === 0) return { p50: 0, p95: 0, samples: 0 };
  const sorted = m.latencySamples.slice().sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(p * sorted.length)),
    );
    return sorted[idx];
  };
  return { p50: pick(0.5), p95: pick(0.95), samples: sorted.length };
}

/** Test-only — wipe all metrics. */
export function resetMetrics(): void {
  store.clear();
}
