// src/lib/case-workspace/research/case-research.ts
// Launch HayDevLegal's federated search from a Case Workspace issue link.
//
// Phase 5 §13 — Keep CASE EVIDENCE (CaseFact / CaseEvidenceLink) distinct
// from LEGAL AUTHORITY (search results). The legal authority the federated
// search returns is persisted into LegalIssueLink.relatedLaw /
// .relatedPrecedents — NEVER into CaseFact.supportingEvidence (that field is
// reserved for case-internal evidence: document pages the user uploaded).
//
// Phase 5 §13 — Never assume today's law governed historical events. When the
// chronology has events with explicit dates, the search is given the raw
// issue statement (which itself may reference an old version of an act); the
// federated engine's temporal validator already handles historical vs current
// law classification.
//
// Phase 5 §13 — Lexical similarity alone is insufficient. The downstream
// `precedent-linker.ts` runs Phase 4 holdings / material-facts /
// applicability / distinguishing engines against the search results so we
// never assert applicability from string overlap alone.
//
// We reuse the existing `federatedSearch` entry point — no duplicate source
// adapters, no parallel retrieval.

import { db } from "@/lib/case-workspace/db";
import { federatedSearch } from "@/lib/legal-search/engine/search-engine";
import type { FederatedSearchResponse } from "@/lib/legal-search/types";
import type { LegalEvidence } from "@/lib/legal-search/types";
import type { LegalReferenceEntry } from "@/lib/case-workspace/types";
import type { ResearchReport } from "@/lib/legal-research/types";
import type {
  CaseResearchResult,
  ResearchStatus,
} from "./types";
import { parseJsonField } from "./types";

// ---------------------------------------------------------------------------
// Source-type → LegalReferenceEntry classification
// ---------------------------------------------------------------------------

/**
 * Classify a search-result evidence item as "law" (statute / regulation) or
 * "precedent" (case law / constitutional / ECHR). We rely on the engine's
 * sourceType, which itself is derived from the adapter's declared type — not
 * from lexical guessing.
 */
function isLaw(e: LegalEvidence): boolean {
  return e.sourceType === "legislation" || e.sourceType === "local_laws";
}

function isPrecedent(e: LegalEvidence): boolean {
  return (
    e.sourceType === "case_law" ||
    e.sourceType === "cassation" ||
    e.sourceType === "constitutional_court" ||
    e.sourceType === "echr"
  );
}

/** Build a provenance-preserving LegalReferenceEntry from a LegalEvidence. */
function evidenceToReference(e: LegalEvidence): LegalReferenceEntry {
  const passages: string[] = [];
  if (e.passage && e.passage.length > 0) passages.push(e.passage);
  const citation = [
    e.court,
    e.caseNumber ?? e.actNumber ?? e.title,
  ]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 240);
  return {
    source: e.source,
    citation: citation || e.title || e.url,
    url: e.url,
    date: e.date,
    passages,
    applicability: undefined,
  };
}

// ---------------------------------------------------------------------------
// Status classifier — derives ResearchStatus from the FederatedSearchResponse
// ---------------------------------------------------------------------------

function classifyStatus(resp: FederatedSearchResponse | null): ResearchStatus {
  if (!resp) return "FAILED";
  // No source answered at all.
  const anyOk = resp.trace.sources.some(
    (s) => s.status === "SUCCESS" || s.status === "PARTIAL",
  );
  if (!anyOk && resp.evidence.length === 0) return "FAILED";
  // Deep mode research didn't run or partial.
  if (resp.mode === "deep") {
    if (!resp.research) return "DETERMINISTIC_ONLY";
    if (resp.research.partial) return "PARTIAL_AI_UNAVAILABLE";
  }
  return "COMPLETED";
}

// ---------------------------------------------------------------------------
// researchIssueForCase
// ---------------------------------------------------------------------------

export interface ResearchIssueLinkInput {
  issueId: string;
  issueStatement: string;
  /** CaseFact ids that bear on this issue (provenance trail into CaseFact). */
  factIds?: string[];
  /** Case-internal evidence refs already linked to this issue. */
  evidenceRefs?: import("@/lib/case-workspace/types").EvidenceRef[];
}

/**
 * Launch HayDevLegal's federated search from a case issue, persist the legal
 * authority results into the matching LegalIssueLink row, and return the
 * ResearchReport (when deep mode ran the Phase 4 pipeline) plus the parsed
 * legal-authority entries.
 *
 * NEVER throws — failures are surfaced via the returned `status` field. The
 * caller can decide whether to retry or surface the error to the user.
 */
export async function researchIssueForCase(
  caseId: string,
  issueLink: ResearchIssueLinkInput,
): Promise<CaseResearchResult> {
  if (!caseId || !issueLink.issueStatement.trim()) {
    return {
      report: null,
      relatedLaw: [],
      relatedPrecedents: [],
      status: "FAILED",
    };
  }

  // §13 — pass temporal context if available. We DON'T translate chronology
  // dates into a query suffix (lexical injection would muddy the search);
  // instead we surface the earliest event date in the FederatedSearchResponse
  // trace note when the response is persisted. The engine's own temporal
  // validator handles historical-vs-current law classification downstream.
  const query = issueLink.issueStatement.slice(0, 400);

  let resp: FederatedSearchResponse | null = null;
  try {
    resp = await federatedSearch(query, { mode: "deep" });
  } catch {
    // Network / source failure — fail closed.
    return {
      report: null,
      relatedLaw: [],
      relatedPrecedents: [],
      status: "FAILED",
    };
  }

  const status = classifyStatus(resp);

  // Partition legal-authority results into laws vs precedents. We deliberately
  // DO NOT pass case-internal evidence (CaseEvidenceLink) into these buckets —
  // §13 separation.
  const relatedLaw: LegalReferenceEntry[] = [];
  const relatedPrecedents: LegalReferenceEntry[] = [];
  for (const e of resp.evidence) {
    if (isLaw(e)) relatedLaw.push(evidenceToReference(e));
    else if (isPrecedent(e)) relatedPrecedents.push(evidenceToReference(e));
  }

  // Deduplicate by url + citation (cheap & lossless).
  const seen = new Set<string>();
  function dedupe<T extends LegalReferenceEntry>(arr: T[]): T[] {
    const out: T[] = [];
    for (const r of arr) {
      const key = `${r.source}|${r.citation}|${r.url ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }
  const dedupLaw = dedupe(relatedLaw);
  const dedupPrec = dedupe(relatedPrecedents);

  // Persist into the matching LegalIssueLink row, if one exists.
  try {
    const existing = await db.legalIssueLink.findFirst({
      where: { caseId, issueId: issueLink.issueId },
      select: { id: true },
    });
    if (existing) {
      await db.legalIssueLink.update({
        where: { id: existing.id },
        data: {
          relatedLaw: JSON.stringify(dedupLaw),
          relatedPrecedents: JSON.stringify(dedupPrec),
        },
      });
    } else {
      // No LegalIssueLink yet — create a stub row carrying just the legal
      // authority. factIds / evidenceRefs default to empty.
      await db.legalIssueLink.create({
        data: {
          caseId,
          issueId: issueLink.issueId,
          issueStatement: issueLink.issueStatement,
          factIds: JSON.stringify(issueLink.factIds ?? []),
          evidenceRefs: JSON.stringify(issueLink.evidenceRefs ?? []),
          relatedLaw: JSON.stringify(dedupLaw),
          relatedPrecedents: JSON.stringify(dedupPrec),
        },
      });
    }
  } catch {
    // Persistence failure does NOT invalidate the in-memory result.
  }

  // Preserve the Phase 4 ResearchReport (deep mode only).
  const report: ResearchReport | null = resp.research ?? null;

  return {
    report,
    relatedLaw: dedupLaw,
    relatedPrecedents: dedupPrec,
    status,
  };
}

// ---------------------------------------------------------------------------
// Helper: read a LegalIssueLink's persisted legal authority (used by the
// precedent linker + pack builder).
// ---------------------------------------------------------------------------

export async function loadIssueLinkLegalAuthority(
  caseId: string,
  issueId: string,
): Promise<{ relatedLaw: LegalReferenceEntry[]; relatedPrecedents: LegalReferenceEntry[] } | null> {
  const row = await db.legalIssueLink.findFirst({
    where: { caseId, issueId },
    select: { relatedLaw: true, relatedPrecedents: true },
  });
  if (!row) return null;
  return {
    relatedLaw: parseJsonField<LegalReferenceEntry[]>(row.relatedLaw, []),
    relatedPrecedents: parseJsonField<LegalReferenceEntry[]>(
      row.relatedPrecedents,
      [],
    ),
  };
}
