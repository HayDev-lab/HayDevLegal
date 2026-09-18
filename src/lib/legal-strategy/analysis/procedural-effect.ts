// src/lib/legal-strategy/analysis/procedural-effect.ts
// Phase 7 — §30 — Describe what an action seeks procedurally, NOT whether
// it will win.
//
// CRITICAL — §30: "Describe what action seeks procedurally, not whether it
// will win." The procedural effect comes straight from the ACTION_REGISTRY
// spec — the engine NEVER generates outcome-prediction language.

import type { ActionType } from "../types";
import { getActionSpec } from "../actions/registry";

/**
 * Return the procedural effect description for an action type. The
 * description is sourced verbatim from the ACTION_REGISTRY — no LLM, no
 * outcome prediction.
 *
 * @param actionType the action type from the registry
 * @returns the procedural-effect description (what the action seeks
 *          procedurally)
 */
export function describeProceduralEffect(actionType: ActionType): string {
  const spec = getActionSpec(actionType);
  return spec.proceduralEffect;
}
