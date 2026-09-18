// src/app/api/cases/[id]/jobs/route.ts
// Phase 5 §7, §17 — Job tracking.

import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/lib/case-workspace/jobs/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const jobType = (url.searchParams.get("jobType") ?? undefined) as
      | import("@/lib/case-workspace/types").JobType
      | undefined;
    const status = (url.searchParams.get("status") ?? undefined) as
      | import("@/lib/case-workspace/types").JobStatus
      | undefined;
    const jobs = await listJobs(id, { jobType, status });
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list jobs", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
