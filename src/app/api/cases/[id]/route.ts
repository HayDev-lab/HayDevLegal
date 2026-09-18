// src/app/api/cases/[id]/route.ts
// Phase 5 §17 — Get / update / archive / delete a single case.

import { NextRequest, NextResponse } from "next/server";
import type { CaseStatus, CaseType, UpdateCaseInput } from "@/lib/case-workspace/types";
import {
  archiveCase,
  deleteCase,
  getCase,
  getCaseSummary,
  updateCase,
} from "@/lib/case-workspace/cases/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const c = await getCase(id);
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ case: c });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to get case", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as Partial<{
      title: string;
      caseNumber: string;
      jurisdiction: string;
      court: string;
      proceedingType: string;
      caseType: CaseType;
      status: CaseStatus;
    }>;
    // Strip undefined keys so partial patch doesn't accidentally null them.
    const patch: UpdateCaseInput = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.caseNumber === "string") patch.caseNumber = body.caseNumber;
    if (typeof body.jurisdiction === "string") patch.jurisdiction = body.jurisdiction;
    if (typeof body.court === "string") patch.court = body.court;
    if (typeof body.proceedingType === "string") patch.proceedingType = body.proceedingType;
    if (body.caseType) patch.caseType = body.caseType;
    if (body.status) patch.status = body.status;
    const updated = await updateCase(id, patch);
    return NextResponse.json({ case: updated });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to update case", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    // §19 — archive-first. If not already archived, archive and return 202.
    const existing = await getCase(id);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (existing.status !== "ARCHIVED") {
      const archived = await archiveCase(id);
      return NextResponse.json(
        { case: archived, message: "case archived; delete again to permanently remove" },
        { status: 202 },
      );
    }
    await deleteCase(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to delete case", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// §17 — deterministic case summary endpoint (no LLM).
export async function HEAD(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const summary = await getCaseSummary(id);
    return NextResponse.json({ summary }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to get summary", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
