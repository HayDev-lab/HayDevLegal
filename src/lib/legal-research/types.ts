// src/lib/legal-research/types.ts
// LEGAL RESEARCH INTELLIGENCE — Phase 4 core types (master prompt §8-§100).
//
// The research layer sits ON TOP of the Phase 3 retrieval engine. It never
// re-runs retrieval and never fabricates facts: every substantive claim is
// grounded in an EvidenceRef pointing into the E1..En evidence pack.
//
//   QUESTION -> LEGAL ISSUE MAP -> VERIFIED RETRIEVAL (Phase 3)
//   -> DOCUMENT ROLE CLASSIFICATION -> HOLDING EXTRACTION
//   -> MATERIAL FACT EXTRACTION -> APPLICABILITY ANALYSIS
//   -> DISTINGUISHING ANALYSIS -> PRECEDENT RELATIONS
//   -> TEMPORAL + HIERARCHY + CONFLICT ANALYSIS -> ARGUMENT MAP
//   -> EVIDENCE-CHECKED LEGAL ANSWER

import type { LegalEvidence, QueryUnderstanding } from "@/lib/legal-search/types";

// ---------------------------------------------------------------------------
// Evidence grounding (§12 — a rule may only exist with a supporting passage)
// ---------------------------------------------------------------------------

/** A pointer into the evidence pack that grounds a claim. */
export interface EvidenceRef {
  /** Evidence pack id, e.g. "E1". */
  evidenceId: string;
  /** Exact span quoted from that evidence's passage (verbatim, normalized whitespace). */
  quote: string;
}

// ---------------------------------------------------------------------------
// Legal Issue Map (§8-§9)
// ---------------------------------------------------------------------------

export type LegalIssueCategory =
  | "SUBSTANTIVE"
  | "PROCEDURAL"
  | "EVIDENTIARY"
  | "CONSTITUTIONAL"
  | "ECHR"
  | "REMEDY";

export type LegalIssueStatus = "OPEN" | "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED";

export interface LegalIssue {
  id: string;
  title: string;
  description: string;
  category: LegalIssueCategory;
  /** Facts alleged by the user that bear on this issue (never auto-promoted to proven). */
  relevantFacts: string[];
  /** Sources that may govern the issue (act titles, courts, conventions). */
  possibleLegalSources: string[];
  status: LegalIssueStatus;
}

export interface LegalIssueMap {
  /** Original user question. */
  question: string;
  issues: LegalIssue[];
  /** Facts asserted by the user, with epistemic status (§18-§19). */
  userFacts: UserCaseFact[];
  /** How the map was built. */
  builtBy: "deterministic" | "llm-assisted";
}

// ---------------------------------------------------------------------------
// User case facts (§18-§19)
// ---------------------------------------------------------------------------

export type UserFactSource = "USER" | "FILE" | "RETRIEVED_RECORD";
export type FactStatus = "USER_ALLEGED" | "DOCUMENT_VERIFIED" | "DISPUTED" | "UNKNOWN";

export interface UserCaseFact {
  id: string;
  fact: string;
  source: UserFactSource;
  verified: boolean;
  status: FactStatus;
  legalRelevance?: string[];
}

// ---------------------------------------------------------------------------
// Document role classification (§10)
// ---------------------------------------------------------------------------

export type LegalDocumentRole =
  | "GOVERNING_RULE"
  | "INTERPRETIVE_PRECEDENT"
  | "FACTUALLY_SIMILAR_PRECEDENT"
  | "CONSTITUTIONAL_STANDARD"
  | "ECHR_STANDARD"
  | "PROCEDURAL_HISTORY"
  | "COUNTER_AUTHORITY"
  | "SECONDARY_CONTEXT"
  | "IRRELEVANT";

export interface DocumentRoleAssessment {
  evidenceId: string;
  role: LegalDocumentRole;
  /** Why this role was assigned (short, user-presentable, no chain-of-thought). */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Holding extraction (§11-§15, §43-§44)
// ---------------------------------------------------------------------------

export type HoldingConfidence = "HIGH" | "MEDIUM" | "LOW";

/** What kind of holding an ECtHR text yields (§44 — principle vs outcome). */
export type HoldingKind = "GENERAL_PRINCIPLE" | "CASE_SPECIFIC_FINDING" | "DOMESTIC_RULE";

export interface LegalHolding {
  id: string;
  documentId: string;
  /** The legal issue the holding addresses (short phrase). */
  issue: string;
  /** The rule/position the COURT itself established. Empty when unsupported. */
  rule: string;
  /** How the court applied the rule (optional). */
  application?: string;
  /** The court's conclusion (optional). */
  conclusion?: string;
  /** §44 — general principle vs case-specific finding (ECtHR especially). */
  kind: HoldingKind;
  supportingPassages: EvidenceRef[];
  confidence: HoldingConfidence;
  /** §15 — verification verdict of the grounding passages. */
  verification: "ACCEPT" | "WEAK" | "REJECT";
}

// ---------------------------------------------------------------------------
// Material facts (§16-§17)
// ---------------------------------------------------------------------------

/** Fixed taxonomy of legally material fact dimensions (§17). */
export type MaterialFactCategory =
  | "STAGE" // վարույթի փուլ
  | "PROCEDURAL_BASIS" // գործողության իրավական հիմք
  | "AUTHORITY_ACTION" // ո՞ր մարմինն է գործել
  | "TIMING" // ե՞րբ է տեղի ունեցել
  | "NOTICE" // ծանուցում
  | "PRESENCE" // ներկայություն
  | "OBJECT_ORIGIN" // ապացույցի ծագում
  | "CHARGE" // մեղադրանք
  | "DETENTION_STATUS" // կալանքի վիճակ
  | "RISK_ASSESSMENT" // փախուստի/խոչընդոտման ռիսկ (§45)
  | "OTHER";

export interface MaterialFact {
  id: string;
  category: MaterialFactCategory;
  fact: string;
  evidence: EvidenceRef[];
  /** 0..1 relevance to the user's issue (used for distinguishing weight). */
  relevanceToIssue: number;
}

// ---------------------------------------------------------------------------
// Applicability (§20-§24)
// ---------------------------------------------------------------------------

export type IssueMatch = "STRONG" | "PARTIAL" | "WEAK";
export type RuleMatch = "SAME_RULE" | "RELATED_RULE" | "DIFFERENT_RULE" | "UNKNOWN";
export type FactualSimilarity = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type PostureMatch = "SAME" | "COMPARABLE" | "DIFFERENT" | "UNKNOWN";
export type TemporalCompatibility =
  | "COMPATIBLE"
  | "POTENTIALLY_STALE"
  | "INCOMPATIBLE"
  | "UNKNOWN";
export type AuthorityWeight = "BINDING" | "HIGHLY_PERSUASIVE" | "PERSUASIVE" | "CONTEXTUAL";
export type ApplicabilityConclusion =
  | "DIRECTLY_RELEVANT"
  | "RELEVANT_WITH_DISTINCTIONS"
  | "ANALOGICAL_ONLY"
  | "NOT_MATERIALLY_APPLICABLE"
  | "ANALYSIS_UNAVAILABLE";

export interface DistinguishingFactor {
  /** Dimension the difference lives on (fact category or legal dimension). */
  dimension: string;
  userCase: string;
  precedentCase: string;
  whyItMayMatter: string;
  evidence: EvidenceRef[];
  significance: "MAJOR" | "MODERATE" | "MINOR";
}

export interface SupportingFactor {
  dimension: string;
  similarity: string;
  whyItMatters: string;
  evidence: EvidenceRef[];
}

export interface ApplicabilityResult {
  precedentId: string;
  issueId: string;
  legalIssueMatch: IssueMatch;
  ruleMatch: RuleMatch;
  factualSimilarity: FactualSimilarity;
  proceduralPostureMatch: PostureMatch;
  temporalCompatibility: TemporalCompatibility;
  authority: AuthorityWeight;
  distinguishingFactors: DistinguishingFactor[];
  supportingFactors: SupportingFactor[];
  conclusion: ApplicabilityConclusion;
  evidence: EvidenceRef[];
  /** §63 — metadata-only documents never produce holdings/applicability. */
  metadataOnly: boolean;
}

// ---------------------------------------------------------------------------
// Precedent relations (§29-§32)
// ---------------------------------------------------------------------------

export type PrecedentRelationKind =
  | "CITES"
  | "FOLLOWS"
  | "APPLIES"
  | "DISTINGUISHES"
  | "LIMITS"
  | "DEVELOPS"
  | "CONFLICTS_WITH"
  | "REFERENCES";

export interface PrecedentRelation {
  fromId: string;
  toId: string;
  kind: PrecedentRelationKind;
  /** Verbatim span in the `from` document that evidences the relation. */
  evidence: EvidenceRef;
}

// ---------------------------------------------------------------------------
// Temporal analysis (§33-§35)
// ---------------------------------------------------------------------------

export interface TemporalAnalysis {
  evidenceId: string;
  compatibility: TemporalCompatibility;
  /** Law version the precedent applied, when identifiable (§35). */
  lawVersion?: string;
  versionStatus: "IDENTIFIED" | "TEMPORAL_VERSION_UNKNOWN";
  /** Later authorities that may affect the precedent (ids from the pack). */
  laterAuthorities: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Hierarchy analysis (§36-§38)
// ---------------------------------------------------------------------------

export interface AuthorityAssessment {
  documentId: string;
  jurisdiction: string;
  institution: string;
  legalRole: string;
  relevanceToIssue: string;
  bindingEffect?: string;
  evidence?: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// Conflict detection (§39-§40)
// ---------------------------------------------------------------------------

export type LegalConflictType =
  | "DIRECT"
  | "APPARENT"
  | "FACT_DEPENDENT"
  | "TEMPORAL"
  | "DIFFERENT_SCOPE";

export interface LegalConflict {
  issueId: string;
  authorityA: string;
  authorityB: string;
  conflictType: LegalConflictType;
  explanation: string;
  evidence: EvidenceRef[];
}

// ---------------------------------------------------------------------------
// Argument map (§46-§49)
// ---------------------------------------------------------------------------

export type ArgumentSide = "SUPPORTS_USER_POSITION" | "COUNTERARGUMENT" | "NEUTRAL";
export type ArgumentStrength = "STRONG" | "MODERATE" | "LIMITED";

export interface LegalArgument {
  id: string;
  issueId: string;
  proposition: string;
  side: ArgumentSide;
  authorities: EvidenceRef[];
  strength: ArgumentStrength;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Missing facts & completeness (§97-§101)
// ---------------------------------------------------------------------------

export interface MissingMaterialFact {
  factNeeded: string;
  whyItMatters: string;
  affectedIssueIds: string[];
}

export interface ResearchCompleteness {
  issuesIdentified: number;
  issuesSupported: number;
  unresolvedIssues: number;
  precedentsAnalyzed: number;
  counterAuthoritiesFound: number;
  temporalRisks: number;
}

// ---------------------------------------------------------------------------
// Research report — the Phase 4 artifact consumed by the answer engine
// ---------------------------------------------------------------------------

export type ResearchStageStatus = "ok" | "partial" | "failed" | "skipped";

export interface ResearchStageTrace {
  stage:
    | "issue_map"
    | "role_classification"
    | "holding_extraction"
    | "material_facts"
    | "applicability"
    | "distinguishing"
    | "precedent_relations"
    | "temporal_analysis"
    | "hierarchy_analysis"
    | "conflict_analysis"
    | "argument_map"
    | "synthesis";
  status: ResearchStageStatus;
  durationMs: number;
  detail?: string;
}

export interface ResearchReport {
  /** Analysis schema version (cache invalidation §74). */
  version: string;
  mode: "deep";
  issueMap: LegalIssueMap;
  roles: DocumentRoleAssessment[];
  holdings: LegalHolding[];
  materialFacts: MaterialFact[];
  applicability: ApplicabilityResult[];
  relations: PrecedentRelation[];
  temporal: TemporalAnalysis[];
  hierarchy: AuthorityAssessment[];
  conflicts: LegalConflict[];
  arguments: LegalArgument[];
  missingFacts: MissingMaterialFact[];
  completeness: ResearchCompleteness;
  stages: ResearchStageTrace[];
  /** §105 — partial-analysis warning surfaced to the user. */
  partial: boolean;
  notes: string[];
}

/** Empty report used when analysis could not run (fail closed, §76). */
export function emptyResearchReport(question: string): ResearchReport {
  return {
    version: "4.0.0",
    mode: "deep",
    issueMap: {
      question,
      issues: [],
      userFacts: [],
      builtBy: "deterministic",
    },
    roles: [],
    holdings: [],
    materialFacts: [],
    applicability: [],
    relations: [],
    temporal: [],
    hierarchy: [],
    conflicts: [],
    arguments: [],
    missingFacts: [],
    completeness: {
      issuesIdentified: 0,
      issuesSupported: 0,
      unresolvedIssues: 0,
      precedentsAnalyzed: 0,
      counterAuthoritiesFound: 0,
      temporalRisks: 0,
    },
    stages: [],
    partial: true,
    notes: ["Վերլուծությունն անհասանելի է (ANALYSIS_UNAVAILABLE)։"],
  };
}

/** Input bundle the research pipeline consumes. */
export interface ResearchInput {
  query: string;
  understanding: QueryUnderstanding;
  evidence: LegalEvidence[];
  /** Wall-clock deadline (epoch ms) for the whole research layer (§105). */
  deadline: number;
}

// ---------------------------------------------------------------------------
// Armenian / ECtHR section model (§14)
// ---------------------------------------------------------------------------

export type CourtSectionKind =
  | "FACTS"
  | "PARTY_SUBMISSIONS"
  | "LEGAL_FRAMEWORK"
  | "COURT_ANALYSIS"
  | "CONCLUSION"
  | "OPERATIVE_PART"
  | "UNKNOWN";

export interface CourtSection {
  kind: CourtSectionKind;
  title: string;
  text: string;
}
