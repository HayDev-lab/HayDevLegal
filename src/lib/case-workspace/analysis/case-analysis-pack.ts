// src/lib/case-workspace/analysis/case-analysis-pack.ts
// Build a BOUNDED CLOSED CaseAnalysisPack (§14) for the Codex CLI provider.
//
// §14 — NEVER send all case pages to Codex. Selection criteria:
//   - User-selected facts/issues (if provided) take priority.
//   - Otherwise: all VERIFIED + DISPUTED facts (high materiality first), top-N
//     issues, all supporting/contradicting evidence refs (NOT full document
//     text — just refs).
//   - Cap at `maxEvidenceItems ?? 30` evidence items.
//
// Selection is explainable + provenance-preserving (§14): every item in the
// pack carries its documentId / page / quote / source so the closed-evidence
// firewall (§16) can reject any invented citation.

import { randomUUID } from "node:crypto";

import type {
  CaseAnalysisPack,
  LegalEvidence,
  UserCaseFact,
  ChronologyEvent as CodexChronologyEvent,
  LegalIssue as CodexLegalIssue,
  LegalEvidenceType,
} from "@/lib/ai-runtime/codex/types";
import type { ResearchReport } from "@/lib/legal-research/types";
import type {
  CaseFact,
  ChronologyEvent,
  LegalIssueLink,
  LegalReferenceEntry,
  EvidenceRef,
} from "@/lib/case-workspace/types";
import { db } from "@/lib/case-workspace/db";
import { parseJsonField } from "../research/types";

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export interface BuildCaseAnalysisPackOptions {
  query: string;
  /** User-selected CaseFact ids — these take priority when building userFacts. */
  selectedFactIds?: string[];
  /** User-selected LegalIssueLink.issueId values. */
  selectedIssueIds?: string[];
  /** Hard cap on evidence items (default 30 — §14). */
  maxEvidenceItems?: number;
  /** Hard cap on issues (default 12 — §14 keeps the prompt token cost down). */
  maxIssues?: number;
}

const DEFAULT_MAX_EVIDENCE = 30;
const DEFAULT_MAX_ISSUES = 12;
const DEFAULT_MAX_CHRONOLOGY = 20;

// ---------------------------------------------------------------------------
// Materiality ordering (HIGH > MEDIUM > LOW)
// ---------------------------------------------------------------------------

function materialityRank(m: string): number {
  if (m === "HIGH") return 0;
  if (m === "MEDIUM") return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadFacts(
  caseId: string,
  selectedFactIds: string[] | undefined,
): Promise<CaseFact[]> {
  const ids = selectedFactIds ?? [];
  if (ids.length > 0) {
    const rows = await db.caseFact.findMany({ where: { caseId, id: { in: ids } } });
    return rows.map(parseFactRow);
  }
  // Default selection: VERIFIED + DISPUTED facts, high materiality first.
  const rows = await db.caseFact.findMany({
    where: {
      caseId,
      status: { in: ["VERIFIED", "DISPUTED"] },
    },
  });
  return rows
    .map(parseFactRow)
    .sort((a, b) => {
      const mr = materialityRank(a.materiality) - materialityRank(b.materiality);
      if (mr !== 0) return mr;
      return a.proposition.localeCompare(b.proposition);
    });
}

function parseFactRow(r: {
  id: string;
  caseId: string;
  proposition: string;
  category: string;
  status: string;
  supportingEvidence: string;
  contradictingEvidence: string;
  relatedIssues: string;
  materiality: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): CaseFact {
  return {
    id: r.id,
    caseId: r.caseId,
    proposition: r.proposition,
    category: r.category,
    status: r.status as CaseFact["status"],
    supportingEvidence: parseJsonField<EvidenceRef[]>(r.supportingEvidence, []),
    contradictingEvidence: parseJsonField<EvidenceRef[]>(
      r.contradictingEvidence,
      [],
    ),
    relatedIssues: parseJsonField<string[]>(r.relatedIssues, []),
    materiality: r.materiality as CaseFact["materiality"],
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function loadIssueLinks(
  caseId: string,
  selectedIssueIds: string[] | undefined,
): Promise<LegalIssueLink[]> {
  const rows = await db.legalIssueLink.findMany({ where: { caseId } });
  const all = rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    issueId: r.issueId,
    issueStatement: r.issueStatement,
    factIds: parseJsonField<string[]>(r.factIds, []),
    evidenceRefs: parseJsonField<EvidenceRef[]>(r.evidenceRefs, []),
    relatedLaw: parseJsonField<LegalReferenceEntry[]>(r.relatedLaw, []),
    relatedPrecedents: parseJsonField<LegalReferenceEntry[]>(
      r.relatedPrecedents,
      [],
    ),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  if (selectedIssueIds && selectedIssueIds.length > 0) {
    return all.filter((l) => selectedIssueIds.includes(l.issueId));
  }
  return all;
}

async function loadChronology(caseId: string): Promise<ChronologyEvent[]> {
  const rows = await db.chronologyEvent.findMany({ where: { caseId } });
  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    date: r.date,
    originalDateText: r.originalDateText,
    dateStatus: r.dateStatus as ChronologyEvent["dateStatus"],
    eventType: r.eventType,
    title: r.title,
    description: r.description,
    participants: parseJsonField<string[]>(r.participants, []),
    evidenceRefs: parseJsonField<EvidenceRef[]>(r.evidenceRefs, []),
    verification: r.verification as ChronologyEvent["verification"],
    hasConflict: r.hasConflict,
    conflictDetail: r.conflictDetail,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function loadExistingAnalysis(
  caseId: string,
): Promise<ResearchReport | undefined> {
  const row = await db.caseAnalysisResult.findFirst({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    select: { analysis: true, status: true },
  });
  if (!row || !row.analysis) return undefined;
  try {
    // The analysis field is opaque — it may hold a CodexCaseAnalysis or a
    // DeterministicCaseAnalysis. The closed-evidence prompt treats
    // existingResearch as opaque context, so we pass it through as
    // `unknown as ResearchReport`. We DO NOT validate the shape here.
    return JSON.parse(row.analysis) as ResearchReport;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Converters: case-workspace types → Codex pack types
// ---------------------------------------------------------------------------

function toUserFact(f: CaseFact): UserCaseFact {
  return {
    id: f.id,
    description: f.proposition,
    source: "user",
    supported: f.status === "VERIFIED",
  };
}

function refToEvidence(
  ref: LegalReferenceEntry,
  id: string,
  type: LegalEvidenceType,
): LegalEvidence {
  const passages = (ref.passages ?? []).filter((p) => p && p.length > 0);
  return {
    id,
    source: ref.source,
    citation: ref.citation,
    url: ref.url,
    date: ref.date,
    passages,
    type,
  };
}

function caseEvidenceRefToEvidence(
  ref: EvidenceRef,
  id: string,
  displayName: string,
): LegalEvidence {
  // §14 — only the REFERENCE (not full document text) is sent. The passage
  // is the verbatim quote (if any) — Codex can cite it but cannot retrieve
  // more of the document.
  const passages: string[] = [];
  if (ref.quote && ref.quote.length > 0) passages.push(ref.quote);
  const page = ref.page !== undefined ? `, էջ ${ref.page}` : "";
  return {
    id,
    source: "case-document",
    citation: `${displayName}${page}`,
    passages,
    type: "other",
  };
}

function toCodexChronology(
  e: ChronologyEvent,
  evidenceId: string | undefined,
): CodexChronologyEvent {
  return {
    id: e.id,
    date: e.date ?? undefined,
    event: e.title,
    evidenceId,
  };
}

function toCodexIssue(
  link: LegalIssueLink,
  relatedEvidenceIds: string[],
): CodexLegalIssue {
  return {
    id: link.issueId,
    statement: link.issueStatement,
    relatedEvidence: relatedEvidenceIds,
  };
}

// ---------------------------------------------------------------------------
// Source-classification helper — maps a LegalReferenceEntry.source string
// to the codex pack's evidence taxonomy (legislation / cassation /
// constitutional / echr / other).
// ---------------------------------------------------------------------------

function classifySource(source: string): LegalEvidenceType {
  const s = source.toLowerCase();
  if (s === "arlis" || s === "local-laws" || s.includes("legislation")) {
    return "legislation";
  }
  if (s.includes("hudoc") || s.includes("echr")) return "echr";
  if (s.includes("concourt") || s.includes("constitutional")) {
    return "constitutional";
  }
  if (s.includes("cassation") || s.includes("judiciary") || s.includes("datalex")) {
    return "cassation";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// buildCaseAnalysisPack
// ---------------------------------------------------------------------------

export async function buildCaseAnalysisPack(
  caseId: string,
  opts: BuildCaseAnalysisPackOptions,
): Promise<CaseAnalysisPack> {
  const maxEvidenceItems = opts.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE;
  const maxIssues = opts.maxIssues ?? DEFAULT_MAX_ISSUES;

  // ---- Load case data ----------------------------------------------------
  const [facts, issueLinks, chronology] = await Promise.all([
    loadFacts(caseId, opts.selectedFactIds),
    loadIssueLinks(caseId, opts.selectedIssueIds),
    loadChronology(caseId),
  ]);
  const existingResearch = await loadExistingAnalysis(caseId);

  // ---- Build userFacts ---------------------------------------------------
  const userFacts: UserCaseFact[] = facts.map(toUserFact);

  // ---- Build chronology (top N by date) ---------------------------------
  const sortedChronology = [...chronology].sort((a, b) => {
    const ad = a.date ?? "";
    const bd = b.date ?? "";
    if (ad === bd) return 0;
    if (ad === "") return 1;
    if (bd === "") return -1;
    return ad < bd ? -1 : 1;
  });
  const topChronology = sortedChronology.slice(0, DEFAULT_MAX_CHRONOLOGY);

  // ---- Build legal evidence arrays (bounded) ----------------------------
  // We collect references from issueLinks' relatedLaw + relatedPrecedents
  // (legal authority), and from CaseEvidenceLink records (case-internal
  // evidence). Each gets a synthetic pack id.
  const legislation: LegalEvidence[] = [];
  const cassationCases: LegalEvidence[] = [];
  const constitutionalCases: LegalEvidence[] = [];
  const echrCases: LegalEvidence[] = [];
  const otherEvidence: LegalEvidence[] = [];

  let lIdx = 0; // legislation E1..
  let cIdx = 0; // cassation E1..
  let kIdx = 0; // concourt E1..
  let eIdx = 0; // echr E1..
  let oIdx = 0; // other (case evidence) E1..

  // Map each issueLink's legal authority into the right bucket.
  const issueEvidenceIds = new Map<string, string[]>();
  for (const link of issueLinks) {
    const ids: string[] = [];
    for (const ref of link.relatedLaw) {
      lIdx++;
      const id = `L${lIdx}`;
      legislation.push(refToEvidence(ref, id, "legislation"));
      ids.push(id);
    }
    for (const ref of link.relatedPrecedents) {
      const kind = classifySource(ref.source);
      let id: string;
      if (kind === "cassation") {
        cIdx++;
        id = `C${cIdx}`;
        cassationCases.push(refToEvidence(ref, id, "cassation"));
      } else if (kind === "constitutional") {
        kIdx++;
        id = `K${kIdx}`;
        constitutionalCases.push(refToEvidence(ref, id, "constitutional"));
      } else if (kind === "echr") {
        eIdx++;
        id = `E${eIdx}`;
        echrCases.push(refToEvidence(ref, id, "echr"));
      } else {
        oIdx++;
        id = `O${oIdx}`;
        otherEvidence.push(refToEvidence(ref, id, "other"));
      }
      ids.push(id);
    }
    issueEvidenceIds.set(link.issueId, ids);
  }

  // ---- Add case-internal evidence refs (supporting/contradicting) -------
  // We dedupe by (documentId, page, section) and cap by maxEvidenceItems.
  // We need document display names for the citation labels.
  const documentIds = new Set<string>();
  for (const f of facts) {
    for (const r of f.supportingEvidence) documentIds.add(r.documentId);
    for (const r of f.contradictingEvidence) documentIds.add(r.documentId);
  }
  const documents = documentIds.size
    ? await db.caseDocument.findMany({
        where: { id: { in: [...documentIds] } },
        select: { id: true, displayName: true },
      })
    : [];
  const docName = new Map(documents.map((d) => [d.id, d.displayName]));

  const seenEvidenceKey = new Set<string>();
  let totalEvidenceItems =
    legislation.length +
    cassationCases.length +
    constitutionalCases.length +
    echrCases.length +
    otherEvidence.length;

  function tryAddCaseEvidence(ref: EvidenceRef): string | null {
    if (totalEvidenceItems >= maxEvidenceItems) return null;
    const key = `${ref.documentId}|${ref.page ?? ""}|${ref.section ?? ""}|${ref.quote ?? ""}`;
    if (seenEvidenceKey.has(key)) return null;
    seenEvidenceKey.add(key);
    oIdx++;
    const id = `D${oIdx}`;
    otherEvidence.push(
      caseEvidenceRefToEvidence(ref, id, docName.get(ref.documentId) ?? ref.documentId),
    );
    totalEvidenceItems++;
    return id;
  }

  for (const f of facts) {
    for (const ref of f.supportingEvidence) {
      tryAddCaseEvidence(ref);
    }
    for (const ref of f.contradictingEvidence) {
      tryAddCaseEvidence(ref);
    }
  }

  // ---- Build issues (top N) ----------------------------------------------
  const topIssues = issueLinks.slice(0, maxIssues);
  const issues: CodexLegalIssue[] = topIssues.map((l) =>
    toCodexIssue(l, issueEvidenceIds.get(l.issueId) ?? []),
  );

  // ---- Build chronology with evidence IDs (when applicable) ------------
  const packChronology: CodexChronologyEvent[] = topChronology.map((e) => {
    // Pick the first evidence ref whose document is in the pack.
    const ref = e.evidenceRefs[0];
    let evidenceId: string | undefined;
    if (ref) {
      evidenceId = tryAddCaseEvidence(ref) ?? undefined;
    }
    return toCodexChronology(e, evidenceId);
  });

  // ---- Assemble the pack -------------------------------------------------
  const pack: CaseAnalysisPack = {
    requestId: randomUUID(),
    query: opts.query,
    userFacts,
    chronology: packChronology,
    issues,
    legislation,
    cassationCases,
    constitutionalCases,
    echrCases,
    otherEvidence,
    existingResearch,
  };

  return pack;
}
