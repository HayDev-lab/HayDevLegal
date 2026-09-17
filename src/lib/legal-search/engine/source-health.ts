// src/lib/legal-search/engine/source-health.ts
// Per-capability source health registry (Phase 3 §61-§62).
//
// Adapters and the resolver record the outcome of every SEARCH and every
// DOCUMENT operation. The health endpoint reports them SEPARATELY:
//   "DATALEX SEARCH: HEALTHY / DATALEX DOCUMENT: DEGRADED (captcha-gated)"
// which is far more informative than a single source status.
//
// Also implements a light circuit breaker (§62): 3 consecutive failures
// open the circuit for 60s (half-open afterwards). Search and document
// circuits are tracked separately.

export type Capability = "search" | "document";
export type HealthState = "HEALTHY" | "DEGRADED" | "RESTRICTED" | "OPEN" | "UNKNOWN";

type HealthRecord = {
  lastOkAt?: number;
  lastFailAt?: number;
  lastRestrictedAt?: number;
  consecutiveFailures: number;
  circuitOpenedAt?: number;
  total: number;
  ok: number;
};

const registry = new Map<string, HealthRecord>();

function rec(source: string, cap: Capability): HealthRecord {
  const key = `${source}:${cap}`;
  let r = registry.get(key);
  if (!r) {
    r = { consecutiveFailures: 0, total: 0, ok: 0 };
    registry.set(key, r);
  }
  return r;
}

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

/** Record a successful operation. */
export function recordSuccess(source: string, cap: Capability): void {
  const r = rec(source, cap);
  r.total++;
  r.ok++;
  r.lastOkAt = Date.now();
  r.consecutiveFailures = 0;
  r.circuitOpenedAt = undefined;
}

/** Record a failed operation (timeout / error — not restriction). */
export function recordFailure(source: string, cap: Capability): void {
  const r = rec(source, cap);
  r.total++;
  r.lastFailAt = Date.now();
  r.consecutiveFailures++;
  if (r.consecutiveFailures >= CIRCUIT_THRESHOLD && !r.circuitOpenedAt) {
    r.circuitOpenedAt = Date.now();
  }
}

/** Record an access restriction (captcha / cloudflare) — distinct from failure. */
export function recordRestricted(source: string, cap: Capability): void {
  const r = rec(source, cap);
  r.lastRestrictedAt = Date.now();
  r.total++;
}

/** Is the circuit open (fail fast) for this source+capability? */
export function circuitOpen(source: string, cap: Capability): boolean {
  const r = registry.get(`${source}:${cap}`);
  if (!r?.circuitOpenedAt) return false;
  if (Date.now() - r.circuitOpenedAt > CIRCUIT_COOLDOWN_MS) {
    // half-open: allow one attempt through
    r.circuitOpenedAt = undefined;
    r.consecutiveFailures = CIRCUIT_THRESHOLD - 1;
    return false;
  }
  return true;
}

/** Current health state for a source+capability (§61). */
export function healthState(source: string, cap: Capability): { state: HealthState; detail?: string } {
  const r = registry.get(`${source}:${cap}`);
  if (!r || r.total === 0) return { state: "UNKNOWN" };
  if (r.circuitOpenedAt && Date.now() - r.circuitOpenedAt <= CIRCUIT_COOLDOWN_MS) {
    return { state: "OPEN", detail: `${r.consecutiveFailures} անընդհատ ձախողում` };
  }
  const now = Date.now();
  const recentRestricted = r.lastRestrictedAt && now - r.lastRestrictedAt < 5 * 60_000;
  const recentOk = r.lastOkAt && now - r.lastOkAt < 5 * 60_000;
  const recentFail = r.lastFailAt && now - r.lastFailAt < 60_000;
  if (recentFail && !recentOk) return { state: "DEGRADED" };
  if (recentRestricted && !recentOk) {
    return {
      state: "RESTRICTED",
      detail: cap === "document" ? "ամբողջական տեքստը սահմանափակված է (captcha/cloudflare)" : undefined,
    };
  }
  if (recentOk || r.ok > 0) return { state: "HEALTHY" };
  return { state: "UNKNOWN" };
}

/** Snapshot for diagnostics (bounded, no secrets). */
export function healthSnapshot(): Record<string, { state: HealthState; detail?: string }> {
  const out: Record<string, { state: HealthState; detail?: string }> = {};
  for (const key of registry.keys()) {
    const [source, cap] = key.split(":");
    out[`${source} ${cap}`] = healthState(source, cap as Capability);
  }
  return out;
}
