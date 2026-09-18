// src/lib/legal-strategy/index.ts
// Phase 7 — Legal Strategy Engine Foundation — public re-exports.
//
// Master prompt PART G §16–§41. The Strategy Engine builds a structured map
// of legally supportable procedural actions for each legal issue in a case.
//
// CRITICAL CORRECTNESS RULES enforced throughout (see types.ts for the full
// verbatim list):
//   §17 — informs; does NOT choose for the user.
//   §18 — no win probability / outcome prediction.
//   §21 — no LLM-invented action type.
//   §23 — never invent deadline; conditional analysis when disputed.
//   §25 — do not fabricate missing evidence.
//   §28 — must surface available counter-authority.
//   §29 — do not convert limitation into outcome prediction.
//   §30 — describe what action seeks procedurally, not whether it will win.
//   §32 — no ranking / magic score.
//   §36 — deterministic layers work without Codex.
//   §37 — every candidate must pass the 9 verifier checks.
//   §38 — no calculated deadline without verified trigger + rule + calc.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  ActionAvailabilityStatus,
  ActionSpec,
  ActionType,
  ActionVerificationStatus,
  AppealHistoryEntry,
  AuthorityVerificationResult,
  DeadlineCalc,
  DeadlineVerificationResult,
  EvidenceGap,
  EvidenceGapSeverity,
  LegalActionCandidate,
  NegativeTestResult,
  Prerequisite,
  PrerequisiteStatus,
  ProceduralPosture,
  StrategyGoldFixture,
  StrategyIssueEntry,
  StrategyMap,
  StrategyMetrics,
  StrategyVerificationResult,
  TemporalStatus,
  VerificationCheck,
} from "./types";

export {
  ACTION_TYPES,
  ZERO_STRATEGY_METRICS,
} from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export {
  CLOSED_EVIDENCE_STRATEGY_SYSTEM_INSTRUCTION,
  CODEX_STRATEGY_MAX_TOKENS,
  CODEX_STRATEGY_TIMEOUT_MS,
  FORBIDDEN_RANKING_PHRASES,
  STRATEGY_MAX_ACTIONS_PER_ISSUE,
  STRATEGY_MAX_AUTHORITIES_PER_ISSUE,
  STRATEGY_MAX_CHRONOLOGY,
  STRATEGY_MAX_CONTEXT_CHARS,
  STRATEGY_MAX_COUNTER_AUTHORITIES,
  STRATEGY_MAX_EVIDENCE_REFS,
  STRATEGY_MAX_FACTS_IN_CONTEXT,
  STRATEGY_MAX_ISSUES,
} from "./config";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export {
  buildCaseState,
  emptyCaseState,
  type CaseState,
  type ParsedIssueLink,
} from "./state/case-state";
export {
  buildProceduralPosture,
  emptyPosture,
  extractChallengedAct,
  inferStageFromEvents,
} from "./state/procedural-posture";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export {
  ACTION_REGISTRY,
  getActionSpec,
  getActionsForStage,
  isRegisteredActionType,
  mapActionToDraftType,
} from "./actions/registry";
export {
  generateActionCandidates,
  generateStableCandidateId,
} from "./actions/candidate-generator";
export {
  evaluatePrerequisites,
  type PrerequisiteClassification,
} from "./actions/prerequisites";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export {
  analyzeEvidenceGaps,
  type EvidenceGapAnalysisResult,
} from "./evidence/gap-analysis";
export {
  linkEvidenceToRequirements,
  type RequirementLinkResult,
} from "./evidence/requirement-linker";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export {
  addDays,
  addMonths,
  calculateDeadline,
  checkTemporalStatus,
  parseDuration,
} from "./timing/deadline-model";
export { checkTemporalStatus as checkTemporalStatusStandalone } from "./timing/temporal-check";

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

export { findSupportingAuthorities } from "./authority/strategy-authority";
export { findCounterAuthorities } from "./authority/counter-authorities";

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export { analyzeAction } from "./analysis/action-analysis";
export { analyzeLimitations } from "./analysis/limitation-analysis";
export { describeProceduralEffect } from "./analysis/procedural-effect";
export { buildStrategyMap } from "./analysis/strategy-map";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export { verifyActionCandidate } from "./verification/strategy-verifier";
export { verifyDeadline } from "./verification/deadline-verifier";
export { verifyAuthorities } from "./verification/authority-verifier";

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export { STRATEGY_GOLD_FIXTURES } from "./evaluation/strategy-gold-set";
export { evaluateStrategy } from "./evaluation/evaluator";
export { runStrategyNegativeTests } from "./evaluation/negative-tests";
