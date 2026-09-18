// src/lib/legal-strategy/types.ts
// Phase 7 — Legal Strategy Engine Foundation — public type surface.
//
// Master prompt PART G §16–§41. The Strategy Engine builds a structured map
// of legally supportable procedural actions for each legal issue in a case.
//
// CRITICAL CORRECTNESS RULES (verbatim from the master prompt):
//   §17 — "Strategy Engine informs the user; it does not choose legal action
//          for them." NO "you should file X", NO "best option", NO ranking,
//          NO winner, NO outcome prediction.
//   §18 — No win probability, judge prediction, guaranteed success, "90%".
//   §21 — "No LLM-invented action type." Every action type MUST exist in the
//          ACTION_REGISTRY.
//   §23 — "Never invent deadline. If notice/service date disputed, show
//          conditional analysis rather than silently choosing one."
//   §25 — "Do not fabricate missing evidence. Identify missing documents only
//          when actual prerequisite requires them."
//   §28 — "Serious action analysis must include available adverse/counter
//          authority."
//   §29 — "Do not convert limitation into outcome prediction."
//   §30 — "Describe what action seeks procedurally, not whether it will win."
//   §32 — "No 'best/worst' ranking or magic score."
//   §36 — "Codex CLI + ChatGPT may be PRIMARY for multi-action synthesis...
//          Deterministic action registry/prerequisite/deadline/evidence-gap
//          layers must work without Codex."
//   §37 — "Every action candidate must pass: action exists in registry,
//          stage compatible, prerequisites traceable, deadline traceable or
//          unknown, legal basis exists, authority IDs valid, case evidence
//          IDs valid, procedural effect supported, availability status
//          supported."
//   §38 — "No calculated deadline without verified trigger + rule +
//          calculation."
//
// Evidence-ref shape mirrors the Case Workspace's `EvidenceRef` (Phase 5 §6)
// so case-internal evidence links work uniformly without a second type.

import type {
  CaseFact,
  CaseEvidenceLink,
  ChronologyEvent,
  EvidenceRef,
  LegalIssueLink,
  LegalReferenceEntry,
} from "@/lib/case-workspace/types";

// Re-export the case-workspace types consumed by the strategy engine so
// callers can import everything from a single module.
export type {
  CaseFact,
  CaseEvidenceLink,
  ChronologyEvent,
  EvidenceRef,
  LegalIssueLink,
  LegalReferenceEntry,
};

// ---------------------------------------------------------------------------
// §16 — ActionType union (13 types — registry is exhaustive)
// ---------------------------------------------------------------------------

export type ActionType =
  | "MOTION"
  | "OBJECTION"
  | "APPEAL"
  | "CASSATION_APPEAL"
  | "CONSTITUTIONAL_COMPLAINT"
  | "ECHR_STEP"
  | "EVIDENCE_MOTION"
  | "EXCLUSION_ARGUMENT"
  | "RELEASE_MOTION"
  | "DEADLINE_RESTORATION_REQUEST"
  | "DAMAGES_CLAIM"
  | "ADMINISTRATIVE_CHALLENGE"
  | "OTHER";

/** Exhaustive list — used by the registry keys + verifier. */
export const ACTION_TYPES: ActionType[] = [
  "MOTION",
  "OBJECTION",
  "APPEAL",
  "CASSATION_APPEAL",
  "CONSTITUTIONAL_COMPLAINT",
  "ECHR_STEP",
  "EVIDENCE_MOTION",
  "EXCLUSION_ARGUMENT",
  "RELEASE_MOTION",
  "DEADLINE_RESTORATION_REQUEST",
  "DAMAGES_CLAIM",
  "ADMINISTRATIVE_CHALLENGE",
  "OTHER",
];

// ---------------------------------------------------------------------------
// §20 — Availability / verification / temporal / prerequisite statuses
// ---------------------------------------------------------------------------

export type ActionAvailabilityStatus =
  | "AVAILABLE_ON_CURRENT_RECORD"
  | "POTENTIALLY_AVAILABLE"
  | "BLOCKED_BY_MISSING_PREREQUISITE"
  | "TEMPORALLY_UNCERTAIN"
  | "NOT_AVAILABLE_ON_CURRENT_RECORD";

export type ActionVerificationStatus = "VERIFIED" | "PARTIAL" | "UNRESOLVED";

/** §23 — Temporal status of a calculated or verified deadline. */
export type TemporalStatus =
  | "VERIFIED"
  | "CALCULATED_FROM_VERIFIED_RULE"
  | "DISPUTED"
  | "UNKNOWN"
  | "EXPIRED"
  | "POTENTIALLY_EXPIRED";

/** §24 — Prerequisite classification. */
export type PrerequisiteStatus =
  | "SATISFIED"
  | "NOT_SATISFIED"
  | "UNKNOWN"
  | "DISPUTED";

/** §25 — Evidence gap severity. */
export type EvidenceGapSeverity = "CRITICAL" | "IMPORTANT" | "SUPPORTING";

// ---------------------------------------------------------------------------
// §24 — Prerequisite
// ---------------------------------------------------------------------------

/**
 * A prerequisite for a legal action. Each prerequisite MUST link to a fact,
 * evidence ref, legal rule, or procedural event from the verified Case
 * Workspace — never a free-floating claim.
 */
export interface Prerequisite {
  /** Stable id within the candidate (e.g. "PR-1"). */
  id: string;
  /** Human-readable description (Armenian or English). */
  description: string;
  status: PrerequisiteStatus;
  /** Linked CaseFact id (F-id space from Phase 5) — when the prerequisite
   *  is grounded in a verified case fact. */
  linkedFactId?: string;
  /** Linked case-internal EvidenceRef — when grounded in a document page. */
  linkedEvidenceRef?: EvidenceRef;
  /** Linked legal rule (article / statute name) — when grounded in law. */
  linkedLegalRule?: string;
  /** Linked ChronologyEvent id — when grounded in a procedural event. */
  linkedEventId?: string;
}

// ---------------------------------------------------------------------------
// §25 — EvidenceGap
// ---------------------------------------------------------------------------

/**
 * A missing-evidence item. Per §25: gaps are surfaced ONLY when an actual
 * prerequisite requires them. The engine NEVER fabricates "you should also
 * fetch document X" when no prerequisite demands X.
 */
export interface EvidenceGap {
  id: string;
  /** What the prerequisite requires (e.g. "postal delivery record"). */
  requirement: string;
  /** Why this evidence is needed (linked to the prerequisite). */
  whyNeeded: string;
  /** Existing case-internal evidence that partially addresses the gap. */
  existingEvidence: EvidenceRef[];
  /** What is missing — descriptive, not prescriptive. */
  missingEvidenceDescription: string;
  /** Candidate ids (within the strategy map) the gap affects. */
  affectedActions: string[];
  severity: EvidenceGapSeverity;
}

// ---------------------------------------------------------------------------
// §20 — LegalActionCandidate (parsed — JSON fields converted back to arrays/objects)
// ---------------------------------------------------------------------------

/**
 * The in-memory parsed form of the Prisma `LegalActionCandidate` row.
 * The persisted row stores arrays/objects as JSON-serialized Strings; this
 * interface surfaces them as proper TypeScript types.
 */
export interface LegalActionCandidate {
  id: string;
  caseId: string;
  actionType: ActionType;
  title: string;
  description?: string | null;
  proceduralStage?: string | null;
  /** Parsed from JSON — string[] of legal basis (article refs, statute names). */
  legalBasis: string[];
  /** Parsed from JSON — Prerequisite[]. */
  prerequisites: Prerequisite[];
  /** Parsed from JSON — string[] of satisfied prerequisite ids. */
  satisfiedPrerequisites: string[];
  /** Parsed from JSON — string[] of unsatisfied prerequisite ids. */
  unsatisfiedPrerequisites: string[];
  /** Parsed from JSON — string[] of unknown prerequisite ids. */
  unknownPrerequisites: string[];
  /** Parsed from JSON — string[] of supporting fact ids (F1, F2...). */
  supportingFacts: string[];
  /** Parsed from JSON — EvidenceRef[]. */
  supportingEvidence: EvidenceRef[];
  /** Parsed from JSON — EvidenceGap[]. */
  evidenceGaps: EvidenceGap[];
  /** Parsed from JSON — string[] of supporting authority ids (L1, C1, CC1, E1...). */
  supportingAuthorities: string[];
  /** Parsed from JSON — string[] of counter-authority ids. */
  counterAuthorities: string[];
  /** Parsed from JSON — string[] of distinguishing factors. */
  distinguishingFactors: string[];
  temporalStatus: TemporalStatus;
  /** Parsed from JSON — string[] of limitations (§29). */
  limitations: string[];
  proceduralEffect?: string | null;
  availabilityStatus: ActionAvailabilityStatus;
  verificationStatus: ActionVerificationStatus;
  /** §34 — maps to a Phase 6 DocumentType (MOTION→MOTION, etc.). */
  draftDocumentType?: string | null;
  /** Parsed from JSON — string[] of LegalIssueLink ids this action addresses. */
  relatedIssues: string[];
  /** §23 — deadline calculation (when one applies). Null when no deadline. */
  deadline?: DeadlineCalc | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// §22 — ProceduralPosture
// ---------------------------------------------------------------------------

/**
 * The procedural posture of a case: what kind of proceeding, in what court,
 * at what stage, what is being challenged, what has happened so far.
 *
 * Per §22: "Unknown remains unknown." Every field is nullable — the engine
 * NEVER fabricates a stage or court.
 */
export interface ProceduralPosture {
  caseId: string;
  caseType: string | null;
  court: string | null;
  jurisdiction: string | null;
  proceedingType: string | null;
  /** Current procedural stage (e.g. "first_instance", "appeal", "cassation",
   *  "execution"). Null when not identifiable from the record. */
  stage: string | null;
  /** The act being challenged (decision number, indictment, administrative
   *  act). Null when not identifiable. */
  challengedAct: string | null;
  /** Last verified procedural event from the chronology (with its date). */
  lastVerifiedEvent: {
    eventId: string;
    title: string;
    date: string | null;
    verification: string;
  } | null;
  /** Decisions available in the case record (chronology events of type
   *  DECISION with verification=DOCUMENT_VERIFIED). */
  availableDecisions: Array<{
    eventId: string;
    title: string;
    date: string | null;
  }>;
  /** Pending motions / filings not yet decided. */
  pendingMotions: Array<{
    eventId: string;
    title: string;
    date: string | null;
  }>;
  /** Deadlines the case record explicitly mentions (only verified dates). */
  knownDeadlines: Array<{
    eventId: string;
    title: string;
    date: string | null;
  }>;
  /** Appeal history — prior appeals filed in this case (chronology events
   *  with eventType=FILING whose title mentions "appeal" / "բողոք"). */
  appealHistory: AppealHistoryEntry[];
  /** Cassation history. */
  cassationHistory: AppealHistoryEntry[];
  /** Constitutional Court history. */
  conCourtHistory: AppealHistoryEntry[];
  /** ECHR history (steps taken at the ECtHR level). */
  echrHistory: AppealHistoryEntry[];
  /** Whether any element of the posture was inferred (vs. directly verified
   *  from the case record). False = all fields trace to chronology rows. */
  inferred: boolean;
}

export interface AppealHistoryEntry {
  eventId: string;
  title: string;
  date: string | null;
  /** "FILED" | "DECIDED" | "UNKNOWN" — derived from chronology event type. */
  outcome: string;
}

// ---------------------------------------------------------------------------
// §23 — DeadlineCalc
// ---------------------------------------------------------------------------

/**
 * A deadline calculation. Per §23 + §38: every calculated deadline requires
 * a verified trigger event + verified date + verified legal rule + calculation
 * method. If notice/service date is disputed → conditional analysis (returned
 * with `status: "DISPUTED"` and `conditionalBranches` populated).
 */
export interface DeadlineCalc {
  /** Procedural event that triggers the deadline (e.g. "notice served",
   *  "decision issued"). Must trace to a chronology event or be explicitly
   *  marked as `unknown` when no trigger has been verified. */
  triggerEvent: string;
  /** Verified date of the trigger event (ISO). Null when disputed or unknown. */
  verifiedDate: string | null;
  /** Legal rule that sets the deadline (article / statute name). Must be a
   *  verified rule from the legal-research layer or marked as `unknown`. */
  legalRule: string;
  /** Calculation method (e.g. "add 7 calendar days", "add 1 month"). */
  calculationMethod: string;
  /** Resulting deadline date (ISO). Null when the calc could not complete. */
  resultDate?: string | null;
  /** Exceptions that could apply (e.g. "weekend extension"). */
  exceptions: string[];
  /** Assumptions made when the calc could not be fully verified. */
  assumptions: string[];
  status: TemporalStatus;
  /** When the trigger date is disputed, conditional analysis is shown rather
   *  than a single result date. */
  conditionalBranches?: Array<{
    branchLabel: string;
    branchDate: string;
    branchResult: string;
  }>;
}

// ---------------------------------------------------------------------------
// §21 — ActionSpec
// ---------------------------------------------------------------------------

/**
 * The specification of a legal action type. The registry is the single
 * source of truth — the candidate generator never invents a new action type.
 *
 * `requiredFacts` / `requiredEvents` / `requiredMetadata` are human-readable
 * descriptions of what the action needs. They drive prerequisite generation
 * (§24) and the strategy verifier (§37).
 */
export interface ActionSpec {
  type: ActionType;
  /** Jurisdiction(s) where the action is recognized (e.g. "AM" for Armenia). */
  jurisdiction: string[];
  /** Proceeding types this action applies to (CRIMINAL / CIVIL / etc.). */
  proceedingTypes: string[];
  /** Procedural stages at which the action is allowed. */
  allowedStages: string[];
  /** Required facts (described — the prerequisites engine matches them to
   *  actual CaseFacts). */
  requiredFacts: string[];
  /** Required procedural events (described). */
  requiredEvents: string[];
  /** Required case-metadata fields (e.g. "court", "caseNumber"). */
  requiredMetadata: string[];
  /** Required evidence types (described — e.g. "postal delivery record"). */
  requiredEvidence: string[];
  /** Categories of legal basis that apply (e.g. "criminal_procedure_code",
   *  "civil_procedure_code", "constitution", "echr_convention"). */
  legalBasisCategories: string[];
  /** Timing requirements (described — e.g. "within 7 days of decision"). */
  timingRequirements: string[];
  /** §30 — Procedural effect: what the action seeks procedurally (NOT
   *  whether it will win). */
  proceduralEffect: string;
  /** §34 — Phase 6 DocumentType this action maps to for drafting. */
  draftDocumentType: string;
}

// ---------------------------------------------------------------------------
// §31 — StrategyMap
// ---------------------------------------------------------------------------

/**
 * The structured strategy map. Per §31 + §32: NO ranking, NO "best/worst",
 * NO magic score. Each issue lists its candidate actions with their full
 * analysis (prerequisites, evidence, gaps, authorities, counter-authorities,
 * timing, limitations). The user — not the engine — chooses.
 */
export interface StrategyMap {
  caseId: string;
  issues: StrategyIssueEntry[];
}

export interface StrategyIssueEntry {
  issueId: string;
  issueStatement: string;
  actions: LegalActionCandidate[];
  /** Topics the engine identified as needing further research (e.g. "verify
   *  service date", "fetch ConCourt precedent on Article 6"). */
  researchNeeded: string[];
}

// ---------------------------------------------------------------------------
// §40 — StrategyMetrics (11 hard fabrication/silent metrics — all must be 0)
// ---------------------------------------------------------------------------

export interface StrategyMetrics {
  /** Rate of fabricated action types not in the registry. */
  fabricatedActionRate: number;
  /** Rate of fabricated deadlines (calculated without verified trigger + rule). */
  fabricatedDeadlineRate: number;
  /** Rate of fabricated authority IDs (not in any persisted search result). */
  fabricatedAuthorityRate: number;
  /** Rate of evidence refs that point at non-existent case documents/pages. */
  invalidEvidenceRefRate: number;
  /** Rate of prerequisites marked SATISFIED that are actually NOT_SATISFIED. */
  falsePrerequisiteSatisfiedRate: number;
  /** Rate of missing prerequisites silently elided (no UNKNOWN flag). */
  hiddenMissingPrerequisiteRate: number;
  /** Rate of unsupported availability statuses (e.g. AVAILABLE_ON_CURRENT_RECORD
   *  when prerequisites are unsatisfied). */
  unsupportedAvailabilityRate: number;
  /** Rate of action analyses that omit available counter-authority. */
  counterAuthorityOmissionRate: number;
  /** Rate of actions proposed for the wrong procedural stage. */
  wrongStageActionRate: number;
  /** Rate of outputs that include ranking / "best option" / winner language. */
  silentRankingRate: number;
  /** Rate of outputs that silently switch Codex→fallback without surfacing
   *  the BLOCKED_EXTERNAL_QUOTA status. */
  silentApiBillingSwitchRate: number;
}

/** All-zero baseline — the evaluator's target. */
export const ZERO_STRATEGY_METRICS: StrategyMetrics = {
  fabricatedActionRate: 0,
  fabricatedDeadlineRate: 0,
  fabricatedAuthorityRate: 0,
  invalidEvidenceRefRate: 0,
  falsePrerequisiteSatisfiedRate: 0,
  hiddenMissingPrerequisiteRate: 0,
  unsupportedAvailabilityRate: 0,
  counterAuthorityOmissionRate: 0,
  wrongStageActionRate: 0,
  silentRankingRate: 0,
  silentApiBillingSwitchRate: 0,
};

// ---------------------------------------------------------------------------
// §39 — Gold fixture shape
// ---------------------------------------------------------------------------

export interface StrategyGoldFixture {
  /** Fixture index (1..15). */
  index: number;
  /** Human-readable name. */
  name: string;
  /** Scenario description. */
  description: string;
  /** The case type the fixture assumes (CRIMINAL / CIVIL / etc.). */
  caseType: string;
  /** The procedural stage the fixture assumes. */
  stage: string;
  /** What the fixture exercises (a fabrication / firewall failure mode). */
  exercises: string;
  /** Descriptive assertions — what the evaluator should check. */
  assertions: string[];
}

// ---------------------------------------------------------------------------
// §41 — Negative test result
// ---------------------------------------------------------------------------

export interface NegativeTestResult {
  name: string;
  blocked: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Verifier result shapes
// ---------------------------------------------------------------------------

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface StrategyVerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export interface DeadlineVerificationResult {
  passed: boolean;
  detail?: string;
}

export interface AuthorityVerificationResult {
  passed: boolean;
  invalid: string[];
}
