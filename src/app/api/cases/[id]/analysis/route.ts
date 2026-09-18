// src/app/api/cases/[id]/analysis/route.ts
// Phase 5 §14, §15, §17 — Case analysis pack + Codex + deterministic fallback.

import { NextRequest, NextResponse } from "next/server";
import { buildCaseAnalysisPack } from "@/lib/case-workspace/analysis/case-analysis-pack";
import { runCodexCaseAnalysis } from "@/lib/case-workspace/analysis/codex-analysis";
import { runDeterministicAnalysis } from "@/lib/case-workspace/analysis/deterministic-analysis";
import { db } from "@/lib/case-workspace/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const results = await db.caseAnalysisResult.findMany({
      where: { caseId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list analysis", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { query: string; selectedFactIds?: string[]; selectedIssueIds?: string[]; maxEvidenceItems?: number; mode?: "codex" | "deterministic" | "auto" };
    if (!body.query || body.query.trim().length === 0) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const pack = await buildCaseAnalysisPack(id, {
      query: body.query,
      selectedFactIds: body.selectedFactIds,
      selectedIssueIds: body.selectedIssueIds,
      maxEvidenceItems: body.maxEvidenceItems,
    });

    const mode = body.mode ?? "auto";
    // §15 — auto mode: try Codex first; if AUTH_REQUIRED/RATE_LIMITED, fall back to deterministic.
    // Per §15: do NOT silently switch to API billing (Codex SDK only used if explicitly configured).
    let analysis: { analysis: unknown; status: string; provider?: string; errorDetail?: string };
    if (mode === "deterministic") {
      const det = await runDeterministicAnalysis(id, pack);
      analysis = { analysis: det.analysis, status: "DETERMINISTIC_ONLY", provider: "deterministic" };
    } else {
      const codex = await runCodexCaseAnalysis(id, pack);
      if (codex.analysis && (codex.status === "SUCCESS" || codex.status === "SUCCESS_EMPTY")) {
        analysis = { analysis: codex.analysis, status: "SUCCESS", provider: codex.provider ?? "codex-cli" };
      } else if (codex.status === "AUTH_REQUIRED" || codex.status === "RATE_LIMITED" || codex.status === "UNAVAILABLE" || codex.status === "BLOCKED_EXTERNAL_QUOTA") {
        // §15 — fall back to deterministic analysis. Mark Codex gate separately.
        const det = await runDeterministicAnalysis(id, pack);
        analysis = {
          analysis: det.analysis,
          status: "BLOCKED_EXTERNAL_QUOTA",
          provider: "deterministic",
          errorDetail: `Codex ${codex.status}; deterministic fallback used`,
        };
      } else {
        // TIMEOUT / INVALID_SCHEMA / ERROR — still fall back to deterministic for graceful degradation.
        const det = await runDeterministicAnalysis(id, pack);
        analysis = {
          analysis: det.analysis,
          status: "PARTIAL_AI_UNAVAILABLE",
          provider: "deterministic",
          errorDetail: `Codex ${codex.status}; deterministic fallback used`,
        };
      }
    }

    // Persist the analysis result.
    const persisted = await db.caseAnalysisResult.create({
      data: {
        caseId: id,
        requestId: pack.requestId ?? crypto.randomUUID(),
        pack: JSON.stringify(pack),
        analysis: analysis.analysis ? JSON.stringify(analysis.analysis) : null,
        analysisVersion: "1.0",
        status: analysis.status,
        provider: analysis.provider ?? null,
        errorDetail: analysis.errorDetail ?? null,
      },
    });
    return NextResponse.json({ result: persisted }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to run analysis", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
