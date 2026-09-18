// src/lib/legal-strategy/state/case-state.ts
// Phase 7 — §16 — Build the CaseState: a bounded, verified slice of the Case
// Workspace (facts, evidence, chronology, issues, research) consumed by every
// downstream strategy layer.
//
// Per §35: "Bounded context — never send 10,000 pages." The CaseState is
// built deterministically from the verified Case Workspace rows — it never
// invokes the LLM, never invents a fact, and never invents a procedural event.
//
// The CaseState is the ONLY input the deterministic prerequisite / evidence-gap
// / deadline / authority layers receive. Per §36, the Codex multi-action
// synthesizer (when available) receives the CaseState plus the action
// registry; the deterministic layers must work without Codex.

import { db } from "@/lib/db";
import type {
  CaseFact,
  CaseEvidenceLink,
  ChronologyEvent,
  LegalIssueLink,
  EvidenceRef,
  LegalReferenceEntry,
} from "@/lib/case-workspace/types";
import {
  STRATEGY_MAX_FACTS_IN_CONTEXT,
  STRATEGY_MAX_CHRONOLOGY,
  STRATEGY_MAX_EVIDENCE_REFS,
  STRATEGY_MAX_AUTHORITIES_PER_ISSUE,
  STRATEGY_MAX_ISSUES,
} from "../config";

// ---------------------------------------------------------------------------
// CaseState shape
// ---------------------------------------------------------------------------

export interface CaseState {
  caseId: string;
  caseType: string | null;
  court: string | null;
  jurisdiction: string | null;
  proceedingType: string | null;
  caseNumber: string | null;
  /** Bounded list of facts (priority: VERIFIED > DISPUTED > ALLEGED, then
   *  HIGH materiality first). */
  facts: CaseFact[];
  /** Bounded list of chronology events (DOCUMENT_VERIFIED first). */
  events: ChronologyEvent[];
  /** All CaseEvidenceLink rows for this case (small — bounded by the
   *  case's actual evidence rows). */
  evidenceLinks: CaseEvidenceLink[];
  /** Bounded list of LegalIssueLinks (each carrying relatedLaw +
   *  relatedPrecedents from the Phase 4 federated search). */
  issues: ParsedIssueLink[];
  /** Map of valid CaseFact ids (for prerequisite traceability checks). */
  factIds: Set<string>;
  /** Map of valid CaseDocument ids + page counts (for EvidenceRef checks). */
  documentIndex: Map<string, { pageCount: number; documentType: string }>;
  /** Map of valid authority citation ids per source (L, C, CC, E prefixes). */
  authorityIdMap: Map<string, LegalReferenceEntry>;
}

export interface ParsedIssueLink {
  id: string;
  caseId: string;
  issueId: string;
  issueStatement: string;
  factIds: string[];
  evidenceRefs: EvidenceRef[];
  relatedLaw: LegalReferenceEntry[];
  relatedPrecedents: LegalReferenceEntry[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers — JSON parsing (defensive — never throws)
// ---------------------------------------------------------------------------

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Materiality ordering (HIGH > MEDIUM > LOW) — same as Phase 6.
// ---------------------------------------------------------------------------

function materialityRank(m: string): number {
  if (m === "HIGH") return 0;
  if (m === "MEDIUM") return 1;
  return 2;
}

function factStatusRank(s: string): number {
  // VERIFIED > DISPUTED > ALLEGED > CONTRADICTED > UNKNOWN
  if (s === "VERIFIED") return 0;
  if (s === "DISPUTED") return 1;
  if (s === "ALLEGED") return 2;
  if (s === "CONTRADICTED") return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Map raw Prisma rows to parsed shapes
// ---------------------------------------------------------------------------

type FactRow = Awaited<ReturnType<typeof db.caseFact.findFirst>>;
function mapFact(r: NonNullable<FactRow>): CaseFact {
  return {
    id: r.id,
    caseId: r.caseId,
    proposition: r.proposition,
    category: r.category,
    status: r.status as CaseFact["status"],
    supportingEvidence: parseJsonArray<EvidenceRef>(r.supportingEvidence),
    contradictingEvidence: parseJsonArray<EvidenceRef>(r.contradictingEvidence),
    relatedIssues: parseJsonArray<string>(r.relatedIssues),
    materiality: r.materiality as CaseFact["materiality"],
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type EventRow = Awaited<ReturnType<typeof db.chronologyEvent.findFirst>>;
function mapEvent(r: NonNullable<EventRow>): ChronologyEvent {
  return {
    id: r.id,
    caseId: r.caseId,
    date: r.date,
    originalDateText: r.originalDateText,
    dateStatus: r.dateStatus as ChronologyEvent["dateStatus"],
    eventType: r.eventType,
    title: r.title,
    description: r.description,
    participants: parseJsonArray<string>(r.participants),
    evidenceRefs: parseJsonArray<EvidenceRef>(r.evidenceRefs),
    verification: r.verification as ChronologyEvent["verification"],
    hasConflict: r.hasConflict,
    conflictDetail: r.conflictDetail,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type EvidenceLinkRow = Awaited<ReturnType<typeof db.caseEvidenceLink.findFirst>>;
function mapEvidenceLink(r: NonNullable<EvidenceLinkRow>): CaseEvidenceLink {
  const ref = (() => {
    try {
      const v = JSON.parse(r.evidenceRef);
      return typeof v === "object" && v !== null ? (v as EvidenceRef) : { documentId: "__missing__" };
    } catch {
      return { documentId: "__missing__" } as EvidenceRef;
    }
  })();
  return {
    id: r.id,
    caseId: r.caseId,
    factId: r.factId,
    evidenceRef: ref,
    relation: r.relation as CaseEvidenceLink["relation"],
    strength: r.strength as CaseEvidenceLink["strength"],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type IssueRow = Awaited<ReturnType<typeof db.legalIssueLink.findFirst>>;
function mapIssueLink(r: NonNullable<IssueRow>): ParsedIssueLink {
  return {
    id: r.id,
    caseId: r.caseId,
    issueId: r.issueId,
    issueStatement: r.issueStatement,
    factIds: parseJsonArray<string>(r.factIds),
    evidenceRefs: parseJsonArray<EvidenceRef>(r.evidenceRefs),
    relatedLaw: parseJsonArray<LegalReferenceEntry>(r.relatedLaw),
    relatedPrecedents: parseJsonArray<LegalReferenceEntry>(r.relatedPrecedents),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// buildCaseState
// ---------------------------------------------------------------------------

/**
 * Build a bounded, verified CaseState for the strategy engine.
 *
 * Algorithm:
 *   1. Fetch the CaseWorkspace row (caseType, court, jurisdiction, etc.).
 *   2. Fetch all CaseFact rows. Rank by status + materiality. Keep top N.
 *   3. Fetch all ChronologyEvent rows. Rank DOCUMENT_VERIFIED first. Keep top N.
 *   4. Fetch all CaseEvidenceLink rows (no rank — they're already small).
 *   5. Fetch all LegalIssueLink rows (bounded by STRATEGY_MAX_ISSUES).
 *   6. Build the authorityIdMap: every relatedLaw/relatedPrecedents citation
 *      gets a stable L#/C#/CC#/E# id (synthesized here, persisted as the
 *      source's identifier — see §26 for the re-use of Phase 3/4 search).
 *   7. Build the documentIndex from CaseDocument rows (pageCount + type).
 *
 * NEVER throws — failures fall back to empty arrays so the strategy engine
 * can still produce a (likely empty) strategy map rather than crashing the
 * case workspace UI.
 */
export async function buildCaseState(caseId: string): Promise<CaseState> {
  if (!caseId) {
    return emptyCaseState("");
  }

  const [caseRow, factRows, eventRows, evidenceLinkRows, issueRows, documentRows] =
    await Promise.all([
      db.caseWorkspace.findUnique({
        where: { id: caseId },
        select: {
          caseType: true,
          court: true,
          jurisdiction: true,
          proceedingType: true,
          caseNumber: true,
        },
      }),
      db.caseFact.findMany({
        where: { caseId },
        orderBy: [{ status: "asc" }, { materiality: "asc" }],
      }),
      db.chronologyEvent.findMany({
        where: { caseId },
        orderBy: [{ verification: "asc" }, { date: "asc" }],
      }),
      db.caseEvidenceLink.findMany({ where: { caseId } }),
      db.legalIssueLink.findMany({
        where: { caseId },
        orderBy: { updatedAt: "desc" },
        take: STRATEGY_MAX_ISSUES,
      }),
      db.caseDocument.findMany({
        where: { caseId },
        select: { id: true, pageCount: true, documentType: true },
      }),
    ]);

  // Rank facts by status (VERIFIED first) then materiality (HIGH first).
  const rankedFacts = factRows
    .map(mapFact)
    .sort((a, b) => {
      const s = factStatusRank(a.status) - factStatusRank(b.status);
      if (s !== 0) return s;
      return materialityRank(a.materiality) - materialityRank(b.materiality);
    })
    .slice(0, STRATEGY_MAX_FACTS_IN_CONTEXT);

  // Rank events: DOCUMENT_VERIFIED first, then USER_ALLEGED, then DISPUTED.
  const eventRank = (v: string): number =>
    v === "DOCUMENT_VERIFIED" ? 0 : v === "USER_ALLEGED" ? 1 : 2;
  const rankedEvents = eventRows
    .map(mapEvent)
    .sort((a, b) => eventRank(a.verification) - eventRank(b.verification))
    .slice(0, STRATEGY_MAX_CHRONOLOGY);

  // Bounded evidence links: cap at STRATEGY_MAX_EVIDENCE_REFS for the in-memory
  // state. (The full set stays in the DB; the strategy engine only needs a
  // bounded slice.)
  const boundedEvidenceLinks = evidenceLinkRows
    .map(mapEvidenceLink)
    .slice(0, STRATEGY_MAX_EVIDENCE_REFS);

  const parsedIssues = issueRows.map(mapIssueLink);

  // Build the authorityIdMap. The Phase 4 federated search already assigned
  // the L#/C#/CC#/E# ids; we surface them here so the strategy authority
  // layer can re-use them without re-running the search. When a relatedLaw /
  // relatedPrecedents entry lacks an explicit id, we synthesize a stable one
  // (L1, L2... by source + citation) so the verifier can check consistency.
  const authorityIdMap = new Map<string, LegalReferenceEntry>();
  let lIdx = 0;
  let cIdx = 0;
  let ccIdx = 0;
  let eIdx = 0;
  const seenAuthorityKey = new Set<string>();
  for (const issue of parsedIssues) {
    // Bound authorities per issue (§35).
    const laws = issue.relatedLaw.slice(0, STRATEGY_MAX_AUTHORITIES_PER_ISSUE);
    const precedents = issue.relatedPrecedents.slice(
      0,
      STRATEGY_MAX_AUTHORITIES_PER_ISSUE,
    );
    for (const law of laws) {
      const key = `L|${law.source}|${law.citation}`;
      if (seenAuthorityKey.has(key)) continue;
      seenAuthorityKey.add(key);
      lIdx++;
      authorityIdMap.set(`L${lIdx}`, law);
    }
    for (const prec of precedents) {
      const s = (prec.source || "").toLowerCase();
      let prefix: string;
      if (s.includes("hudoc") || s.includes("echr")) {
        eIdx++;
        prefix = `E${eIdx}`;
      } else if (s.includes("concourt") || s.includes("constitutional")) {
        ccIdx++;
        prefix = `CC${ccIdx}`;
      } else {
        cIdx++;
        prefix = `C${cIdx}`;
      }
      const key = `${prefix}|${prec.source}|${prec.citation}`;
      if (seenAuthorityKey.has(key)) continue;
      seenAuthorityKey.add(key);
      authorityIdMap.set(prefix, prec);
    }
  }

  // Document index for EvidenceRef validation (§37 — case evidence IDs valid).
  const documentIndex = new Map<string, { pageCount: number; documentType: string }>();
  for (const d of documentRows) {
    documentIndex.set(d.id, {
      pageCount: d.pageCount,
      documentType: d.documentType,
    });
  }

  return {
    caseId,
    caseType: caseRow?.caseType ?? null,
    court: caseRow?.court ?? null,
    jurisdiction: caseRow?.jurisdiction ?? null,
    proceedingType: caseRow?.proceedingType ?? null,
    caseNumber: caseRow?.caseNumber ?? null,
    facts: rankedFacts,
    events: rankedEvents,
    evidenceLinks: boundedEvidenceLinks,
    issues: parsedIssues,
    factIds: new Set(rankedFacts.map((f) => f.id)),
    documentIndex,
    authorityIdMap,
  };
}

// ---------------------------------------------------------------------------
// Empty state (for failed / not-found cases)
// ---------------------------------------------------------------------------

export function emptyCaseState(caseId: string): CaseState {
  return {
    caseId,
    caseType: null,
    court: null,
    jurisdiction: null,
    proceedingType: null,
    caseNumber: null,
    facts: [],
    events: [],
    evidenceLinks: [],
    issues: [],
    factIds: new Set(),
    documentIndex: new Map(),
    authorityIdMap: new Map(),
  };
}
