// src/lib/legal-strategy/config.ts
// Phase 7 — Legal Strategy Engine — runtime configuration.
//
// Per §35: "Bounded context — never send 10,000 pages." The strategy engine
// receives a BOUNDED slice of the Case Workspace, never the whole case.
//
// Per §36: "Codex CLI + ChatGPT may be PRIMARY for multi-action synthesis...
// Deterministic action registry/prerequisite/deadline/evidence-gap layers
// must work without Codex." The closed-evidence system instruction handed
// to Codex mirrors Phase 6's wording so the same closed-evidence discipline
// applies when Codex is invoked for multi-action synthesis.

// ---------------------------------------------------------------------------
// §35 — Bounded context limits
// ---------------------------------------------------------------------------

/** Max facts included in the strategy context (priority: VERIFIED > DISPUTED
 *  > ALLEGED, then HIGH materiality first). */
export const STRATEGY_MAX_FACTS_IN_CONTEXT = 25;

/** Max chronology events included in the strategy context. */
export const STRATEGY_MAX_CHRONOLOGY = 15;

/** Max evidence refs handed to the strategy engine (refs only, not full text). */
export const STRATEGY_MAX_EVIDENCE_REFS = 25;

/** Max legal-authority entries (laws + precedents) per issue. */
export const STRATEGY_MAX_AUTHORITIES_PER_ISSUE = 8;

/** Max counter-authority entries surfaced per action (§28 — must show adverse
 *  authority, but bounded to avoid flooding the user). */
export const STRATEGY_MAX_COUNTER_AUTHORITIES = 5;

/** Max actions generated per issue (the registry is exhaustive but the
 *  generator filters by stage — typical per-issue counts: 2-4). */
export const STRATEGY_MAX_ACTIONS_PER_ISSUE = 6;

/** Hard character cap on the serialized strategy context. */
export const STRATEGY_MAX_CONTEXT_CHARS = 40_000;

/** Max number of issues processed in a single strategy-map build. */
export const STRATEGY_MAX_ISSUES = 12;

// ---------------------------------------------------------------------------
// §36 — Closed-evidence system instruction (verbatim, mirrors Phase 6 §15)
// ---------------------------------------------------------------------------

/**
 * The closed-evidence system instruction handed to Codex when it is invoked
 * for multi-action synthesis. The wording mirrors Phase 6's
 * CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION so the same closed-evidence
 * discipline applies: only supplied facts, evidence, authorities, and the
 * deterministic action registry. Never invent an action, deadline,
 * authority, or prerequisite.
 *
 * Per §36: "Codex CLI + ChatGPT may be PRIMARY for multi-action synthesis
 * (e.g. 'given this procedural posture, suggest the supportable procedural
 * actions that fit'). Deterministic action registry / prerequisite /
 * deadline / evidence-gap layers must work without Codex."
 *
 * Per §17: even Codex output MUST NOT contain "you should file X", "best
 * option", "winner", or outcome prediction. Codex's role is to organize the
 * deterministic layers' output, not to choose for the user.
 */
export const CLOSED_EVIDENCE_STRATEGY_SYSTEM_INSTRUCTION = `You are organizing a CLOSED VERIFIED LEGAL RECORD into a structured strategy map. Use only the supplied case facts, evidence, authorities, procedural posture, and the deterministic action registry. Do not invent action types, deadlines, prerequisites, authorities, quotations, procedural history, or remedies. Every action MUST come from the supplied action registry. Every prerequisite MUST link to a supplied fact, evidence, authority, or procedural event. Every deadline MUST reference a verified trigger event + verified legal rule + calculation method; if any of the three is missing, mark the deadline UNKNOWN. If counter-authority is available for an action, surface it. If a prerequisite cannot be traced, mark it UNKNOWN rather than satisfied. Do not output "you should file X", "best option", "winner", "guaranteed success", "90% chance", or any other ranking or outcome prediction. The strategy engine informs the user; it does not choose legal action for them.`;

// ---------------------------------------------------------------------------
// §36 — Codex strategy synthesis routing
// ---------------------------------------------------------------------------

/** Timeout (ms) for the Codex CLI strategy-synthesis call. */
export const CODEX_STRATEGY_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_STRATEGY_TIMEOUT_MS ?? "120000",
  10,
);

/** Max tokens hint for the Codex CLI strategy-synthesis call. */
export const CODEX_STRATEGY_MAX_TOKENS = Number.parseInt(
  process.env.CODEX_STRATEGY_MAX_TOKENS ?? "8000",
  10,
);

// ---------------------------------------------------------------------------
// §40 — Forbidden ranking / outcome-prediction phrases
// ---------------------------------------------------------------------------

/**
 * Phrases that — if they appear in any strategy output — would constitute a
 * §17/§18/§32 violation (ranking / outcome prediction / choosing for the
 * user). The evaluator scans every candidate's text fields for these and
 * fails the silentRankingRate metric if any appear.
 */
export const FORBIDDEN_RANKING_PHRASES: string[] = [
  "best option",
  "worst option",
  "you should definitely file",
  "you should file",
  "we recommend filing",
  "i recommend filing",
  "guaranteed success",
  "90% chance",
  "80% chance",
  "win probability",
  "judge will likely",
  "predicted outcome",
  "winner",
  "ranked best to worst",
  "top pick",
  "your best choice",
  "the strongest action",
  "highest chance of success",
  "most likely to succeed",
];
