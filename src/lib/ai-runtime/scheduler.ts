// src/lib/ai-runtime/scheduler.ts
// Attempt budget + deadline tracking (§57).
//
// The scheduler is consulted by the router to decide:
//   - whether to start a call at all (deadline not yet exceeded)
//   - whether to skip a particular provider (remaining time < providerMinTime)
//   - whether to stop after maxAttempts providers have been tried

import { SCHEDULER_CONFIG } from "./config";
import type { AiProviderId, AiTaskType } from "./types";

export interface SchedulePlan {
  /** Ordered list of providers to try (already filtered + limited). */
  providers: AiProviderId[];
  /** Effective deadline (epoch ms). */
  deadlineAt: number;
  /** Whether the deadline has already been exceeded before any call. */
  expiredBeforeStart: boolean;
}

/**
 * Build the plan: take the routing-policy ordered list, cap at
 * maxAttempts, and report the effective deadline.
 */
export function planSchedule(
  task: AiTaskType,
  orderedProviders: readonly AiProviderId[],
  deadlineAt: number | undefined,
): SchedulePlan {
  const now = Date.now();
  const effectiveDeadline =
    deadlineAt ?? now + SCHEDULER_CONFIG.defaultDeadlineMs;
  const expired = now > effectiveDeadline;

  // Cap at maxAttempts. (Router will still filter each by health state.)
  const providers = orderedProviders.slice(0, SCHEDULER_CONFIG.maxAttempts);

  return {
    providers,
    deadlineAt: effectiveDeadline,
    expiredBeforeStart: expired,
  };
}

/**
 * Should this provider be skipped because remaining time is too short?
 * §57 — never start a call we cannot afford to let finish.
 */
export function shouldSkipForDeadline(
  deadlineAt: number,
  providerMinTimeMs: number = SCHEDULER_CONFIG.providerMinTimeMs,
  now: number = Date.now(),
): { skip: boolean; remainingMs: number } {
  const remainingMs = Math.max(0, deadlineAt - now);
  return {
    skip: remainingMs < providerMinTimeMs,
    remainingMs,
  };
}

/**
 * Compute the effective timeout for a single provider call:
 * min(provider default timeout, remaining-to-deadline, request timeout).
 *
 * Never returns less than 1000ms (provider may still return UNAVAILABLE
 * quickly if it cannot satisfy this).
 */
export function effectiveTimeoutMs(
  requestTimeoutMs: number | undefined,
  providerDefaultTimeoutMs: number,
  deadlineAt: number,
  now: number = Date.now(),
): number {
  const remainingMs = Math.max(0, deadlineAt - now);
  return Math.max(
    1_000,
    Math.min(
      providerDefaultTimeoutMs,
      remainingMs,
      requestTimeoutMs ?? Number.POSITIVE_INFINITY,
    ),
  );
}
