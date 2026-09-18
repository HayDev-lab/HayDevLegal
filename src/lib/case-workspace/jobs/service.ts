// src/lib/case-workspace/jobs/service.ts
// Phase 5 — CaseJob CRUD + resumable job runner.
//
// §7 — Incremental/resumable: failure at document 37/100 resumes remaining
// work. Job rows persist `progressCurrent`/`progressTotal`/`documentIds`
// so an interrupted job can be resumed by calling `resumeJob(id)`.

import { db } from "../db";
import { JOB_STALE_AFTER_MS } from "../config";
import { parseStringArray } from "../documents/provenance";
import type { CaseJob, JobStatus, JobType } from "../types";

// ---------------------------------------------------------------------------
// Row → parsed interface mapper
// ---------------------------------------------------------------------------

type JobRow = Awaited<ReturnType<typeof db.caseJob.findFirst>>;

function mapJob(row: NonNullable<JobRow>): CaseJob {
  return {
    id: row.id,
    caseId: row.caseId,
    jobType: row.jobType as JobType,
    status: row.status as JobStatus,
    progressCurrent: row.progressCurrent,
    progressTotal: row.progressTotal,
    documentIds: parseStringArray(row.documentIds),
    errorDetail: row.errorDetail,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export async function createJob(
  caseId: string,
  jobType: JobType,
  documentIds: string[],
): Promise<CaseJob> {
  const row = await db.caseJob.create({
    data: {
      caseId,
      jobType,
      status: "QUEUED",
      progressCurrent: 0,
      progressTotal: documentIds.length,
      documentIds: JSON.stringify(documentIds),
    },
  });
  return mapJob(row);
}

export async function getJob(id: string): Promise<CaseJob | null> {
  const row = await db.caseJob.findUnique({ where: { id } });
  return row ? mapJob(row) : null;
}

export async function listJobs(
  caseId: string,
  filter?: { jobType?: JobType; status?: JobStatus },
): Promise<CaseJob[]> {
  const where: Record<string, unknown> = { caseId };
  if (filter?.jobType) where.jobType = filter.jobType;
  if (filter?.status) where.status = filter.status;
  const rows = await db.caseJob.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
  });
  return rows.map(mapJob);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export async function updateJobProgress(
  id: string,
  current: number,
  total?: number,
): Promise<CaseJob> {
  const data: Record<string, unknown> = { progressCurrent: current };
  if (total !== undefined) data.progressTotal = total;
  const row = await db.caseJob.update({ where: { id }, data });
  return mapJob(row);
}

export async function completeJob(
  id: string,
  partial: boolean = false,
): Promise<CaseJob> {
  const row = await db.caseJob.update({
    where: { id },
    data: {
      status: partial ? "PARTIAL" : "COMPLETED",
      completedAt: new Date(),
    },
  });
  return mapJob(row);
}

export async function failJob(
  id: string,
  errorDetail: string,
): Promise<CaseJob> {
  const row = await db.caseJob.update({
    where: { id },
    data: {
      status: "FAILED",
      errorDetail: errorDetail.slice(0, 2000),
      completedAt: new Date(),
    },
  });
  return mapJob(row);
}

export async function cancelJob(id: string): Promise<CaseJob> {
  const row = await db.caseJob.update({
    where: { id },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
    },
  });
  return mapJob(row);
}

/**
 * Resume a previously-queued/failed/partial job. Sets status: RUNNING
 * and starts the progress counter from where it left off (progressCurrent).
 * The job's `documentIds` array is preserved — the caller (orchestrator)
 * is responsible for skipping documents whose ids already appear in
 * `processedDocumentIds` (kept by the orchestrator) or whose processing
 * status is already READY/PARTIAL.
 *
 * Per §7 — failure at 37/100 resumes remaining work.
 */
export async function resumeJob(id: string): Promise<CaseJob> {
  const existing = await db.caseJob.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`Job not found: ${id}`);
  }
  if (existing.status === "COMPLETED") {
    throw new Error("Cannot resume a completed job");
  }
  const row = await db.caseJob.update({
    where: { id },
    data: {
      status: "RUNNING",
      startedAt: existing.startedAt ?? new Date(),
      completedAt: null,
      errorDetail: null,
    },
  });
  return mapJob(row);
}

// ---------------------------------------------------------------------------
// Idempotent job creation — avoid duplicate running jobs of the same type
// ---------------------------------------------------------------------------

/**
 * Get-or-create a running job of the given type for a case. If a RUNNING
 * or QUEUED job of the same type already exists, return it (idempotent —
 * don't start duplicate running jobs). Otherwise create a fresh one.
 *
 * §10 — Stale job detection: a job whose `updatedAt` is older than
 * JOB_STALE_AFTER_MS is considered stuck and will be marked FAILED before
 * a new job is created. This prevents zombie jobs from blocking future
 * runs forever.
 */
export async function getOrCreateRunningJob(
  caseId: string,
  jobType: JobType,
  documentIds: string[] = [],
): Promise<CaseJob> {
  const now = Date.now();
  const candidates = await db.caseJob.findMany({
    where: {
      caseId,
      jobType,
      status: { in: ["RUNNING", "QUEUED"] },
    },
    orderBy: { createdAt: "desc" },
  });

  for (const c of candidates) {
    const updatedAtMs = c.updatedAt.getTime();
    if (now - updatedAtMs > JOB_STALE_AFTER_MS) {
      // Stale — mark FAILED and continue looking for a fresh candidate.
      await db.caseJob
        .update({
          where: { id: c.id },
          data: {
            status: "FAILED",
            errorDetail: `Job exceeded staleness threshold (${JOB_STALE_AFTER_MS}ms)`,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      continue;
    }
    return mapJob(c);
  }

  // No running/queued fresh candidate — create a new one.
  const row = await db.caseJob.create({
    data: {
      caseId,
      jobType,
      status: "RUNNING",
      progressCurrent: 0,
      progressTotal: documentIds.length,
      documentIds: JSON.stringify(documentIds),
      startedAt: new Date(),
    },
  });
  return mapJob(row);
}

// ---------------------------------------------------------------------------
// List documentIds covered by a job (for resumability)
// ---------------------------------------------------------------------------

/** Return the documentIds covered by a job (parsed from JSON). */
export function jobDocumentIds(job: CaseJob): string[] {
  return job.documentIds;
}

/**
 * For an interrupted job, return the documentIds that have NOT yet been
 * processed — i.e. the slice from `progressCurrent` to the end of the
 * original `documentIds` array.
 *
 * The orchestrator uses this to resume: it processes only the remaining
 * ids, then calls `completeJob` (or `failJob`).
 */
export function remainingDocumentIds(job: CaseJob): string[] {
  const ids = job.documentIds;
  const start = Math.min(job.progressCurrent, ids.length);
  return ids.slice(start);
}
