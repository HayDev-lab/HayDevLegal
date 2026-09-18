// src/app/api/health/route.ts
// Health / status endpoint for the federated legal search service — v3
// (Phase 4.1 §69-§72). Adds:
//   - `phase: "4.1"` (was "3 — full-document resolution")
//   - `architecture: "live-federated-legal-research"`
//   - `aiProviders` — per-provider health snapshot from the unified AiRuntime
//     (cached for 30s — §70 says don't run expensive generation on every GET)
//   - `aiRuntime` — runtime metrics summary (per-provider request count,
//     p95 latency, active requests)
//   - `research` — Phase 4.1 research stages + deterministic-always-runs flag
//   - `security` — Phase 4.1 security posture (SSRF redirect loop, DNS
//     revalidation, QA-endpoint guard, rate limit, Datalex session isolation)
// Preserved from v2: `sources`, `interactiveResolve`, `sessionStore`.

import { NextResponse } from "next/server";
import { allAdapters } from "@/lib/legal-search/sources/source-registry";
import { healthSnapshot } from "@/lib/legal-search/engine/source-health";
import { sessionDiagnostics } from "@/lib/legal-search/sources/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// §70 — cache the AI runtime health snapshot for 30 seconds so we don't
// run expensive generation on every GET.
// ---------------------------------------------------------------------------

type CachedHealth = {
  fetchedAt: number;
  providers: Record<string, ReturnType<typeof shapeProviderHealth>>;
  metrics: Record<string, { requests?: number; p95LatencyMs?: number; activeRequests?: number; p50?: number; p95?: number }>;
  activeRequests: number;
};

let cachedHealth: CachedHealth = {
  fetchedAt: 0,
  providers: {},
  metrics: {},
  activeRequests: 0,
};
const HEALTH_TTL_MS = 30_000;

async function getAiRuntimeHealth(): Promise<CachedHealth> {
  const now = Date.now();
  if (now - cachedHealth.fetchedAt < HEALTH_TTL_MS && cachedHealth.fetchedAt > 0) {
    return cachedHealth;
  }
  let fresh: CachedHealth;
  try {
    const { getAiRuntime } = await import("@/lib/ai-runtime");
    const runtime = getAiRuntime();
    if (typeof runtime.health !== "function") {
      fresh = { fetchedAt: now, providers: {}, metrics: {}, activeRequests: 0 };
      cachedHealth = fresh;
      return fresh;
    }
    const health = await runtime.health();
    const metrics = typeof runtime.metrics === "function" ? runtime.metrics() : {};
    const providers: Record<string, ReturnType<typeof shapeProviderHealth>> = {};
    for (const [id, v] of Object.entries(health ?? {})) {
      providers[id] = shapeProviderHealth(v);
    }
    const metricsOut: CachedHealth["metrics"] = {};
    let activeRequests = 0;
    for (const [id, m] of Object.entries(metrics ?? {})) {
      const mm = (m ?? {}) as { requests?: number; p95?: number; p50?: number; activeRequests?: number; inFlight?: number };
      metricsOut[id] = {
        requests: typeof mm.requests === "number" ? mm.requests : undefined,
        p95LatencyMs: typeof mm.p95 === "number" ? mm.p95 : undefined,
        p50: typeof mm.p50 === "number" ? mm.p50 : undefined,
        p95: typeof mm.p95 === "number" ? mm.p95 : undefined,
        activeRequests: typeof mm.activeRequests === "number" ? mm.activeRequests : typeof mm.inFlight === "number" ? mm.inFlight : undefined,
      };
      if (typeof mm.activeRequests === "number") activeRequests += mm.activeRequests;
      else if (typeof mm.inFlight === "number") activeRequests += mm.inFlight;
    }
    fresh = { fetchedAt: now, providers, metrics: metricsOut, activeRequests };
    cachedHealth = fresh;
    return fresh;
  } catch (err) {
    // Runtime not yet built (Task 2 in progress) — fail open.
    console.warn(
      "[/api/health] ai-runtime health unavailable:",
      err instanceof Error ? err.message : err,
    );
    fresh = { fetchedAt: now, providers: {}, metrics: {}, activeRequests: 0 };
    cachedHealth = fresh;
    return fresh;
  }
}

// The 3 logical provider ids the runtime tracks (Phase 4.1 Provider
// Finalization §28–§29). Codex appears as ONE logical provider with a
// `transport` field (sdk | cli | unavailable) reflecting which underlying
// transport is currently healthy.
const EXPECTED_PROVIDERS = [
  "zai",
  "ollama-cloud",
  "codex-sdk",
  "codex-cli",
] as const;

function shapeProviderHealth(raw: unknown): {
  status: string;
  capabilities?: unknown;
  lastCheckedAt?: string;
  detail?: string;
} {
  if (!raw || typeof raw !== "object") {
    return { status: "unknown" };
  }
  const r = raw as {
    status?: string;
    capabilities?: unknown;
    lastCheckedAt?: number | string;
    detail?: string;
  };
  return {
    status: typeof r.status === "string" ? r.status : "unknown",
    capabilities: r.capabilities,
    lastCheckedAt:
      typeof r.lastCheckedAt === "number"
        ? new Date(r.lastCheckedAt).toISOString()
        : typeof r.lastCheckedAt === "string"
          ? r.lastCheckedAt
          : undefined,
    detail: r.detail,
  };
}

export async function GET() {
  const health = healthSnapshot();
  const adapters = allAdapters().map((a) => ({
    id: a.id,
    name: a.name,
    authority: a.authority,
    type: a.sourceType,
    canFetchDocuments: typeof a.fetchDocument === "function",
    searchHealth: health[`${a.id} search`]?.state ?? "UNKNOWN",
    documentHealth: health[`${a.id} document`]?.state ?? "UNKNOWN",
    documentHealthDetail: health[`${a.id} document`]?.detail,
  }));

  const aiHealth = await getAiRuntimeHealth();
  const rawProviders = aiHealth.providers ?? {};

  // Build the aiProviders object covering all expected ids, even when the
  // runtime hasn't reported on them yet.
  const aiProviders: Record<string, ReturnType<typeof shapeProviderHealth>> = {};
  for (const id of EXPECTED_PROVIDERS) {
    aiProviders[id] = rawProviders[id] ?? shapeProviderHealth(undefined);
  }
  // Also surface any providers the runtime reported that we didn't enumerate
  // (forward-compat with new provider ids).
  for (const [id, v] of Object.entries(rawProviders)) {
    if (!(id in aiProviders)) {
      aiProviders[id] = v;
    }
  }

  // §28–§29, §36 — collapse codex-sdk + codex-cli into ONE logical `codex`
  // provider with a `transport` field showing which underlying transport is
  // currently healthy. Per Phase 4.1 Finalization §7: codex-cli (ChatGPT
  // account auth) is PRIMARY; codex-sdk (API-key) is OPTIONAL fallback.
  // transport values: "cli-chatgpt" | "sdk-api" | "unavailable"
  // codex status can include AUTH_REQUIRED (CLI installed but ChatGPT not signed in).
  const codexSdkHealth = aiProviders["codex-sdk"] ?? shapeProviderHealth(undefined);
  const codexCliHealth = aiProviders["codex-cli"] ?? shapeProviderHealth(undefined);
  let codexTransport: "cli-chatgpt" | "sdk-api" | "unavailable" = "unavailable";
  let codexStatus = "UNAVAILABLE";
  let codexDetail: string | undefined = undefined;
  // §7 — CLI is primary. Check CLI first.
  if (codexCliHealth.status === "HEALTHY") {
    codexTransport = "cli-chatgpt";
    codexStatus = "HEALTHY";
    codexDetail = codexCliHealth.detail ?? "codex-cli via ChatGPT account (primary transport)";
  } else if (codexCliHealth.status === "AUTH_REQUIRED") {
    // §11 — CLI installed but ChatGPT not signed in. Distinct from RATE_LIMITED
    // (signed in but quota exhausted) and UNAVAILABLE (binary missing).
    codexTransport = "cli-chatgpt";
    codexStatus = "AUTH_REQUIRED";
    codexDetail = codexCliHealth.detail ?? "Codex CLI installed; ChatGPT sign-in required.";
  } else if (codexCliHealth.status === "RATE_LIMITED") {
    // §12, §13 — signed in but ChatGPT plan Codex allowance exhausted.
    // Distinct from AUTH_REQUIRED — do NOT silently switch to API-key billing (§41).
    codexTransport = "cli-chatgpt";
    codexStatus = "RATE_LIMITED";
    codexDetail = codexCliHealth.detail ?? "Codex CLI ChatGPT allowance exhausted; will retry after cooldown.";
  } else if (codexSdkHealth.status === "HEALTHY") {
    // §14 — optional API-key path. Only marked HEALTHY when CODEX_SDK_ENABLED=true
    // AND api key is set AND sdk is installed. Never silently enabled (§41).
    codexTransport = "sdk-api";
    codexStatus = "HEALTHY";
    codexDetail = codexSdkHealth.detail ?? "codex-sdk via API key (optional transport)";
  } else {
    // Neither transport is healthy — surface the most informative reason.
    const reasons: string[] = [];
    if (codexCliHealth.detail) reasons.push(`cli: ${codexCliHealth.detail}`);
    if (codexSdkHealth.detail) reasons.push(`sdk: ${codexSdkHealth.detail}`);
    codexDetail = reasons.length > 0 ? reasons.join(" | ") : undefined;
    codexStatus =
      codexCliHealth.status === "UNCONFIGURED" && codexSdkHealth.status === "UNCONFIGURED"
        ? "UNCONFIGURED"
        : codexCliHealth.status === "AUTH_REQUIRED" || codexSdkHealth.status === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : codexCliHealth.status === "RATE_LIMITED" || codexSdkHealth.status === "RATE_LIMITED"
            ? "RATE_LIMITED"
            : "UNAVAILABLE";
  }
  const logicalAiProviders: Record<string, unknown> = {
    zai: aiProviders["zai"],
    "ollama-cloud": aiProviders["ollama-cloud"],
    codex: {
      status: codexStatus,
      transport: codexTransport,
      detail: codexDetail,
      lastCheckedAt:
        codexTransport === "cli-chatgpt"
          ? codexCliHealth.lastCheckedAt
          : codexTransport === "sdk-api"
            ? codexSdkHealth.lastCheckedAt
            : codexCliHealth.lastCheckedAt ?? codexSdkHealth.lastCheckedAt,
    },
  };

  return NextResponse.json({
    status: "ok",
    service: "armenian-legal-search",
    architecture: "live-federated-legal-research",
    phase: "4.1 — production hardening + multi-provider AiRuntime + codex case analysis",
    ts: new Date().toISOString(),
    components: {
      arlis: "configured",
      ai: "configured (AiRuntime federated: zai / ollama-cloud / codex [sdk+cli])",
      datalex: "configured (search public · document captcha-gated with interactive resume)",
      constitutionalCourt: "configured",
      judiciary: "configured (cassation precedents via Datalex + exact case lookup)",
      hudoc: "configured (native API cloudflare-gated · official-domain web discovery active)",
      web: "configured",
      localLaws: "configured",
      documentResolver: "configured (universal 2.0 ladder + identity verification)",
      sessionStore: sessionDiagnostics(),
    },
    sources: adapters,
    interactiveResolve: {
      bootstrap: "GET /api/resolve?doc=<source>:<externalId>",
      captcha: "GET /api/resolve/captcha?token=...",
      resume: "POST /api/resolve { token, captchaText, query }",
    },
    // §69 — AI provider matrix. 3 LOGICAL providers per §28–§29:
    // zai, ollama-cloud, codex (with `transport: sdk|cli|unavailable` field
    // reflecting which underlying Codex transport is currently healthy).
    // Cached 30s so we don't run expensive generation on every GET (§70).
    aiProviders: logicalAiProviders,
    // §70 — runtime metrics summary.
    aiRuntime: {
      metrics: {
        perProvider: aiHealth.metrics,
        activeRequests: aiHealth.activeRequests,
      },
      cached: aiHealth.fetchedAt > 0,
      cacheTtlMs: HEALTH_TTL_MS,
    },
    // §69 — research capabilities (Phase 4.1 stages).
    research: {
      phase: "4.1",
      stages: [
        "issue-map",
        "holding",
        "material-facts",
        "applicability",
        "distinguishing",
        "temporal",
        "hierarchy",
        "conflicts",
        "precedent-relations",
        "argument-map",
        "case-analysis",
      ],
      deterministicAlwaysRuns: true,
    },
    // §69 — security posture (Task 1 owns the implementation; this is a
    // declarative inventory for ops).
    security: {
      ssrfRedirectLoop: true,
      maxRedirects: 5,
      dnsRevalidationPerHop: true,
      qaEndpointsGuarded: true,
      rateLimit: true,
      datalexSessionIsolation: true,
    },
  });
}
