// src/lib/case-workspace/analysis-types.ts
// Local minimal type definitions for the Analysis Layer (Task 14-B).
//
// §6 — Provenance: every extracted item references caseId + volumeId? +
// documentId? + page? + section? + originalFilename + contentHash.
//
// This file is OWNED by Task 14-B (analysis layer). It defines only the
// minimal interfaces this layer needs defensively — even if Subagent A's
// shared `types.ts` is not present yet, these types allow the analysis layer
// to typecheck in isolation.
//
// Enumerations are written as string-literal unions (not TS `enum`) so they
// align with the string values stored in Prisma's String-typed columns.

// §6 — EvidenceRef: provenance for every extracted item.
export interface EvidenceRef {
  documentId?: string;
  volumeId?: string;
  page?: number;
  section?: string;
  quote?: string;
  originalFilename?: string;
  contentHash?: string;
}

// §8 — Chronology date verification state.
export type DateStatus = "EXACT" | "INFERRED" | "UNKNOWN";

// §8 — ChronologyEvent verification (extracted vs user-entered vs disputed).
export type Verification =
  | "DOCUMENT_VERIFIED"
  | "USER_ALLEGED"
  | "DISPUTED";

// §8 — Chronology event types.
export type ChronologyEventType =
  | "HEARING"
  | "FILING"
  | "SEARCH"
  | "SEIZURE"
  | "INTERROGATION"
  | "ARREST"
  | "DECISION"
  | "OTHER";

// §9 — CaseEntity types.
export type EntityType =
  | "PERSON"
  | "COMPANY"
  | "COURT"
  | "INVESTIGATOR"
  | "PROSECUTOR"
  | "LAWYER"
  | "EXPERT"
  | "GOVERNMENT_BODY"
  | "PENITENTIARY"
  | "OTHER";

// §10 — CaseFact status (cannot promote to VERIFIED without evidence).
export type FactStatus =
  | "VERIFIED"
  | "ALLEGED"
  | "DISPUTED"
  | "CONTRADICTED"
  | "UNKNOWN";

// §10 — CaseFact materiality.
export type Materiality = "HIGH" | "MEDIUM" | "LOW";

// §10 — CaseFact category.
export type FactCategory =
  | "TEMPORAL"
  | "SPATIAL"
  | "IDENTITY"
  | "PROCEDURAL"
  | "SUBSTANTIVE"
  | "EVIDENTIARY"
  | "OTHER";

// §10 — CaseFact source (USER-entered or AI-proposed; both begin ALLEGED).
export type FactSource = "USER" | "AI";

// §11 — EvidenceRelation: how an evidence item relates to a fact.
export type EvidenceRelation =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "CONTEXT"
  | "AUTHENTICATES";

// §11 — EvidenceStrength.
export type EvidenceStrength = "DIRECT" | "INDIRECT" | "CONTEXTUAL";

// §12 — CaseClaim types.
export type ClaimType =
  | "DEFENDANT"
  | "APPLICANT"
  | "PROSECUTION"
  | "GOVERNMENT"
  | "WITNESS"
  | "EXPERT"
  | "LOWER_COURT"
  | "COURT_FINDING"
  | "OTHER";

// §12 — CaseContradiction types.
export type ContradictionType =
  | "DIRECT"
  | "TEMPORAL"
  | "IDENTITY"
  | "PROCEDURAL"
  | "APPARENT";

// §12 — CaseContradiction status.
export type ContradictionStatus = "OPEN" | "EXPLAINED" | "RESOLVED";

// §12 — CaseContradiction significance.
export type ContradictionSignificance = "HIGH" | "MEDIUM" | "LOW";

// §13 — LegalIssue categories.
export type LegalIssueCategory =
  | "SUBSTANTIVE"
  | "PROCEDURAL"
  | "EVIDENTIARY"
  | "JURISDICTIONAL"
  | "OTHER";

// §8 — ChronologyEvent conflict structure.
export interface ChronologyConflict {
  eventIds: string[];
  reason: string;
}

// §11 — Evidence matrix maps.
export interface EvidenceMatrix {
  evidenceToFact: Map<string, string[]>;
  factToEvidence: Map<string, string[]>;
  links: Array<EvidenceLinkRecord>;
}

// EvidenceLinkRecord — a flat record used by the matrix builder.
export interface EvidenceLinkRecord {
  id: string;
  factId: string | null;
  evidenceRef: EvidenceRef;
  relation: EvidenceRelation;
  strength: EvidenceStrength;
}

// §13 — RelatedLaw and RelatedPrecedent (for LegalIssueLink).
export interface RelatedLaw {
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages?: string[];
}

export interface RelatedPrecedent {
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages?: string[];
  applicability?: string;
}

// §13 — LegalIssueLink issue payload used by linker.
export interface LegalIssueInput {
  statement: string;
  category: LegalIssueCategory;
  evidenceRef: EvidenceRef;
}

// §13 — Persisted LegalIssueLink record.
export interface LegalIssueLinkRecord {
  id: string;
  caseId: string;
  issueId: string;
  issueStatement: string;
  factIds: string[];
  evidenceRefs: EvidenceRef[];
  relatedLaw: RelatedLaw[];
  relatedPrecedents: RelatedPrecedent[];
}

// Persisted ChronologyEvent record (mirrors Prisma model).
export interface ChronologyEventRecord {
  id: string;
  caseId: string;
  date: string | null;
  originalDateText: string | null;
  dateStatus: DateStatus;
  eventType: ChronologyEventType;
  title: string;
  description?: string | null;
  participants: string[];
  evidenceRefs: EvidenceRef[];
  verification: Verification;
  hasConflict: boolean;
  conflictDetail?: string | null;
}

// Persisted CaseEntity record (mirrors Prisma model).
export interface CaseEntityRecord {
  id: string;
  caseId: string;
  canonicalName: string;
  aliases: string[];
  type: EntityType;
  roles: string[];
  evidenceRefs: EvidenceRef[];
}

// Persisted CaseFact record (mirrors Prisma model).
export interface CaseFactRecord {
  id: string;
  caseId: string;
  proposition: string;
  category: FactCategory;
  status: FactStatus;
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  relatedIssues: string[];
  materiality: Materiality;
  source: FactSource;
}

// Persisted CaseClaim record (mirrors Prisma model).
export interface CaseClaimRecord {
  id: string;
  caseId: string;
  claimType: ClaimType;
  proposition: string;
  source: EvidenceRef;
  status: string;
  evidenceRefs: EvidenceRef[];
}

// Persisted CaseContradiction record.
export interface CaseContradictionRecord {
  id: string;
  caseId: string;
  contradictionType: ContradictionType;
  significance: ContradictionSignificance;
  status: ContradictionStatus;
  claimA: { claimId?: string; proposition: string; source?: EvidenceRef };
  claimB: { claimId?: string; proposition: string; source?: EvidenceRef };
  reason?: string;
}

// Persisted CaseEvidenceLink record.
export interface CaseEvidenceLinkRecord {
  id: string;
  caseId: string;
  factId: string | null;
  evidenceRef: EvidenceRef;
  relation: EvidenceRelation;
  strength: EvidenceStrength;
}
