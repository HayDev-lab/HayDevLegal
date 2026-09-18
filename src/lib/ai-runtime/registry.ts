// src/lib/ai-runtime/registry.ts
// Provider registry: instantiates each provider lazily, exposes getInstance(),
// tracks ProviderRuntimeState, and offers a health snapshot.
//
// The registry is process-singleton. Tests can `resetRegistry()` between
// cases.

import { spawnSync } from "node:child_process";
import type {
  AiProvider,
  AiProviderHealth,
  AiProviderId,
  AiProviderHealthStatus,
  ProviderRuntimeState,
  ProviderRuntimeStatus,
} from "./types";
import {
  CODEX_CLI_CONFIG,
  CODEX_SDK_CONFIG,
  describeProviderConfig,
} from "./config";
import { ZaiProvider } from "./providers/zai";
import { OllamaCloudProvider } from "./providers/ollama-cloud";
import { CodexSdkProvider } from "./providers/codex-sdk";
import { CodexCliProvider } from "./providers/codex-cli";
import { isInCooldown } from "./rate-limit";
import { isOpen } from "./circuit-breaker";
import { resetRateLimits } from "./rate-limit";
import { resetBreakers } from "./circuit-breaker";

// ---------------------------------------------------------------------------
// Codex availability probing (§111 — never fake a pass)
// ---------------------------------------------------------------------------

/**
 * Sync probe for `which codex` via `codex --version` (§35). Uses
 * spawnSync with NO shell interpolation. Failures are silent — the binary
 * is treated as unavailable, which surfaces honestly as UNAVAILABLE in
 * health. Called once at module load.
 */
function probeCodexCliAvailability(): boolean {
  if (!CODEX_CLI_CONFIG.enabled) return false;
  try {
    const r = spawnSync(CODEX_CLI_CONFIG.binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: 3_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Sync probe for @openai/codex-sdk. We CANNOT use a sync require.resolve in
 * strict ESM. Instead, we attempt a require() via the global (which Bun and
 * Next.js server bundles both expose). If unavailable, the codex-sdk
 * provider's health() will report UNAVAILABLE (§111 — never fake a pass).
 *
 * The CodexSdkProvider ALSO does a lazy async import probe in its own
 * health() method, so this is a belt-and-suspenders optimization: if the
 * sync probe says "not installed", we skip even trying to construct the
 * provider's lazy import probe. If the sync probe is unavailable (e.g. in
 * a stricter ESM environment), the lazy probe will catch it.
 */
function probeCodexSdkInstalled(): boolean {
  if (!CODEX_SDK_CONFIG.enabled) return false;
  // The runtime is server-only; require.resolve is available under Bun and
  // under Next.js server bundles. We guard with try/catch.
  type GlobalWithRequire = { require?: NodeRequire };
  const g = globalThis as unknown as GlobalWithRequire;
  if (typeof g.require !== "function") return false;
  try {
    g.require.resolve("@openai/codex-sdk");
    return true;
  } catch {
    return false;
  }
}

// Probe once at module load.
CODEX_CLI_CONFIG.binaryAvailable = probeCodexCliAvailability();
CODEX_SDK_CONFIG.sdkInstalled = probeCodexSdkInstalled();

// ---------------------------------------------------------------------------
// Lazy provider instances
// ---------------------------------------------------------------------------

const providers = new Map<AiProviderId, AiProvider>();

function create(id: AiProviderId): AiProvider | undefined {
  switch (id) {
    case "zai":
      return new ZaiProvider();
    case "ollama-cloud":
      return new OllamaCloudProvider();
    case "codex-sdk":
      return new CodexSdkProvider();
    case "codex-cli":
      return new CodexCliProvider();
    default:
      return undefined;
  }
}

/**
 * Return the provider instance, creating it lazily. Returns undefined for
 * unknown provider ids (caller should treat as UNCONFIGURED).
 */
export function getInstance(id: AiProviderId): AiProvider | undefined {
  let p = providers.get(id);
  if (!p) {
    p = create(id);
    if (p) providers.set(id, p);
  }
  return p;
}

/** All known provider ids in canonical order (used by /api/health). */
export const ALL_PROVIDER_IDS: readonly AiProviderId[] = [
  "zai",
  "ollama-cloud",
  "codex-sdk",
  "codex-cli",
] as const;

// ---------------------------------------------------------------------------
// Runtime state (in-memory; §52)
// ---------------------------------------------------------------------------

const states = new Map<AiProviderId, ProviderRuntimeState>();

function ensureState(id: AiProviderId): ProviderRuntimeState {
  let s = states.get(id);
  if (!s) {
    s = {
      status: "UNCONFIGURED",
      rateLimitedUntil: undefined,
      failures: 0,
      activeRequests: 0,
      lastErrorAt: undefined,
    };
    states.set(id, s);
  }
  return s;
}

export function getRuntimeState(id: AiProviderId): ProviderRuntimeState {
  return ensureState(id);
}

/**
 * Update the runtime state for a provider, called by the router after
 * each attempt. The router is the single writer.
 */
export function updateRuntimeState(
  id: AiProviderId,
  patch: Partial<ProviderRuntimeState>,
): void {
  const s = ensureState(id);
  Object.assign(s, patch);
}

// ---------------------------------------------------------------------------
// Health snapshot — combines: provider.health(), rate-limit, breaker, state
// ---------------------------------------------------------------------------

/**
 * Map the various status sources into a single AiProviderHealthStatus the
 * router consults. The router treats only "HEALTHY" as eligible.
 */
export function deriveHealthStatus(
  id: AiProviderId,
  providerHealth: AiProviderHealth,
): AiProviderHealthStatus {
  // Provider's own verdict wins for UNCONFIGURED/UNAVAILABLE.
  if (providerHealth.status === "UNCONFIGURED") return "UNCONFIGURED";
  if (isInCooldown(id)) return "RATE_LIMITED";
  if (isOpen(id)) return "CIRCUIT_OPEN";
  if (providerHealth.status === "UNAVAILABLE") return "UNAVAILABLE";
  return "HEALTHY";
}

/**
 * Snapshot of every provider's derived health + capability flags + config
 * notes (secrets stripped). Used by /api/health (Task 4 will wire this in).
 */
export async function healthSnapshot(): Promise<
  Record<
    AiProviderId,
    {
      status: AiProviderHealthStatus;
      detail?: string;
      lastCheckedAt?: number;
    }
  >
> {
  const cfg = describeProviderConfig();
  const out = {} as Record<
    AiProviderId,
    { status: AiProviderHealthStatus; detail?: string; lastCheckedAt?: number }
  >;
  for (const id of ALL_PROVIDER_IDS) {
    const provider = getInstance(id);
    if (!provider) {
      out[id] = {
        status: "UNCONFIGURED",
        detail: cfg[id].detail,
      };
      continue;
    }
    const providerHealth = await provider.health();
    out[id] = {
      status: deriveHealthStatus(id, providerHealth),
      detail: providerHealth.detail ?? cfg[id].detail,
      lastCheckedAt: providerHealth.lastCheckedAt ?? Date.now(),
    };
  }
  return out;
}

/**
 * Quick synchronous check the router uses to decide whether to even call a
 * provider. The full `health()` call is async (and may touch the provider
 * network); the router needs a cheap pre-check.
 *
 * IMPORTANT: this is a HEURISTIC. It only checks the in-memory state we
 * already have. A provider that has never been called will return HEALTHY
 * here, but its first actual call may return UNAVAILABLE (e.g. codex-sdk
 * without @openai/codex-sdk installed). The router handles this by
 * recording the failure and falling through per §49.
 */
export function quickStatus(id: AiProviderId): ProviderRuntimeStatus {
  // If a provider has no instance, it's unconfigured.
  const provider = getInstance(id);
  if (!provider) return "UNCONFIGURED";

  // Quick reject for codex variants if the sync probe said "not available".
  // This avoids the round-trip of calling generateStructured just to get
  // UNAVAILABLE.
  if (id === "codex-sdk" && !CODEX_SDK_CONFIG.sdkInstalled) {
    return "UNAVAILABLE";
  }
  if (id === "codex-cli" && !CODEX_CLI_CONFIG.binaryAvailable) {
    return "UNAVAILABLE";
  }

  const s = ensureState(id);
  if (isInCooldown(id)) return "RATE_LIMITED";
  if (isOpen(id)) return "CIRCUIT_OPEN";
  // Default to HEALTHY if we have an instance and no negative signal.
  if (s.status === "UNCONFIGURED") return "HEALTHY";
  return s.status;
}

/**
 * Update the registry's view of a provider after a call.
 * Called by the router after every provider attempt.
 */
export function recordAttempt(
  id: AiProviderId,
  outcome: AiProviderHealthStatus | ProviderRuntimeStatus,
): void {
  const s = ensureState(id);
  switch (outcome) {
    case "HEALTHY":
      s.status = "HEALTHY";
      s.failures = 0;
      s.lastErrorAt = undefined;
      break;
    case "RATE_LIMITED":
      s.status = "RATE_LIMITED";
      s.rateLimitedUntil = Date.now() + 4_000;
      s.lastErrorAt = Date.now();
      break;
    case "CIRCUIT_OPEN":
      s.status = "CIRCUIT_OPEN";
      s.lastErrorAt = Date.now();
      break;
    case "UNAVAILABLE":
      s.status = "UNAVAILABLE";
      s.failures += 1;
      s.lastErrorAt = Date.now();
      break;
    case "UNCONFIGURED":
      s.status = "UNCONFIGURED";
      break;
    default:
      s.status = "DEGRADED";
  }
}

/** Test-only. */
export function resetRegistry(): void {
  providers.clear();
  states.clear();
  resetRateLimits();
  resetBreakers();
}
