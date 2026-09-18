// src/app/api/cases/route.ts
// Phase 5 §17 — Case Workspace API. List + create cases.
// Per project rule: only `/` page route is user-visible; API routes are allowed.

import { NextRequest, NextResponse } from "next/server";
import { createCase, listCases } from "@/lib/case-workspace/cases/service";
import type { CaseType } from "@/lib/case-workspace/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const status = (url.searchParams.get("status") as "ACTIVE" | "ARCHIVED" | null) ?? undefined;
    const caseType = (url.searchParams.get("caseType") as CaseType | null) ?? undefined;
    const cases = await listCases({ status, caseType });
    return NextResponse.json({ cases });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list cases", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      caseNumber?: string;
      jurisdiction?: string;
      court?: string;
      proceedingType?: string;
      caseType?: CaseType;
    };
    if (!body.title || body.title.trim().length === 0) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    const created = await createCase({
      title: body.title.trim().slice(0, 240),
      caseNumber: body.caseNumber?.trim().slice(0, 120) || undefined,
      jurisdiction: body.jurisdiction?.trim().slice(0, 120) || undefined,
      court: body.court?.trim().slice(0, 120) || undefined,
      proceedingType: body.proceedingType?.trim().slice(0, 120) || undefined,
      caseType: body.caseType ?? "OTHER",
    });
    return NextResponse.json({ case: created }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to create case", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
