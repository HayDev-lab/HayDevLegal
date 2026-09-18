// src/lib/ai-runtime/router.ts
// Task → provider routing with SEQUENTIAL FALLBACK.
//
// §56: NEVER use Promise.any / Promise.race-all-providers. We try providers
// in routing-policy order, skipping those in cooldown / open-circuit /
// deadline-too-short, and stop at the first SUCCESS or SUCCESS_EMPTY.
//
// §49: default routing policy is in config.ts.

import type {
  AiProvider,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStageTraceEntry,
  AiStructuredRequest,
  AiTaskType,
  AiTextRequest,
} from "./types";
import { ROUTING_POLICY } from "./config";
import { getInstance, quickStatus, recordAttempt } from "./registry";
import { isInCooldown, triggerCooldown, clearCooldown } from "./rate-limit";
import {
  recordFailure as cbRecordFailure,
  recordSuccess as cbRecordSuccess,
  shouldAttempt as cbShouldAttempt,
} from "./circuit-breaker";
import {
  incActive,
  decActive,
  recordProviderCall,
} from "./metrics";
import { planSchedule, shouldSkipForDeadline } from "./scheduler";

/**
 * The router keeps its own stage-trace (§109) for the current call.
 * getAiRuntime() exposes this via `stageTrace()`.
 */
const stageTraceBuf: AiStageTraceEntry[] = [];

function pushTrace(entry: AiStageTraceEntry): void {
  stageTraceBuf.push(entry);
  if (stageTraceBuf.length > 256) stageTraceBuf.shift();
}

export function getStageTrace(): AiStageTraceEntry[] {
  return stageTraceBuf.slice();
}

export function resetStageTrace(): void {
  stageTraceBuf.length = 0;
}

/**
 * Decide whether a provider is currently eligible to be CALLED.
 * (As opposed to quickStatus which is a quick read of the registry —
 * this also consults the deadline.)
 */
function isEligible(
  id: AiProviderId,
  deadlineAt: number,
): { ok: true } | { ok: false; reason: string } {
  const status = quickStatus(id);
  if (status === "UNCONFIGURED") return { ok: false, reason: "UNCONFIGURED" };
  if (status === "RATE_LIMITED" || isInCooldown(id))
    return { ok: false, reason: "RATE_LIMITED" };
  if (status === "CIRCUIT_OPEN" || !cbShouldAttempt(id))
    return { ok: false, reason: "CIRCUIT_OPEN" };
  if (status === "UNAVAILABLE" || status === "DEGRADED")
    return { ok: false, reason: status };
  // Deadline check (§57).
  const skip = shouldSkipForDeadline(deadlineAt);
  if (skip.skip)
    return { ok: false, reason: `SKIPPED_DEADLINE(${skip.remainingMs}ms left)` };
  return { ok: true };
}

/**
 * After a provider attempt, record the outcome in the registry + breaker +
 * rate-limit + metrics. Returns the same AiResult so the caller can return
 * it directly.
 */
function recordOutcome<T>(
  id: AiProviderId,
  result: AiResult<T>,
  task: AiTaskType,
): AiResult<T> {
  switch (result.status) {
    case "SUCCESS":
    case "SUCCESS_EMPTY":
      recordAttempt(id, "HEALTHY");
      cbRecordSuccess(id);
      clearCooldown(id);
      recordProviderCall(
        id,
        result.status,
        // SUCCESS_EMPTY still has latencyMs in the type; both variants do.
        (result as { latencyMs?: number }).latencyMs ?? 0,
      );
      break;
    case "RATE_LIMITED":
      recordAttempt(id, "RATE_LIMITED");
      triggerCooldown(id, result.retryAfterMs, result.retryAfterMs);
      recordProviderCall(id, "RATE_LIMITED", 0);
      break;
    case "TIMEOUT":
      recordAttempt(id, "UNAVAILABLE");
      cbRecordFailure(id);
      recordProviderCall(id, "TIMEOUT", 0);
      break;
    case "INVALID_SCHEMA":
      recordAttempt(id, "DEGRADED");
      cbRecordFailure(id);
      recordProviderCall(id, "INVALID_SCHEMA", 0);
      break;
    case "UNAVAILABLE":
    case "ERROR":
      recordAttempt(id, "UNAVAILABLE");
      cbRecordFailure(id);
      recordProviderCall(id, "ERROR", 0);
      break;
  }
  // Push trace entry.
  pushTrace({
    stage: task,
    provider: id,
    status: result.status,
    latencyMs:
      result.status === "SUCCESS" || result.status === "SUCCESS_EMPTY"
        ? (result as { latencyMs: number }).latencyMs
        : 0,
  });
  return result;
}

/**
 * Sequential fallback driver. Shared by `generateText` and
 * `generateStructured` so the routing logic is identical.
 */
async function route<T>(
  task: AiTaskType,
  ctxInput: AiRuntimeContext | undefined,
  call: (
    provider: AiProvider,
    ctx: AiRuntimeContext,
  ) => Promise<AiResult<T>>,
): Promise<AiResult<T>> {
  const ordered = ROUTING_POLICY[task];
  const ctx: AiRuntimeContext = ctxInput ?? {};
  const plan = planSchedule(task, ordered, ctx.deadlineAt);

  if (plan.expiredBeforeStart) {
    pushTrace({
      stage: task,
      provider: ordered[0],
      status: "TIMEOUT",
      latencyMs: 0,
      note: "deadline exceeded before any call",
    });
    return {
      status: "TIMEOUT",
      provider: ordered[0],
    };
  }

  let lastErrorResult: AiResult<T> | undefined;

  for (const id of plan.providers) {
    const eligible = isEligible(id, plan.deadlineAt);
    if (!eligible.ok) {
      pushTrace({
        stage: task,
        provider: id,
        status: "SKIPPED",
        latencyMs: 0,
        note: eligible.reason,
      });
      continue;
    }
    const provider = getInstance(id);
    if (!provider) {
      pushTrace({
        stage: task,
        provider: id,
        status: "UNCONFIGURED",
        latencyMs: 0,
      });
      continue;
    }

    incActive(id);
    const startedAt = Date.now();
    try {
      const result = await call(provider, {
        ...ctx,
        // Refresh deadlineAt on the context so the provider can honor it.
        deadlineAt: plan.deadlineAt,
      });
      recordOutcome(id, result, task);
      // §49 — stop at the first SUCCESS / SUCCESS_EMPTY.
      if (result.status === "SUCCESS" || result.status === "SUCCESS_EMPTY") {
        return result;
      }
      // All other statuses (RATE_LIMITED / TIMEOUT / UNAVAILABLE / ERROR /
      // INVALID_SCHEMA) → fall through to the next provider.
      lastErrorResult = result;
    } catch (err) {
      // Defensive: providers SHOULD catch their own errors and return AiResult.
      // If one throws, treat as ERROR and continue.
      const detail = err instanceof Error ? err.message : String(err);
      const latencyMs = Date.now() - startedAt;
      const result: AiResult<T> = {
        status: "ERROR",
        provider: id,
        detail,
      };
      pushTrace({
        stage: task,
        provider: id,
        status: "ERROR",
        latencyMs,
        note: detail,
      });
      recordAttempt(id, "UNAVAILABLE");
      cbRecordFailure(id);
      recordProviderCall(id, "ERROR", latencyMs);
      lastErrorResult = result;
    } finally {
      decActive(id);
    }
  }

  // All providers exhausted — return the last error result, or UNAVAILABLE.
  if (lastErrorResult) return lastErrorResult;
  return {
    status: "UNAVAILABLE",
    provider: ordered[0],
    detail: `no eligible provider for task ${task}`,
  };
}

export async function routeGenerateText(
  req: AiTextRequest,
  task: AiTaskType,
  ctx?: AiRuntimeContext,
): Promise<AiResult<string>> {
  return route<string>(task, ctx, (provider, c) =>
    provider.generateText(req, c),
  );
}

export async function routeGenerateStructured<T>(
  req: AiStructuredRequest<T>,
  task: AiTaskType,
  ctx?: AiRuntimeContext,
): Promise<AiResult<T>> {
  return route<T>(task, ctx, (provider, c) =>
    provider.generateStructured(req, c),
  );
}

/** Allow tests / external code to inspect the routing decision logic. */
export function explainRoutingFor(
  task: AiTaskType,
  deadlineAt: number | undefined,
): Array<{ provider: AiProviderId; eligible: boolean; reason?: string }> {
  const ordered = ROUTING_POLICY[task];
  const plan = planSchedule(task, ordered, deadlineAt);
  return plan.providers.map((id) => {
    if (plan.expiredBeforeStart)
      return { provider: id, eligible: false, reason: "deadline exceeded" };
    const e = isEligible(id, plan.deadlineAt);
    return e.ok
      ? { provider: id, eligible: true }
      : { provider: id, eligible: false, reason: e.reason };
  });
}
