// src/lib/legal-strategy/evaluation/strategy-gold-set.ts
// Phase 7 — §39 — 15 synthetic strategy fixtures (S1-S15).
//
// Each fixture is a scenario the evaluator uses to exercise a specific
// fabrication / firewall failure mode. The evaluator runs each fixture
// through the §37 verifier and the §40 metric computation, and asserts
// the 11 hard metrics stay at 0.
//
// CRITICAL — §39: "Hard metrics computed, not invented — all must be 0."
//
// The fixtures are descriptive (text + scenario) — the evaluator builds
// the in-memory candidate from the fixture's description (similar to the
// drafting gold set's approach in Phase 6.1).

import type { StrategyGoldFixture } from "../types";

// ---------------------------------------------------------------------------
// §39 — 15 fixtures
// ---------------------------------------------------------------------------

export const STRATEGY_GOLD_FIXTURES: StrategyGoldFixture[] = [
  {
    index: 1,
    name: "fully supported appeal at appeal_decided stage",
    description:
      "Criminal case at appeal_decided stage. Verified first-instance + appellate decisions. Required notice served and documented. Cassation appeal candidate has 4/4 prerequisites satisfied.",
    caseType: "CRIMINAL",
    stage: "appeal_decided",
    exercises: "happy path — all prerequisites satisfied, deadline VERIFIED, supporting authority present",
    assertions: [
      "Candidate is CASSATION_APPEAL",
      "All 4 prerequisites SATISFIED with linked fact/event ids",
      "Deadline status = VERIFIED or CALCULATED_FROM_VERIFIED_RULE",
      "Availability = AVAILABLE_ON_CURRENT_RECORD",
      "At least one supporting authority present",
      "Counter-authority surfaced (when available)",
      "No ranking language in any text field",
    ],
  },
  {
    index: 2,
    name: "release motion at investigation stage with verified arrest",
    description:
      "Criminal case at investigation stage. Verified ARREST event with detention order in the record. Release motion candidate has prerequisites satisfiable.",
    caseType: "CRIMINAL",
    stage: "investigation",
    exercises: "RELEASE_MOTION — grounded in verified arrest event",
    assertions: [
      "Candidate is RELEASE_MOTION",
      "Stage 'investigation' is in RELEASE_MOTION.allowedStages",
      "Linked event id is the verified ARREST event",
      "Availability is not BLOCKED_BY_MISSING_PREREQUISITE",
    ],
  },
  {
    index: 3,
    name: "evidence exclusion motion with unverified search protocol",
    description:
      "Criminal case at first_instance stage. Search protocol NOT in the record (gap). EXCLUSION_ARGUMENT candidate flags a CRITICAL evidence gap.",
    caseType: "CRIMINAL",
    stage: "first_instance",
    exercises: "evidence gap — §25 missing document only when prerequisite requires",
    assertions: [
      "Candidate is EXCLUSION_ARGUMENT",
      "At least one evidence gap with severity CRITICAL references 'search protocol'",
      "Availability = POTENTIALLY_AVAILABLE or BLOCKED_BY_MISSING_PREREQUISITE",
      "Limitation list includes weak_documentary_support entry",
    ],
  },
  {
    index: 4,
    name: "constitutional complaint without exhaustion of remedies",
    description:
      "Criminal case at appeal_decided stage. No exhaustion of ordinary remedies. CONSTITUTIONAL_COMPLAINT candidate flags the missing prerequisite.",
    caseType: "CRIMINAL",
    stage: "appeal_decided",
    exercises: "missing prerequisite → BLOCKED_BY_MISSING_PREREQUISITE",
    assertions: [
      "Candidate is CONSTITUTIONAL_COMPLAINT",
      "At least one prerequisite is UNKNOWN or NOT_SATISFIED",
      "Availability = BLOCKED_BY_MISSING_PREREQUISITE or POTENTIALLY_AVAILABLE",
      "Limitation list includes missing_prerequisite entry",
    ],
  },
  {
    index: 5,
    name: "deadline restoration request with disputed notice date",
    description:
      "Civil case at first_instance_decided stage. Notice service date is disputed. DEADLINE_RESTORATION_REQUEST candidate's deadline is DISPUTED with conditional branches.",
    caseType: "CIVIL",
    stage: "first_instance_decided",
    exercises: "§43 — disputed trigger date → conditional analysis",
    assertions: [
      "Candidate is DEADLINE_RESTORATION_REQUEST",
      "Deadline status = DISPUTED",
      "conditionalBranches is non-empty",
      "Limitation list includes uncertain_deadline entry mentioning 'disputed'",
    ],
  },
  {
    index: 6,
    name: "appeal with expired deadline",
    description:
      "Civil case at first_instance_decided stage. Decision date is 60 days ago; appeal deadline is 30 days. APPEAL candidate's deadline is EXPIRED.",
    caseType: "CIVIL",
    stage: "first_instance_decided",
    exercises: "expired deadline → NOT_AVAILABLE_ON_CURRENT_RECORD",
    assertions: [
      "Candidate is APPEAL",
      "Deadline status = EXPIRED",
      "Availability = NOT_AVAILABLE_ON_CURRENT_RECORD",
      "Limitation list includes uncertain_deadline entry mentioning 'time-barred'",
    ],
  },
  {
    index: 7,
    name: "motion at investigation stage with no court metadata",
    description:
      "Criminal case with no court / caseNumber on the case row. MOTION candidate's metadata prerequisites are UNKNOWN.",
    caseType: "CRIMINAL",
    stage: "investigation",
    exercises: "missing metadata → UNKNOWN prerequisites (not SATISFIED — §24)",
    assertions: [
      "Candidate is MOTION",
      "Metadata prerequisites are UNKNOWN (not SATISFIED)",
      "Availability = POTENTIALLY_AVAILABLE or TEMPORALLY_UNCERTAIN",
    ],
  },
  {
    index: 8,
    name: "cassation appeal at wrong stage",
    description:
      "Civil case at first_instance_decided stage (not appeal_decided). CASSATION_APPEAL candidate is filtered out by getActionsForStage.",
    caseType: "CIVIL",
    stage: "first_instance_decided",
    exercises: "wrong stage → action not proposed by generator",
    assertions: [
      "CASSATION_APPEAL is NOT in the generated candidate list",
      "APPEAL IS in the generated candidate list (correct stage)",
    ],
  },
  {
    index: 9,
    name: "administrative challenge without challenged act",
    description:
      "Administrative case at first_instance stage. No administrative act identified. ADMINISTRATIVE_CHALLENGE candidate flags missing challenged act.",
    caseType: "ADMINISTRATIVE",
    stage: "first_instance",
    exercises: "§29 missing challenged act limitation",
    assertions: [
      "Candidate is ADMINISTRATIVE_CHALLENGE",
      "Limitation list includes missing_challenged_act entry",
      "Supporting facts list is empty",
    ],
  },
  {
    index: 10,
    name: "echr step without exhaustion of domestic remedies",
    description:
      "Criminal case at cassation_decided stage. No exhaustion documented. ECHR_STEP candidate flags the missing prerequisite + 6-month deadline is UNKNOWN.",
    caseType: "CRIMINAL",
    stage: "cassation_decided",
    exercises: "ECHR Article 35 — exhaustion + 6-month deadline",
    assertions: [
      "Candidate is ECHR_STEP",
      "Prerequisites for exhaustion are UNKNOWN",
      "Deadline status = UNKNOWN",
      "Availability = TEMPORALLY_UNCERTAIN or POTENTIALLY_AVAILABLE",
    ],
  },
  {
    index: 11,
    name: "objection to opposing party motion",
    description:
      "Civil case at first_instance stage. Opposing party filed a motion; OBJECTION candidate is generated.",
    caseType: "CIVIL",
    stage: "first_instance",
    exercises: "OBJECTION — objects to a specific procedural act",
    assertions: [
      "Candidate is OBJECTION",
      "Stage 'first_instance' is in OBJECTION.allowedStages",
      "Procedural effect mentions 'opposes a specific procedural act'",
    ],
  },
  {
    index: 12,
    name: "damages claim with weak documentary support",
    description:
      "Civil case at first_instance stage. Only one supporting document. DAMAGES_CLAIM candidate flags weak documentary support.",
    caseType: "CIVIL",
    stage: "first_instance",
    exercises: "§29 weak documentary support limitation",
    assertions: [
      "Candidate is DAMAGES_CLAIM",
      "Supporting evidence list has ≤ 1 ref",
      "Limitation list includes weak_documentary_support entry",
    ],
  },
  {
    index: 13,
    name: "counter-authority surfaced for serious action",
    description:
      "Criminal case at appeal_decided stage. CaseState has an adverse precedent with applicability NOT_APPLICABLE. CASSATION_APPEAL candidate surfaces it as counter-authority.",
    caseType: "CRIMINAL",
    stage: "appeal_decided",
    exercises: "§28 — counter-authority always surfaced when available",
    assertions: [
      "Candidate is CASSATION_APPEAL",
      "Counter-authority list is non-empty",
      "Limitation list includes counter_authority entry",
    ],
  },
  {
    index: 14,
    name: "evidence motion at appeal stage",
    description:
      "Criminal case at appeal stage. EVIDENCE_MOTION candidate is generated (new evidence at appeal).",
    caseType: "CRIMINAL",
    stage: "appeal",
    exercises: "EVIDENCE_MOTION — allowed at appeal stage",
    assertions: [
      "Candidate is EVIDENCE_MOTION",
      "Stage 'appeal' is in EVIDENCE_MOTION.allowedStages",
      "Draft document type = MOTION (§34 mapping)",
    ],
  },
  {
    index: 15,
    name: "release motion maps to MOTION draft type",
    description:
      "Criminal case at first_instance stage. RELEASE_MOTION candidate's draftDocumentType = MOTION (§34 mapping).",
    caseType: "CRIMINAL",
    stage: "first_instance",
    exercises: "§34 — RELEASE_MOTION → MOTION draft type",
    assertions: [
      "Candidate is RELEASE_MOTION",
      "draftDocumentType = 'MOTION'",
      "mapActionToDraftType('RELEASE_MOTION') returns 'MOTION'",
    ],
  },
];
