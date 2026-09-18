// src/lib/legal-drafting/planning/drafting-context.ts
// Phase 6 §8 — Build a BOUNDED closed DraftingContext.
//
// §8 — NEVER dump the whole case. Selection criteria:
//   - User-selected facts / issues (priority).
//   - Otherwise: VERIFIED + DISPUTED facts (high materiality first), top-N
//     chronology events, all evidence refs (just refs — NOT full document
//     text), legislation / precedents from LegalIssueLink.
//   - Apply config limits (MAX_FACTS_IN_CONTEXT, MAX_CHRONOLOGY_IN_CONTEXT,
//     MAX_EVIDENCE_REFS, MAX_LEGISLATION, MAX_CASSATION_CASES,
//     MAX_CONCOURT_CASES, MAX_ECHR_CASES, MAX_PASSAGES_PER_AUTHORITY,
//     MAX_TOTAL_CONTEXT_CHARS).
//
// §10 — Assigns internal source IDs:
//   F1, F2…        for facts
//   CE1, CE2…       for chronology events
//   L1, L2…         for legislation
//   C1, C2…         for cassation precedents
//   CC1, CC2…       for constitutional-court precedents
//   E1, E2…         for ECHR precedents
//   A1, A2…         for argument-map entries
//
// §11 — Parties, jurisdiction, court, case number are CAPTURED from the
// CaseWorkspace, never invented. If they are missing on the case record,
// they stay null / empty in the context (the planner surfaces them as
// MISSING_INFORMATION).
//
// §14 — The closed-evidence guarantee: the returned SourceIdMap maps internal
// source ids to human-readable citations; the AI NEVER sees the human-readable
// form while drafting (only at export time).

import { db } from "@/lib/db";
import { parseJsonField } from "@/lib/case-workspace/research/types";
import type {
  CaseFact,
  ChronologyEvent,
  EvidenceRef,
  LegalIssueLink,
  LegalReferenceEntry,
} from "@/lib/case-workspace/types";
import {
  MAX_CASSATION_CASES,
  MAX_CHRONOLOGY_IN_CONTEXT,
  MAX_CONCOURT_CASES,
  MAX_ECHR_CASES,
  MAX_EVIDENCE_REFS,
  MAX_FACTS_IN_CONTEXT,
  MAX_LEGISLATION,
  MAX_PASSAGES_PER_AUTHORITY,
  MAX_TOTAL_CONTEXT_CHARS,
} from "../config";
import type {
  DraftingArgumentEntry,
  DraftingCassationCase,
  DraftingChronologyEvent,
  DraftingConCourtCase,
  DraftingContext,
  DraftingEchrCase,
  DraftingEvidenceRef,
  DraftingFact,
  DraftingLegalIssue,
  DraftingLegislation,
  EvidenceRefSummary,
  SourceIdMap,
} from "../types";

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export interface BuildDraftingContextOptions {
  /** User-selected CaseFact ids — these take priority. */
  selectedFactIds?: string[];
  /** User-selected LegalIssueLink.issueId values. */
  selectedIssueIds?: string[];
  /** Override the per-bucket maxima (default = config values). */
  maxItems?: {
    facts?: number;
    chronology?: number;
    evidence?: number;
    legislation?: number;
    cassation?: number;
    concourt?: number;
    echr?: number;
  };
}

export interface BuildDraftingContextResult {
  context: DraftingContext;
  /** §10 — Internal source id → human-readable citation. Export-time only. */
  sourceIdMap: SourceIdMap;
}

// ---------------------------------------------------------------------------
// Materiality ordering (HIGH > MEDIUM > LOW) — reused from case-analysis-pack.
// ---------------------------------------------------------------------------

function materialityRank(m: string): number {
  if (m === "HIGH") return 0;
  if (m === "MEDIUM") return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Loaders (mirrors case-analysis-pack.loadFacts / loadChronology)
// ---------------------------------------------------------------------------

function mapCaseFact(
  r: {
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
    reviewStatus?: string;
    createdAt: Date;
    updatedAt: Date;
  },
): CaseFact {
  return {
    id: r.id,
    caseId: r.caseId,
    proposition: r.proposition,
    category: r.category,
    status: r.status as CaseFact["status"],
    supportingEvidence: parseJsonField<EvidenceRef[]>(
      r.supportingEvidence,
      [],
    ),
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

/** Normalize a CaseFact.status (Phase 5/5.1 namespace) to the Phase 6 FactStatus. */
function normalizeFactStatus(raw: string): DraftingFact["status"] {
  // Phase 5/5.1 uses VERIFIED | ALLEGED | DISPUTED | CONTRADICTED | UNKNOWN.
  // Phase 5.1 adds reviewStatus USER_CONFIRMED. We surface that distinction.
  switch (raw) {
    case "VERIFIED":
      return "DOCUMENT_VERIFIED";
    case "ALLEGED":
      return "ALLEGED";
    case "DISPUTED":
      return "DISPUTED";
    case "CONTRADICTED":
      return "CONTRADICTED";
    case "UNKNOWN":
      return "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

async function loadFacts(
  caseId: string,
  selectedFactIds: string[] | undefined,
): Promise<CaseFact[]> {
  const ids = selectedFactIds ?? [];
  if (ids.length > 0) {
    const rows = await db.caseFact.findMany({
      where: { caseId, id: { in: ids } },
    });
    return rows.map(mapCaseFact);
  }
  // §8 — default: VERIFIED + DISPUTED + USER_CONFIRMED facts, high materiality first.
  const rows = await db.caseFact.findMany({
    where: {
      caseId,
      status: { in: ["VERIFIED", "DISPUTED"] },
    },
  });
  const mapped = rows.map(mapCaseFact);
  // Also include USER_CONFIRMED manual facts that have evidence (§13 —
  // human confirmation ≠ documentary verification, but they ARE serious
  // enough to draft from when documented).
  const manualRows = await db.caseFact.findMany({
    where: {
      caseId,
      status: "ALLEGED",
      reviewStatus: "USER_CONFIRMED",
    },
  });
  const manualMapped = manualRows.map(mapCaseFact);
  return [...mapped, ...manualMapped].sort((a, b) => {
    const mr = materialityRank(a.materiality) - materialityRank(b.materiality);
    if (mr !== 0) return mr;
    return a.proposition.localeCompare(b.proposition);
  });
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
): Promise<
  | {
      argumentMap: DraftingArgumentEntry[];
      missingMaterialFacts: string[];
      counterAuthorities: string[];
    }
  | undefined
> {
  const row = await db.caseAnalysisResult.findFirst({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    select: { analysis: true, status: true },
  });
  if (!row || !row.analysis) return undefined;
  try {
    const parsed = JSON.parse(row.analysis) as {
      argumentMap?: Array<{
        proposition: string;
        supportingAuthorities?: Array<{ evidenceId?: string }>;
        counterAuthorities?: Array<{ evidenceId?: string }>;
        limitations?: string[];
      }>;
      missingMaterialFacts?: string[];
    };
    if (!parsed || typeof parsed !== "object") return undefined;
    const argMap: DraftingArgumentEntry[] = (parsed.argumentMap ?? []).map(
      (e, i) => ({
        sourceId: `A${i + 1}`,
        proposition: e.proposition ?? "",
        supportingAuthorities: (e.supportingAuthorities ?? [])
          .map((s) => s?.evidenceId)
          .filter((s): s is string => typeof s === "string" && s.length > 0),
        counterAuthorities: (e.counterAuthorities ?? [])
          .map((s) => s?.evidenceId)
          .filter((s): s is string => typeof s === "string" && s.length > 0),
        limitations: e.limitations ?? [],
      }),
    );
    return {
      argumentMap: argMap,
      missingMaterialFacts: parsed.missingMaterialFacts ?? [],
      counterAuthorities: [],
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Source-classification helper — map a LegalReferenceEntry.source string to
// our internal taxonomy (legislation / cassation / concourt / echr / other).
// Mirrors case-analysis-pack.classifySource, but here "other" becomes a
// counter-authority slot.
// ---------------------------------------------------------------------------

type AuthorityBucket = "legislation" | "cassation" | "concourt" | "echr";

function classifyAuthority(source: string): AuthorityBucket {
  const s = source.toLowerCase();
  if (s === "arlis" || s === "local-laws" || s.includes("legislation")) {
    return "legislation";
  }
  if (s.includes("hudoc") || s.includes("echr")) return "echr";
  if (s.includes("concourt") || s.includes("constitutional")) {
    return "concourt";
  }
  if (
    s.includes("cassation") ||
    s.includes("judiciary") ||
    s.includes("datalex")
  ) {
    return "cassation";
  }
  // Default to cassation — most Armenian precedents live in datalex.
  return "cassation";
}

// ---------------------------------------------------------------------------
// Build a citation string for a LegalReferenceEntry.
// ---------------------------------------------------------------------------

function refToCitation(ref: LegalReferenceEntry): string {
  const parts: string[] = [];
  if (ref.citation && ref.citation.length > 0) parts.push(ref.citation);
  if (ref.date) parts.push(`(${ref.date})`);
  if (ref.url) parts.push(`— ${ref.url}`);
  return parts.length > 0 ? parts.join(" ") : ref.source;
}

function evidenceRefToSummary(
  ref: EvidenceRef,
  docName?: string,
): EvidenceRefSummary {
  return {
    documentId: ref.documentId,
    page: ref.page,
    section: ref.section,
    quote: ref.quote,
    displayName: docName,
  };
}

// ---------------------------------------------------------------------------
// Build the bounded context.
// ---------------------------------------------------------------------------

export async function buildDraftingContext(
  caseId: string,
  opts: BuildDraftingContextOptions = {},
): Promise<BuildDraftingContextResult> {
  const maxFacts = opts.maxItems?.facts ?? MAX_FACTS_IN_CONTEXT;
  const maxChronology =
    opts.maxItems?.chronology ?? MAX_CHRONOLOGY_IN_CONTEXT;
  const maxEvidence = opts.maxItems?.evidence ?? MAX_EVIDENCE_REFS;
  const maxLegislation = opts.maxItems?.legislation ?? MAX_LEGISLATION;
  const maxCassation = opts.maxItems?.cassation ?? MAX_CASSATION_CASES;
  const maxConcourt = opts.maxItems?.concourt ?? MAX_CONCOURT_CASES;
  const maxEchr = opts.maxItems?.echr ?? MAX_ECHR_CASES;

  // ---- Load case identity (§11 — captured, never invented) ---------------
  const caseRow = await db.caseWorkspace.findUnique({
    where: { id: caseId },
    select: {
      title: true,
      caseNumber: true,
      jurisdiction: true,
      court: true,
      proceedingType: true,
      caseType: true,
    },
  });
  const caseTitle = caseRow?.title ?? null;
  const caseNumber = caseRow?.caseNumber ?? null;
  const jurisdiction = caseRow?.jurisdiction ?? null;
  const court = caseRow?.court ?? null;
  const proceedingType = caseRow?.proceedingType ?? null;
  const caseType = caseRow?.caseType ?? null;

  // §11 — Parties: surface from CaseEntity rows. If none, return [] (planner
  // flags MISSING_INFORMATION — never invented).
  const entityRows = await db.caseEntity.findMany({
    where: { caseId },
    select: { canonicalName: true, type: true, roles: true },
  });
  const parties: string[] = [];
  for (const e of entityRows) {
    const roles = parseJsonField<string[]>(e.roles, []);
    if (
      e.type === "PERSON" ||
      e.type === "COMPANY" ||
      roles.some((r) =>
        ["DEFENDANT", "APPLICANT", "PLAINTIFF", "RESPONDENT", "ACCUSED"].includes(
          r.toUpperCase(),
        ),
      )
    ) {
      parties.push(e.canonicalName);
    }
  }

  // ---- Load facts / issues / chronology / existing analysis ----------------
  const [facts, issueLinks, chronology, existingAnalysis] = await Promise.all([
    loadFacts(caseId, opts.selectedFactIds),
    loadIssueLinks(caseId, opts.selectedIssueIds),
    loadChronology(caseId),
    loadExistingAnalysis(caseId),
  ]);

  // ---- Bound facts (F1…Fn) ------------------------------------------------
  const topFacts = facts.slice(0, maxFacts);
  const factIdToSource = new Map<string, string>();
  const factSourceToId = new Map<string, string>();
  topFacts.forEach((f, i) => {
    const sid = `F${i + 1}`;
    factIdToSource.set(f.id, sid);
    factSourceToId.set(sid, f.id);
  });

  // ---- Bound chronology (CE1…) -------------------------------------------
  const sortedChronology = [...chronology].sort((a, b) => {
    const ad = a.date ?? "";
    const bd = b.date ?? "";
    if (ad === bd) return 0;
    if (ad === "") return 1;
    if (bd === "") return -1;
    return ad < bd ? -1 : 1;
  });
  const topChronology = sortedChronology.slice(0, maxChronology);
  const eventToSource = new Map<string, string>();
  topChronology.forEach((e, i) => {
    eventToSource.set(e.id, `CE${i + 1}`);
  });

  // ---- Build evidence refs map (only refs, NOT full document text) -------
  const documentIds = new Set<string>();
  for (const f of topFacts) {
    for (const r of f.supportingEvidence) {
      if (r.documentId) documentIds.add(r.documentId);
    }
    for (const r of f.contradictingEvidence) {
      if (r.documentId) documentIds.add(r.documentId);
    }
  }
  for (const e of topChronology) {
    for (const r of e.evidenceRefs) {
      if (r.documentId) documentIds.add(r.documentId);
    }
  }
  for (const l of issueLinks) {
    for (const r of l.evidenceRefs) {
      if (r.documentId) documentIds.add(r.documentId);
    }
  }
  const documents = documentIds.size
    ? await db.caseDocument.findMany({
        where: { id: { in: [...documentIds] } },
        select: { id: true, displayName: true },
      })
    : [];
  const docName = new Map(documents.map((d) => [d.id, d.displayName]));

  // Collect evidence refs (dedupe by documentId|page|quote).
  const seenEvidenceKey = new Set<string>();
  const evidenceRefs: DraftingEvidenceRef[] = [];
  const refKeyToSource = new Map<string, string>();

  function tryAddEvidenceRef(
    ref: EvidenceRef,
    relation?: string,
    strength?: string,
  ): string | null {
    if (evidenceRefs.length >= maxEvidence) return null;
    const key = `${ref.documentId ?? ""}|${ref.page ?? ""}|${ref.section ?? ""}|${ref.quote ?? ""}`;
    if (refKeyToSource.has(key)) return refKeyToSource.get(key) ?? null;
    if (seenEvidenceKey.has(key)) return null;
    seenEvidenceKey.add(key);
    const sid = `D${evidenceRefs.length + 1}`;
    evidenceRefs.push({
      sourceId: sid,
      documentId: ref.documentId,
      page: ref.page,
      section: ref.section,
      quote: ref.quote,
      displayName: ref.documentId
        ? docName.get(ref.documentId)
        : undefined,
      relation,
      strength,
    });
    refKeyToSource.set(key, sid);
    return sid;
  }

  // Walk all sources of evidence refs.
  for (const f of topFacts) {
    for (const ref of f.supportingEvidence) {
      tryAddEvidenceRef(ref, "SUPPORTS", "DIRECT");
    }
    for (const ref of f.contradictingEvidence) {
      tryAddEvidenceRef(ref, "CONTRADICTS", "DIRECT");
    }
  }
  for (const e of topChronology) {
    for (const ref of e.evidenceRefs) {
      tryAddEvidenceRef(ref, "CONTEXT", "INDIRECT");
    }
  }
  for (const l of issueLinks) {
    for (const ref of l.evidenceRefs) {
      tryAddEvidenceRef(ref, "CONTEXT", "INDIRECT");
    }
  }

  // ---- Build legislation / cassation / concourt / echr buckets -----------
  const legislation: DraftingLegislation[] = [];
  const cassationCases: DraftingCassationCase[] = [];
  const conCourtCases: DraftingConCourtCase[] = [];
  const echrCases: DraftingEchrCase[] = [];
  const counterAuthorities: string[] = [];
  const distinguishing: Record<string, string[]> = {};

  // Track sourceIds per issue for the legalIssues payload.
  const issueLegislation: Record<string, string[]> = {};
  const issuePrecedents: Record<string, string[]> = {};

  for (const link of issueLinks) {
    const legIds: string[] = [];
    for (const ref of link.relatedLaw) {
      if (legislation.length >= maxLegislation) break;
      const passages = (ref.passages ?? [])
        .filter((p) => p && p.length > 0)
        .slice(0, MAX_PASSAGES_PER_AUTHORITY);
      const sid = `L${legislation.length + 1}`;
      legislation.push({
        sourceId: sid,
        source: ref.source,
        citation: ref.citation,
        url: ref.url,
        date: ref.date,
        passages,
        applicability: ref.applicability,
      });
      legIds.push(sid);
    }
    const precIds: string[] = [];
    for (const ref of link.relatedPrecedents) {
      const bucket = classifyAuthority(ref.source);
      const passages = (ref.passages ?? [])
        .filter((p) => p && p.length > 0)
        .slice(0, MAX_PASSAGES_PER_AUTHORITY);
      let sid: string;
      if (bucket === "legislation") {
        if (legislation.length >= maxLegislation) continue;
        sid = `L${legislation.length + 1}`;
        legislation.push({
          sourceId: sid,
          source: ref.source,
          citation: ref.citation,
          url: ref.url,
          date: ref.date,
          passages,
          applicability: ref.applicability,
        });
      } else if (bucket === "cassation") {
        if (cassationCases.length >= maxCassation) continue;
        sid = `C${cassationCases.length + 1}`;
        cassationCases.push({
          sourceId: sid,
          source: ref.source,
          citation: ref.citation,
          url: ref.url,
          date: ref.date,
          passages,
          applicability: ref.applicability,
          distinguishingFactors:
            ref.applicability &&
            ref.applicability.toUpperCase().includes("DISTINCTION")
              ? [ref.applicability]
              : [],
        });
      } else if (bucket === "concourt") {
        if (conCourtCases.length >= maxConcourt) continue;
        sid = `CC${conCourtCases.length + 1}`;
        conCourtCases.push({
          sourceId: sid,
          source: ref.source,
          citation: ref.citation,
          url: ref.url,
          date: ref.date,
          passages,
          applicability: ref.applicability,
          distinguishingFactors:
            ref.applicability &&
            ref.applicability.toUpperCase().includes("DISTINCTION")
              ? [ref.applicability]
              : [],
        });
      } else {
        if (echrCases.length >= maxEchr) continue;
        sid = `E${echrCases.length + 1}`;
        echrCases.push({
          sourceId: sid,
          source: ref.source,
          citation: ref.citation,
          url: ref.url,
          date: ref.date,
          passages,
          applicability: ref.applicability,
          distinguishingFactors:
            ref.applicability &&
            ref.applicability.toUpperCase().includes("DISTINCTION")
              ? [ref.applicability]
              : [],
        });
      }
      precIds.push(sid);
      if (
        ref.applicability &&
        ref.applicability.toUpperCase().includes("DISTINCTION")
      ) {
        distinguishing[sid] = distinguishing[sid] ?? [];
        distinguishing[sid].push(ref.applicability);
      }
    }
    issueLegislation[link.issueId] = legIds;
    issuePrecedents[link.issueId] = precIds;
  }

  // ---- Build legal issues payload ----------------------------------------
  const legalIssues: DraftingLegalIssue[] = issueLinks.map((link) => ({
    issueId: link.issueId,
    issueStatement: link.issueStatement,
    factSourceIds: link.factIds
      .map((fid) => factIdToSource.get(fid))
      .filter((s): s is string => typeof s === "string"),
    legislationSourceIds: issueLegislation[link.issueId] ?? [],
    precedentSourceIds: issuePrecedents[link.issueId] ?? [],
  }));

  // ---- Build drafting facts (with summarized evidence refs) -------------
  const draftingFacts: DraftingFact[] = topFacts.map((f) => {
    const sourceId = factIdToSource.get(f.id) ?? "F0";
    return {
      sourceId,
      factId: f.id,
      proposition: f.proposition,
      status: normalizeFactStatus(f.status),
      materiality: f.materiality,
      category: f.category,
      supportingEvidence: f.supportingEvidence.map((r) =>
        evidenceRefToSummary(
          r,
          r.documentId ? docName.get(r.documentId) : undefined,
        ),
      ),
      contradictingEvidence: f.contradictingEvidence.map((r) =>
        evidenceRefToSummary(
          r,
          r.documentId ? docName.get(r.documentId) : undefined,
        ),
      ),
    };
  });

  // ---- Build drafting chronology -----------------------------------------
  const draftingChronology: DraftingChronologyEvent[] = topChronology.map(
    (e) => ({
      sourceId: eventToSource.get(e.id) ?? "CE0",
      eventId: e.id,
      date: e.date,
      originalDateText: e.originalDateText,
      dateStatus: e.dateStatus,
      eventType: e.eventType,
      title: e.title,
      description: e.description,
      participants: e.participants,
      verification: e.verification,
      hasConflict: e.hasConflict,
      conflictDetail: e.conflictDetail,
      evidenceRefs: e.evidenceRefs.map((r) =>
        evidenceRefToSummary(
          r,
          r.documentId ? docName.get(r.documentId) : undefined,
        ),
      ),
    }),
  );

  // ---- Argument map + missing material facts ----------------------------
  const argumentMap: DraftingArgumentEntry[] =
    existingAnalysis?.argumentMap ?? [];
  const missingMaterialFacts: string[] =
    existingAnalysis?.missingMaterialFacts ?? [];

  // ---- Build SourceIdMap (export-time citations) -------------------------
  const sourceIdMap: SourceIdMap = {};

  for (const f of draftingFacts) {
    sourceIdMap[f.sourceId] = {
      type: "fact",
      refId: f.factId,
      citation: f.proposition.slice(0, 200),
    };
  }
  for (const e of draftingChronology) {
    sourceIdMap[e.sourceId] = {
      type: "chronology",
      refId: e.eventId,
      citation: `${e.date ?? e.originalDateText ?? "(ամսաթիվը բացակայում է)"} — ${e.title}`,
    };
  }
  for (const e of evidenceRefs) {
    sourceIdMap[e.sourceId] = {
      type: "evidence",
      refId: e.documentId ?? e.sourceId,
      citation: e.displayName
        ? `${e.displayName}${e.page ? `, էջ ${e.page}` : ""}`
        : e.documentId ?? e.sourceId,
    };
  }
  for (const l of legislation) {
    sourceIdMap[l.sourceId] = {
      type: "legislation",
      refId: l.citation,
      citation: refToCitation({
        source: l.source,
        citation: l.citation,
        url: l.url,
        date: l.date,
      }),
      url: l.url,
    };
  }
  for (const c of cassationCases) {
    sourceIdMap[c.sourceId] = {
      type: "cassation",
      refId: c.citation,
      citation: refToCitation({
        source: c.source,
        citation: c.citation,
        url: c.url,
        date: c.date,
      }),
      url: c.url,
    };
  }
  for (const c of conCourtCases) {
    sourceIdMap[c.sourceId] = {
      type: "concourt",
      refId: c.citation,
      citation: refToCitation({
        source: c.source,
        citation: c.citation,
        url: c.url,
        date: c.date,
      }),
      url: c.url,
    };
  }
  for (const e of echrCases) {
    sourceIdMap[e.sourceId] = {
      type: "echr",
      refId: e.citation,
      citation: refToCitation({
        source: e.source,
        citation: e.citation,
        url: e.url,
        date: e.date,
      }),
      url: e.url,
    };
  }
  for (const a of argumentMap) {
    sourceIdMap[a.sourceId] = {
      type: "argument",
      refId: a.sourceId,
      citation: a.proposition.slice(0, 200),
    };
  }

  // ---- Construct context + measure character budget ----------------------
  const context: DraftingContext = {
    caseId,
    parties,
    jurisdiction,
    court,
    caseNumber,
    caseTitle,
    caseType,
    proceedingType,
    facts: draftingFacts,
    chronology: draftingChronology,
    evidenceRefs,
    legalIssues,
    legislation,
    cassationCases,
    conCourtCases,
    echrCases,
    distinguishing,
    counterAuthorities,
    argumentMap,
    missingMaterialFacts,
    totalChars: 0,
    truncated: false,
  };

  // §8 — measure total character budget. If we exceed the cap, mark truncated
  // (we don't truncate the in-memory object — the AI drafter gets a JSON dump
  // and the cap is enforced by the prompt builder / exporter that follows).
  const serialized = JSON.stringify(context);
  context.totalChars = serialized.length;
  context.truncated = context.totalChars > MAX_TOTAL_CONTEXT_CHARS;

  return { context, sourceIdMap };
}
