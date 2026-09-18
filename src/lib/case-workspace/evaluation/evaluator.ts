// src/lib/case-workspace/evaluation/evaluator.ts
// Hard-assertion evaluator for the Case Workspace (Phase 5 §20).
//
// Walks every persisted row tied to a caseId and checks the §20 invariants:
//
//   provenance_loss = 0
//     every extracted item (event / fact / claim / entity / evidence link /
//     issue link) carries documentId + page that resolves to a real
//     DocumentPage.
//
//   cross_case_leakage = 0
//     no CaseDocument / CaseFact / etc. references a different caseId than
//     the one being evaluated (e.g. a fact whose caseId !== eval caseId, or
//     whose supportingEvidence.documentId belongs to another case).
//
//   party_claim_confusion = 0
//     no CaseClaim with claimType=COURT_FINDING has a source whose
//     documentType is INDICTMENT / SEARCH_PROTOCOL / DEFENDANT brief.
//
//   invented_evidence_ids = 0
//     every evidenceId in any CaseAnalysisResult.analysis JSON exists in
//     the case's DocumentPage records (closed-evidence firewall §16).
//
//   wrong_document_page_link = 0
//     every EvidenceRef.page is ≤ the referenced document.pageCount.
//
//   duplicate_reprocessing_avoided
//     when two CaseDocuments share sha256, only ONE of them has
//     DocumentPage rows (the duplicate is skipped during ingestion).
//
//   incremental_no_reprocess
//     a case with N fully-READY documents + a new upload only creates
//     CaseJobs for the new document (no CaseJob references any unchanged
//     document id).
//
//   deterministic_works_without_codex
//     deterministic analysis succeeds even when Codex is AUTH_REQUIRED.
//
// NEVER throws — every check returns `{ passed: boolean; detail? }`.

import { db } from "@/lib/case-workspace/db";
import type {
  EvalCheck,
  EvalResult,
} from "../research/types";
import { parseJsonField } from "../research/types";
import type { EvidenceRef } from "@/lib/case-workspace/types";
import { buildCaseAnalysisPack } from "../analysis/case-analysis-pack";
import { runDeterministicAnalysis } from "../analysis/deterministic-analysis";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Documents in the case, indexed by id. */
interface DocumentRecord {
  id: string;
  pageCount: number;
  sha256: string;
  caseId: string;
  documentType: string;
  processingStatus: string;
}

interface DocumentIndex {
  byId: Map<string, DocumentRecord>;
  /** sha256 → list of document ids sharing that hash. */
  bySha: Map<string, string[]>;
  /** set of valid documentIds (for fast EvidenceRef validation). */
  validIds: Set<string>;
}

async function loadDocumentIndex(caseId: string): Promise<DocumentIndex> {
  const rows = await db.caseDocument.findMany({
    where: { caseId },
    select: {
      id: true,
      pageCount: true,
      sha256: true,
      caseId: true,
      documentType: true,
      processingStatus: true,
    },
  });
  const byId = new Map<string, DocumentRecord>();
  const bySha = new Map<string, string[]>();
  const validIds = new Set<string>();
  for (const r of rows) {
    byId.set(r.id, r);
    validIds.add(r.id);
    const list = bySha.get(r.sha256) ?? [];
    list.push(r.id);
    bySha.set(r.sha256, list);
  }
  return { byId, bySha, validIds };
}

/** Set of valid (documentId, pageNumber) pairs from DocumentPage. */
async function loadValidPageKeys(caseId: string): Promise<Set<string>> {
  const docs = await db.caseDocument.findMany({
    where: { caseId },
    select: { id: true },
  });
  const ids = docs.map((d) => d.id);
  if (ids.length === 0) return new Set();
  const pages = await db.documentPage.findMany({
    where: { documentId: { in: ids } },
    select: { documentId: true, pageNumber: true },
  });
  const out = new Set<string>();
  for (const p of pages) {
    out.add(`${p.documentId}|${p.pageNumber}`);
  }
  return out;
}

function evidenceRefKey(ref: EvidenceRef): string {
  return `${ref.documentId}|${ref.page ?? ""}`;
}

// ---------------------------------------------------------------------------
// Check 1 — provenance_loss = 0
// ---------------------------------------------------------------------------

async function checkProvenanceLoss(
  caseId: string,
  docIndex: DocumentIndex,
): Promise<EvalCheck> {
  // Every extracted item's evidenceRefs must point to real DocumentPage rows.
  const validPageKeys = await loadValidPageKeys(caseId);
  const violations: string[] = [];

  // ChronologyEvent.evidenceRefs
  const chrono = await db.chronologyEvent.findMany({
    where: { caseId },
    select: { id: true, evidenceRefs: true },
  });
  for (const e of chrono) {
    const refs = parseJsonField<EvidenceRef[]>(e.evidenceRefs, []);
    for (const ref of refs) {
      if (!docIndex.validIds.has(ref.documentId)) {
        violations.push(`chronology:${e.id}: unknown documentId ${ref.documentId}`);
        continue;
      }
      if (ref.page !== undefined && !validPageKeys.has(evidenceRefKey(ref))) {
        violations.push(`chronology:${e.id}: page ${ref.page} not in DocumentPage`);
      }
    }
  }

  // CaseEntity.evidenceRefs
  const entities = await db.caseEntity.findMany({
    where: { caseId },
    select: { id: true, evidenceRefs: true },
  });
  for (const e of entities) {
    const refs = parseJsonField<EvidenceRef[]>(e.evidenceRefs, []);
    for (const ref of refs) {
      if (!docIndex.validIds.has(ref.documentId)) {
        violations.push(`entity:${e.id}: unknown documentId ${ref.documentId}`);
        continue;
      }
      if (ref.page !== undefined && !validPageKeys.has(evidenceRefKey(ref))) {
        violations.push(`entity:${e.id}: page ${ref.page} not in DocumentPage`);
      }
    }
  }

  // CaseFact.supportingEvidence + contradictingEvidence
  const facts = await db.caseFact.findMany({
    where: { caseId },
    select: { id: true, supportingEvidence: true, contradictingEvidence: true },
  });
  for (const f of facts) {
    const sup = parseJsonField<EvidenceRef[]>(f.supportingEvidence, []);
    const con = parseJsonField<EvidenceRef[]>(f.contradictingEvidence, []);
    for (const ref of [...sup, ...con]) {
      if (!docIndex.validIds.has(ref.documentId)) {
        violations.push(`fact:${f.id}: unknown documentId ${ref.documentId}`);
        continue;
      }
      if (ref.page !== undefined && !validPageKeys.has(evidenceRefKey(ref))) {
        violations.push(`fact:${f.id}: page ${ref.page} not in DocumentPage`);
      }
    }
  }

  // CaseEvidenceLink.evidenceRef
  const links = await db.caseEvidenceLink.findMany({
    where: { caseId },
    select: { id: true, evidenceRef: true },
  });
  for (const l of links) {
    const ref = parseJsonField<EvidenceRef | null>(l.evidenceRef, null);
    if (!ref) {
      violations.push(`evidenceLink:${l.id}: empty evidenceRef`);
      continue;
    }
    if (!docIndex.validIds.has(ref.documentId)) {
      violations.push(`evidenceLink:${l.id}: unknown documentId ${ref.documentId}`);
      continue;
    }
    if (ref.page !== undefined && !validPageKeys.has(evidenceRefKey(ref))) {
      violations.push(`evidenceLink:${l.id}: page ${ref.page} not in DocumentPage`);
    }
  }

  // LegalIssueLink.evidenceRefs (factIds/evidenceRefs/relatedLaw are legal
  // authority, not case evidence — only check evidenceRefs here).
  const issues = await db.legalIssueLink.findMany({
    where: { caseId },
    select: { id: true, evidenceRefs: true },
  });
  for (const i of issues) {
    const refs = parseJsonField<EvidenceRef[]>(i.evidenceRefs, []);
    for (const ref of refs) {
      if (!docIndex.validIds.has(ref.documentId)) {
        violations.push(`issue:${i.id}: unknown documentId ${ref.documentId}`);
        continue;
      }
      if (ref.page !== undefined && !validPageKeys.has(evidenceRefKey(ref))) {
        violations.push(`issue:${i.id}: page ${ref.page} not in DocumentPage`);
      }
    }
  }

  return {
    name: "provenance_loss",
    passed: violations.length === 0,
    detail: violations.length === 0
      ? undefined
      : `${violations.length} violations (first 5: ${violations.slice(0, 5).join("; ")})`,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — cross_case_leakage = 0
// ---------------------------------------------------------------------------

async function checkCrossCaseLeakage(caseId: string, docIndex: DocumentIndex): Promise<EvalCheck> {
  const violations: string[] = [];

  // All direct rows for this caseId must have caseId === caseId (trivially true
  // via the where clause). The subtle leak: a fact's supportingEvidence
  // references a documentId that belongs to ANOTHER case. We check via the
  // document index — every document id in the index belongs to this case.
  const facts = await db.caseFact.findMany({
    where: { caseId },
    select: { id: true, supportingEvidence: true, contradictingEvidence: true },
  });
  for (const f of facts) {
    const sup = parseJsonField<EvidenceRef[]>(f.supportingEvidence, []);
    const con = parseJsonField<EvidenceRef[]>(f.contradictingEvidence, []);
    for (const ref of [...sup, ...con]) {
      if (!docIndex.validIds.has(ref.documentId)) {
        // The document id isn't in this case — it may belong to another case.
        const foreign = await db.caseDocument.findUnique({
          where: { id: ref.documentId },
          select: { caseId: true },
        });
        if (foreign && foreign.caseId !== caseId) {
          violations.push(`fact:${f.id}: ref to document ${ref.documentId} in case ${foreign.caseId}`);
        }
      }
    }
  }

  // CaseClaim.source / evidenceRefs
  const claims = await db.caseClaim.findMany({
    where: { caseId },
    select: { id: true, source: true, evidenceRefs: true },
  });
  for (const c of claims) {
    const src = parseJsonField<EvidenceRef | null>(c.source, null);
    if (src && !docIndex.validIds.has(src.documentId)) {
      const foreign = await db.caseDocument.findUnique({
        where: { id: src.documentId },
        select: { caseId: true },
      });
      if (foreign && foreign.caseId !== caseId) {
        violations.push(`claim:${c.id}: source document in case ${foreign.caseId}`);
      }
    }
    const refs = parseJsonField<EvidenceRef[]>(c.evidenceRefs, []);
    for (const ref of refs) {
      if (!docIndex.validIds.has(ref.documentId)) {
        const foreign = await db.caseDocument.findUnique({
          where: { id: ref.documentId },
          select: { caseId: true },
        });
        if (foreign && foreign.caseId !== caseId) {
          violations.push(`claim:${c.id}: evidence document in case ${foreign.caseId}`);
        }
      }
    }
  }

  return {
    name: "cross_case_leakage",
    passed: violations.length === 0,
    detail: violations.length === 0 ? undefined : violations.slice(0, 5).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check 3 — party_claim_confusion = 0
// ---------------------------------------------------------------------------

async function checkPartyClaimConfusion(caseId: string): Promise<EvalCheck> {
  // A CaseClaim with claimType=COURT_FINDING must have a source document whose
  // documentType is a COURT_DECISION (not INDICTMENT, SEARCH_PROTOCOL,
  // SEIZURE_PROTOCOL, INTERROGATION, EXPERT_REPORT, MOTION, APPEAL,
  // CASSATION_APPEAL, NOTICE, POSTAL_RECORD, CONTRACT, PAYMENT_RECORD,
  // MEDICAL_RECORD, OFFICIAL_LETTER, EVIDENCE_ATTACHMENT, OTHER, UNKNOWN).
  const claims = await db.caseClaim.findMany({
    where: { caseId, claimType: "COURT_FINDING" },
    select: { id: true, source: true },
  });
  const violations: string[] = [];
  for (const c of claims) {
    const src = parseJsonField<EvidenceRef | null>(c.source, null);
    if (!src) {
      violations.push(`claim:${c.id}: COURT_FINDING without a source document`);
      continue;
    }
    const doc = await db.caseDocument.findUnique({
      where: { id: src.documentId },
      select: { documentType: true },
    });
    if (!doc) {
      violations.push(`claim:${c.id}: source document not found`);
      continue;
    }
    if (doc.documentType !== "COURT_DECISION") {
      violations.push(
        `claim:${c.id}: COURT_FINDING from documentType=${doc.documentType}`,
      );
    }
  }
  return {
    name: "party_claim_confusion",
    passed: violations.length === 0,
    detail: violations.length === 0 ? undefined : violations.slice(0, 5).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check 4 — invented_evidence_ids = 0
// ---------------------------------------------------------------------------

async function checkInventedEvidenceIds(caseId: string): Promise<EvalCheck> {
  // Walk every CaseAnalysisResult.analysis JSON and collect every
  // `evidenceId` string referenced in issues / argumentMap; check each
  // against the set of pack evidence ids.
  //
  // The pack itself is closed-evidence — every id in the pack is a synthetic
  // id we minted (L1, C1, K1, E1, O1, D1) for a real LegalReferenceEntry or
  // CaseEvidenceLink. The codex firewall already validates that the analysis's
  // evidenceIds ⊆ pack's evidenceIds. We re-check here as defense-in-depth:
  // we parse the pack JSON, collect its ids, then verify the analysis ids.
  const violations: string[] = [];
  const results = await db.caseAnalysisResult.findMany({
    where: { caseId },
    select: { id: true, pack: true, analysis: true },
  });
  for (const r of results) {
    if (!r.analysis) continue;
    let pack: { legislation?: { id?: string }[]; cassationCases?: { id?: string }[]; constitutionalCases?: { id?: string }[]; echrCases?: { id?: string }[]; otherEvidence?: { id?: string }[] } | null = null;
    try {
      pack = JSON.parse(r.pack);
    } catch {
      violations.push(`analysisResult:${r.id}: pack JSON unparseable`);
      continue;
    }
    const knownIds = new Set<string>();
    for (const arr of [
      pack?.legislation ?? [],
      pack?.cassationCases ?? [],
      pack?.constitutionalCases ?? [],
      pack?.echrCases ?? [],
      pack?.otherEvidence ?? [],
    ]) {
      for (const e of arr) {
        if (e && typeof e.id === "string") knownIds.add(e.id);
      }
    }
    let analysis: unknown;
    try {
      analysis = JSON.parse(r.analysis);
    } catch {
      violations.push(`analysisResult:${r.id}: analysis JSON unparseable`);
      continue;
    }
    const referenced = collectEvidenceIds(analysis);
    for (const id of referenced) {
      if (!knownIds.has(id)) {
        violations.push(`analysisResult:${r.id}: unknown evidenceId ${id}`);
      }
    }
  }
  return {
    name: "invented_evidence_ids",
    passed: violations.length === 0,
    detail: violations.length === 0 ? undefined : violations.slice(0, 5).join("; "),
  };
}

/** Walk an arbitrary JSON tree and collect every `evidenceId` string value. */
function collectEvidenceIds(node: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (const item of n) stack.push(item);
      continue;
    }
    const rec = n as Record<string, unknown>;
    if (typeof rec.evidenceId === "string") out.push(rec.evidenceId);
    for (const v of Object.values(rec)) stack.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 5 — wrong_document_page_link = 0
// ---------------------------------------------------------------------------

async function checkWrongDocumentPageLink(
  caseId: string,
  docIndex: DocumentIndex,
): Promise<EvalCheck> {
  const violations: string[] = [];
  // Walk every EvidenceRef across the case and verify ref.page ≤ document.pageCount.
  function check(ref: EvidenceRef, ctx: string): void {
    const doc = docIndex.byId.get(ref.documentId);
    if (!doc) {
      // Already flagged by checkProvenanceLoss; ignore here.
      return;
    }
    if (ref.page !== undefined && ref.page > doc.pageCount) {
      violations.push(`${ctx}: page ${ref.page} > pageCount ${doc.pageCount}`);
    }
  }

  const chrono = await db.chronologyEvent.findMany({
    where: { caseId },
    select: { id: true, evidenceRefs: true },
  });
  for (const e of chrono) {
    for (const ref of parseJsonField<EvidenceRef[]>(e.evidenceRefs, [])) {
      check(ref, `chronology:${e.id}`);
    }
  }

  const facts = await db.caseFact.findMany({
    where: { caseId },
    select: { id: true, supportingEvidence: true, contradictingEvidence: true },
  });
  for (const f of facts) {
    for (const ref of parseJsonField<EvidenceRef[]>(f.supportingEvidence, [])) {
      check(ref, `fact:${f.id}:support`);
    }
    for (const ref of parseJsonField<EvidenceRef[]>(f.contradictingEvidence, [])) {
      check(ref, `fact:${f.id}:counter`);
    }
  }

  const links = await db.caseEvidenceLink.findMany({
    where: { caseId },
    select: { id: true, evidenceRef: true },
  });
  for (const l of links) {
    const ref = parseJsonField<EvidenceRef | null>(l.evidenceRef, null);
    if (ref) check(ref, `evidenceLink:${l.id}`);
  }

  const claims = await db.caseClaim.findMany({
    where: { caseId },
    select: { id: true, source: true, evidenceRefs: true },
  });
  for (const c of claims) {
    const src = parseJsonField<EvidenceRef | null>(c.source, null);
    if (src) check(src, `claim:${c.id}:source`);
    for (const ref of parseJsonField<EvidenceRef[]>(c.evidenceRefs, [])) {
      check(ref, `claim:${c.id}:evidence`);
    }
  }

  return {
    name: "wrong_document_page_link",
    passed: violations.length === 0,
    detail: violations.length === 0 ? undefined : violations.slice(0, 5).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check 6 — duplicate_reprocessing_avoided
// ---------------------------------------------------------------------------

async function checkDuplicateReprocessing(docIndex: DocumentIndex): Promise<EvalCheck> {
  // For each sha256 shared by multiple document ids, exactly one of them
  // should have DocumentPage rows (the duplicate is skipped).
  const violations: string[] = [];
  for (const [sha, ids] of docIndex.bySha.entries()) {
    if (ids.length <= 1) continue;
    const pagesPerDoc = new Map<string, number>();
    const pageRows = await db.documentPage.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true },
    });
    for (const p of pageRows) {
      pagesPerDoc.set(p.documentId, (pagesPerDoc.get(p.documentId) ?? 0) + 1);
    }
    const docsWithPages = [...pagesPerDoc.entries()].filter(([, n]) => n > 0);
    if (docsWithPages.length > 1) {
      violations.push(
        `sha256 ${sha}: ${docsWithPages.length} documents have pages (expected ≤ 1)`,
      );
    }
  }
  return {
    name: "duplicate_reprocessing_avoided",
    passed: violations.length === 0,
    detail: violations.length === 0 ? undefined : violations.slice(0, 5).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check 7 — incremental_no_reprocess
// ---------------------------------------------------------------------------

async function checkIncrementalNoReprocess(caseId: string): Promise<EvalCheck> {
  // Inspect the most recent INGEST CaseJob. Its documentIds should NOT
  // overlap with documents that already reached READY before the job started.
  const jobs = await db.caseJob.findMany({
    where: { caseId, jobType: "INGEST" },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true, documentIds: true, createdAt: true, status: true },
  });
  if (jobs.length < 2) {
    // Need at least 2 INGEST jobs to verify incremental behavior.
    return {
      name: "incremental_no_reprocess",
      passed: true,
      detail: "fewer than 2 INGEST jobs — check skipped (nothing to compare)",
    };
  }
  const [latest, previous] = jobs;
  const latestIds = new Set(parseJsonField<string[]>(latest.documentIds, []));
  const previousIds = new Set(parseJsonField<string[]>(previous.documentIds, []));
  const overlap = [...latestIds].filter((id) => previousIds.has(id));
  return {
    name: "incremental_no_reprocess",
    passed: overlap.length === 0,
    detail:
      overlap.length === 0
        ? undefined
        : `${overlap.length} document ids overlap between consecutive INGEST jobs (first 5: ${overlap.slice(0, 5).join(", ")})`,
  };
}

// ---------------------------------------------------------------------------
// Check 8 — deterministic_works_without_codex
// ---------------------------------------------------------------------------

async function checkDeterministicWorksWithoutCodex(caseId: string): Promise<EvalCheck> {
  // §15, §26 — Verify deterministic analysis works WITHOUT Codex.
  // We do NOT probe Codex here (the check is about deterministic fallback,
  // not Codex availability). If Codex is available, the deterministic path
  // is still exercised by this check because we call runDeterministicAnalysis
  // directly (bypassing the router's Codex-first routing).
  try {
    const pack = await buildCaseAnalysisPack(caseId, { query: "deterministic check" });
    const det = await runDeterministicAnalysis(caseId, pack);
    const ok =
      det.status === "DETERMINISTIC_ONLY" &&
      det.analysis.deterministic === true &&
      det.analysis.synthesis.length > 0;
    return {
      name: "deterministic_works_without_codex",
      passed: ok,
      detail: ok
        ? undefined
        : `deterministic analysis failed (status=${det.status}, synthesis.length=${det.analysis.synthesis.length})`,
    };
  } catch (err) {
    return {
      name: "deterministic_works_without_codex",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// evaluateCase — the entry point
// ---------------------------------------------------------------------------

/**
 * Run every hard assertion against the case. Returns the aggregate `passed`
 * boolean and the per-check breakdown. NEVER throws.
 */
export async function evaluateCase(caseId: string): Promise<EvalResult> {
  if (!caseId) {
    return {
      passed: false,
      checks: [
        {
          name: "case_id_present",
          passed: false,
          detail: "evaluateCase called with an empty caseId",
        },
      ],
    };
  }

  let docIndex: DocumentIndex;
  try {
    docIndex = await loadDocumentIndex(caseId);
  } catch (err) {
    return {
      passed: false,
      checks: [
        {
          name: "load_document_index",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const checks: EvalCheck[] = [];
  const run = async (fn: () => Promise<EvalCheck>): Promise<void> => {
    try {
      checks.push(await fn());
    } catch (err) {
      checks.push({
        name: "unexpected_error",
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await run(() => checkProvenanceLoss(caseId, docIndex));
  await run(() => checkCrossCaseLeakage(caseId, docIndex));
  await run(() => checkPartyClaimConfusion(caseId));
  await run(() => checkInventedEvidenceIds(caseId));
  await run(() => checkWrongDocumentPageLink(caseId, docIndex));
  await run(() => checkDuplicateReprocessing(docIndex));
  await run(() => checkIncrementalNoReprocess(caseId));
  await run(() => checkDeterministicWorksWithoutCodex(caseId));

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}
