// src/lib/ai-runtime/registry.ts
// Provider registry: instantiates each provider lazily, exposes getInstance(),
// tracks ProviderRuntimeState, and offers a health snapshot.
//
// The registry is process-singleton. Tests can `resetRegistry()` between
// cases.

import { spawnSync } from "node:child_process";
import path from "node:path";
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
 * §9 — Codex CLI detection (Phase 4.1 Finalization).
 * Check in this order:
 *   1. explicitly configured CODEX_CLI_PATH
 *   2. project-local binary at node_modules/.bin/codex
 *   3. PATH resolution (just "codex")
 * Never use shell interpolation. Use spawnSync with argument arrays.
 *
 * Failures are silent — the binary is treated as unavailable, which surfaces
 * honestly as UNAVAILABLE in health. Called once at module load.
 *
 * NOTE: this only checks binary existence, NOT ChatGPT auth state. The
 * CodexCliProvider.health() method does the auth check separately (via
 * `codex login status`) so /api/health can distinguish HEALTHY vs
 * AUTH_REQUIRED vs RATE_LIMITED (§10, §11, §36).
 */
function probeCodexCliAvailability(): boolean {
  if (!CODEX_CLI_CONFIG.enabled) return false;
  const candidates: string[] = [];
  if (CODEX_CLI_CONFIG.cliPath) candidates.push(CODEX_CLI_CONFIG.cliPath);
  // Project-local binary installed via `bun add @openai/codex-sdk`
  // (auto-installs @openai/codex which provides the `codex` bin).
  try {
    candidates.push(pathResolve("node_modules/.bin/codex"));
  } catch {
    // process.cwd() unavailable in some edge environments — skip.
  }
  candidates.push("codex"); // PATH resolution (last resort)

  for (const candidate of candidates) {
    try {
      const r = spawnSync(candidate, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        timeout: 3_000,
      });
      if (r.status === 0) {
        // Remember which candidate worked so the provider doesn't have to
        // re-probe. We store it on the config object's `cliPath` field if it
        // was empty (operator didn't override).
        if (!CODEX_CLI_CONFIG.cliPath) {
          (CODEX_CLI_CONFIG as { cliPath: string }).cliPath = candidate;
        }
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

// Local helper — kept simple now that `node:path` is imported at module top.
function pathResolve(relative: string): string {
  return path.resolve(process.cwd(), relative);
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
 *
 * §11 — Phase 4.1 Finalization: AUTH_REQUIRED is a distinct state from
 * UNCONFIGURED / UNAVAILABLE / RATE_LIMITED. It means "binary installed but
 * ChatGPT not signed in" — the user must run `codex login` manually.
 */
export function deriveHealthStatus(
  id: AiProviderId,
  providerHealth: AiProviderHealth,
): AiProviderHealthStatus {
  // Provider's own verdict wins for UNCONFIGURED/UNAVAILABLE/AUTH_REQUIRED.
  if (providerHealth.status === "UNCONFIGURED") return "UNCONFIGURED";
  if (providerHealth.status === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (isInCooldown(id)) return "RATE_LIMITED";
  if (isOpen(id)) return "CIRCUIT_OPEN";
  if (providerHealth.status === "UNAVAILABLE") return "UNAVAILABLE";
  if (providerHealth.status === "RATE_LIMITED") return "RATE_LIMITED";
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
    case "AUTH_REQUIRED":
      // §11 — Codex CLI installed but ChatGPT not signed in. NOT a failure
      // (don't increment `failures` — that would trip the circuit breaker
      // for what is really a user-action-required state, not a provider bug).
      s.status = "AUTH_REQUIRED";
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
