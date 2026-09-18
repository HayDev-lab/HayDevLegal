// src/lib/case-workspace/cases/service.ts
// Phase 5 — CaseWorkspace CRUD service.
//
// §19 — Archive-first delete:
//   * `archiveCase` soft-deletes (status: ARCHIVED, archivedAt: now). The
//     case row + all derived data remain queryable but hidden from the
//     active list.
//   * `deleteCase` is a hard delete that cascades to all derived data +
//     storage files. It is ONLY allowed when the case is already archived
//     (operator must explicitly archive first — no accidental permanent
//     destruction).
//
// §17 — getCaseSummary is deterministic (no LLM). It counts rows and
// aggregates ISO dates.

import { db } from "../db";
import { archiveCaseStorage, purgeCaseStorage } from "../documents/storage";
import type {
  CaseStatus,
  CaseSummary,
  CaseType,
  CaseWorkspace,
  CreateCaseInput,
  UpdateCaseInput,
} from "../types";

// ---------------------------------------------------------------------------
// Row → parsed interface mapper
// ---------------------------------------------------------------------------

type CaseRow = Awaited<ReturnType<typeof db.caseWorkspace.findFirst>>;

function mapCase(row: NonNullable<CaseRow>): CaseWorkspace {
  return {
    id: row.id,
    title: row.title,
    caseNumber: row.caseNumber,
    jurisdiction: row.jurisdiction,
    court: row.court,
    proceedingType: row.proceedingType,
    caseType: row.caseType as CaseType,
    status: row.status as CaseStatus,
    documentCount: row.documentCount,
    pageCount: row.pageCount,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export async function createCase(
  input: CreateCaseInput,
): Promise<CaseWorkspace> {
  const row = await db.caseWorkspace.create({
    data: {
      title: input.title,
      caseNumber: input.caseNumber ?? null,
      jurisdiction: input.jurisdiction ?? null,
      court: input.court ?? null,
      proceedingType: input.proceedingType ?? null,
      caseType: input.caseType ?? "OTHER",
      status: "ACTIVE",
    },
  });
  return mapCase(row);
}

export async function getCase(id: string): Promise<CaseWorkspace | null> {
  const row = await db.caseWorkspace.findUnique({ where: { id } });
  return row ? mapCase(row) : null;
}

export async function listCases(filter?: {
  status?: CaseStatus;
  caseType?: CaseType;
}): Promise<CaseWorkspace[]> {
  const where: Record<string, unknown> = {};
  if (filter?.status) where.status = filter.status;
  if (filter?.caseType) where.caseType = filter.caseType;
  const rows = await db.caseWorkspace.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
  });
  return rows.map(mapCase);
}

export async function updateCase(
  id: string,
  patch: UpdateCaseInput,
): Promise<CaseWorkspace> {
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.caseNumber !== undefined) data.caseNumber = patch.caseNumber;
  if (patch.jurisdiction !== undefined) data.jurisdiction = patch.jurisdiction;
  if (patch.court !== undefined) data.court = patch.court;
  if (patch.proceedingType !== undefined)
    data.proceedingType = patch.proceedingType;
  if (patch.caseType !== undefined) data.caseType = patch.caseType;
  if (patch.status !== undefined) data.status = patch.status;
  const row = await db.caseWorkspace.update({ where: { id }, data });
  return mapCase(row);
}

// ---------------------------------------------------------------------------
// Archive-first delete (§19)
// ---------------------------------------------------------------------------

/**
 * Archive a case. The case becomes read-only (status: ARCHIVED,
 * archivedAt: now). Storage files move to the archive root (§19 —
 * archive-first). The case row + all derived data remain queryable.
 */
export async function archiveCase(id: string): Promise<CaseWorkspace> {
  // Move storage bytes to the archive dir first (§19 — archive-first).
  await archiveCaseStorage(id).catch(() => {
    // Storage move failure is non-fatal — the case can still be archived
    // at the DB level. Operator can purge later if needed.
  });
  const row = await db.caseWorkspace.update({
    where: { id },
    data: {
      status: "ARCHIVED",
      archivedAt: new Date(),
    },
  });
  return mapCase(row);
}

/**
 * Permanently delete a case (§19 — only allowed if already archived).
 * Cascades to ALL derived data (volumes, documents, pages, jobs,
 * chronology, entities, facts, evidence links, claims, contradictions,
 * issue links, analysis results) via the Prisma onDelete: Cascade
 * relation. Storage bytes (live + archived) are also purged.
 */
export async function deleteCase(id: string): Promise<void> {
  // §19 — hard delete requires prior archive.
  const row = await db.caseWorkspace.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!row) {
    throw new Error(`Case not found: ${id}`);
  }
  if (row.status !== "ARCHIVED") {
    throw new Error(
      "Case must be archived before hard-delete (§19 archive-first)",
    );
  }
  // Purge all storage bytes (live + archived).
  await purgeCaseStorage(id).catch(() => {});
  // Cascade delete via Prisma — removes all related rows.
  await db.caseWorkspace.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Deterministic case summary (§17 — no LLM)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic case summary (§17 — no LLM):
 *   * documentCount, pageCount (denormalized on the case row)
 *   * dateRange (earliest + latest chronology dates)
 *   * keyEntitiesCount
 *   * verifiedFactsCount (status=VERIFIED)
 *   * openIssuesCount (LegalIssueLink count)
 *   * contradictionsCount (CaseContradiction count)
 *   * researchCoverage (fraction of facts with ≥1 supporting evidence)
 *
 * Pure counts — no extraction, no AI. Cheap to call on every UI render.
 */
export async function getCaseSummary(id: string): Promise<CaseSummary> {
  const [caseRow, entitiesCount, verifiedFacts, issuesCount, contradictionsCount, factsWithEvidence] =
    await Promise.all([
      db.caseWorkspace.findUnique({
        where: { id },
        select: { documentCount: true, pageCount: true },
      }),
      db.caseEntity.count({ where: { caseId: id } }),
      db.caseFact.count({ where: { caseId: id, status: "VERIFIED" } }),
      db.legalIssueLink.count({ where: { caseId: id } }),
      db.caseContradiction.count({ where: { caseId: id } }),
      db.caseFact.count({
        where: {
          caseId: id,
          // Facts with non-empty supportingEvidence JSON array.
          NOT: { supportingEvidence: "[]" },
        },
      }),
    ]);

  // Earliest + latest event dates from chronology (lexicographic on ISO
  // date strings works because ISO dates sort lexicographically).
  const events = await db.chronologyEvent.findMany({
    where: { caseId: id, date: { not: null } },
    select: { date: true },
    orderBy: { date: "asc" },
  });
  const dateStrings = events
    .map((e) => e.date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const dateRange = {
    earliest: dateStrings[0] ?? null,
    latest: dateStrings[dateStrings.length - 1] ?? null,
  };

  const totalFacts = verifiedFacts + (await db.caseFact.count({ where: { caseId: id } }) - verifiedFacts);
  const researchCoverage =
    totalFacts === 0 ? 0 : Math.min(1, factsWithEvidence / totalFacts);

  return {
    documentCount: caseRow?.documentCount ?? 0,
    pageCount: caseRow?.pageCount ?? 0,
    dateRange,
    keyEntitiesCount: entitiesCount,
    verifiedFactsCount: verifiedFacts,
    openIssuesCount: issuesCount,
    contradictionsCount,
    researchCoverage,
  };
}

// Re-export for callers that need the constants
export { archiveCaseStorage, purgeCaseStorage } from "../documents/storage";
