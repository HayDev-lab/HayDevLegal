// src/app/api/cases/[id]/strategy/route.ts
// Phase 7 §42 — Strategy Engine API. Build strategy map + list action candidates.
// Per §17: informs the user; does NOT choose legal action. No ranking.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";
import { buildStrategyMap } from "@/lib/legal-strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — list existing action candidates for the case
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const candidates = await db.legalActionCandidate.findMany({
      where: { caseId: id },
      orderBy: { actionType: "asc" },
    });
    return NextResponse.json({ candidates });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list strategy candidates", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// POST — build strategy map (deterministic — no ranking, no outcome prediction)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    // §31 — Build StrategyMap: Legal Issue → Action A (prerequisites, evidence, gaps,
    // authorities, counter-authorities, timing, limitations) → Action B → Research needed.
    // Per §17: NO "best option" / ranking / outcome prediction.
    const strategyMap = await buildStrategyMap(id);

    // Persist action candidates to DB (upsert — replace existing for this case)
    await db.legalActionCandidate.deleteMany({ where: { caseId: id } });

    for (const issue of strategyMap.issues) {
      for (const action of issue.actions) {
        await db.legalActionCandidate.create({
          data: {
            caseId: id,
            actionType: action.actionType,
            title: action.title,
            description: action.description ?? null,
            proceduralStage: action.proceduralStage ?? null,
            legalBasis: JSON.stringify(action.legalBasis ?? []),
            prerequisites: JSON.stringify(action.prerequisites ?? []),
            satisfiedPrerequisites: JSON.stringify(action.satisfiedPrerequisites ?? []),
            unsatisfiedPrerequisites: JSON.stringify(action.unsatisfiedPrerequisites ?? []),
            unknownPrerequisites: JSON.stringify(action.unknownPrerequisites ?? []),
            supportingFacts: JSON.stringify(action.supportingFacts ?? []),
            supportingEvidence: JSON.stringify(action.supportingEvidence ?? []),
            evidenceGaps: JSON.stringify(action.evidenceGaps ?? []),
            supportingAuthorities: JSON.stringify(action.supportingAuthorities ?? []),
            counterAuthorities: JSON.stringify(action.counterAuthorities ?? []),
            distinguishingFactors: JSON.stringify(action.distinguishingFactors ?? []),
            temporalStatus: action.temporalStatus ?? "UNKNOWN",
            limitations: JSON.stringify(action.limitations ?? []),
            proceduralEffect: action.proceduralEffect ?? null,
            availabilityStatus: action.availabilityStatus ?? "NOT_AVAILABLE_ON_CURRENT_RECORD",
            verificationStatus: action.verificationStatus ?? "UNRESOLVED",
            draftDocumentType: action.draftDocumentType ?? null,
            relatedIssues: JSON.stringify([issue.issueId]),
          },
        });
      }
    }

    return NextResponse.json({ strategyMap, candidateCount: strategyMap.issues.reduce((sum, i) => sum + i.actions.length, 0) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to build strategy map", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
