// src/app/api/test/gold-set/route.ts
// Federated relevance gold-set harness (spec §45-§46, §84 regression gate).
//
// Runs the curated live queries through the REAL federated engine (no mocks)
// and reports per-query pass/fail, Recall@N-style metrics, and per-source
// availability. Developer/QA endpoint — never used by the app UI.
//
// Restored note: this route existed in the sandbox where it was created but
// was silently never committed (the old .gitignore `test` pattern matched
// src/app/api/test/). Rebuilt from the recorded gold-set outputs.

import { NextResponse } from "next/server";
import { federatedSearch } from "@/lib/legal-search/engine/search-engine";
import type { SearchMode } from "@/lib/legal-search/types";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

type GoldItem = {
  id: string;
  category: string;
  query: string;
  mode: SearchMode;
  /** ANY of these must appear in the evidence text (title + caseNumber + passage). */
  anyOfTerms?: string[];
  /** evidence.article === N, or the passage text contains "հոդված N". */
  expectedArticle?: string;
  /** The query must legitimately produce NO evidence. */
  expectEmpty?: boolean;
};

const GOLD: GoldItem[] = [
  {
    id: "g1",
    category: "exact_code_article",
    query: "ՔԴՕ 179 հոդված",
    mode: "quick",
    anyOfTerms: ["քրեական դատավարության օրենսգիրք"],
    expectedArticle: "179",
  },
  {
    id: "g2",
    category: "abbreviation",
    query: "ՔՕ 105 հոդված",
    mode: "quick",
    anyOfTerms: ["քրեական օրենսգիրք"],
    expectedArticle: "105",
  },
  {
    id: "g3",
    category: "exact_code_article",
    query: "Քաղաքացիական օրենսգիրք հոդված 15",
    mode: "quick",
    anyOfTerms: ["քաղաքացիական օրենսգիրք"],
    expectedArticle: "15",
  },
  {
    id: "g4",
    category: "natural_question",
    query: "ինչ է նախադեպային որոշումը վճռաբեկ դատարանում",
    mode: "deep",
    anyOfTerms: ["վճռաբեկ", "նախադեպ"],
  },
  {
    id: "g5",
    category: "constitutional",
    query: "սահմանադրական դատարան պատշաճ ծանուցում",
    mode: "deep",
    anyOfTerms: ["սահմանադրական", "ծանուցում"],
  },
  {
    id: "g6",
    category: "concept_expansion",
    query: "դատարանը նիստ է անցկացրել առանց ինձ պատշաճ ծանուցելու",
    mode: "deep",
    anyOfTerms: ["ծանուցում", "պատշաճ"],
  },
  {
    id: "g7",
    category: "cassation_precedent",
    query: "վճռաբեկ դատարանի պրակտիկա խուզարկության վերաբերյալ",
    mode: "deep",
    anyOfTerms: ["վճռաբեկ", "խուզարկություն"],
  },
  {
    id: "g8",
    category: "case_number",
    query: "ԵԴ/36723/02/21 գործ",
    mode: "deep",
    anyOfTerms: ["36723/02/21", "ԵԴ/36723"],
  },
  {
    id: "g9",
    category: "no_result",
    query: "zzz nonexistent 12345",
    mode: "quick",
    expectEmpty: true,
  },
];

export async function GET() {
  const generatedAt = new Date().toISOString();
  const availability: Record<string, { success: number; total: number }> = {};
  const results: Array<Record<string, unknown>> = [];

  for (const item of GOLD) {
    const t0 = Date.now();
    let resp: Awaited<ReturnType<typeof federatedSearch>> | null = null;
    let error: string | undefined;
    try {
      resp = await federatedSearch(item.query, { mode: item.mode });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const evidence = resp?.evidence ?? [];
    for (const s of resp?.trace?.sources ?? []) {
      const entry = (availability[s.id] ??= { success: 0, total: 0 });
      entry.total += 1;
      // PARTIAL = the source returned real (metadata-grade) data with the
      // full text honestly gated — it IS available.
      if (s.status === "SUCCESS" || s.status === "PARTIAL") entry.success += 1;
    }

    const text = evidence
      .map((e) => `${e.title} ${e.caseNumber ?? ""} ${e.passage ?? ""}`)
      .join(" ")
      .toLowerCase();

    const failReasons: string[] = [];
    if (error) {
      failReasons.push(`search error: ${error.slice(0, 120)}`);
    } else if (item.expectEmpty) {
      if (evidence.length > 0) failReasons.push(`expected no evidence, got ${evidence.length}`);
    } else {
      if (evidence.length === 0) failReasons.push("no evidence");
      if (
        item.anyOfTerms?.length &&
        !item.anyOfTerms.some((t) => text.includes(t.toLowerCase()))
      ) {
        failReasons.push(`none of [${item.anyOfTerms.join(", ")}] found in evidence`);
      }
      if (item.expectedArticle) {
        const articleOk =
          evidence.some((e) => e.article === item.expectedArticle) ||
          text.includes(`հոդված ${item.expectedArticle}`);
        if (!articleOk) failReasons.push(`article ${item.expectedArticle} not surfaced`);
      }
    }

    results.push({
      id: item.id,
      category: item.category,
      query: item.query,
      mode: item.mode,
      passed: failReasons.length === 0,
      evidenceCount: evidence.length,
      sourcesSucceeded: (resp?.trace?.sources ?? [])
        .filter((s) => s.status === "SUCCESS")
        .map((s) => s.id),
      failReason: failReasons.join("; ") || null,
      durationMs: Date.now() - t0,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = GOLD.length;
  const avgDurationMs =
    results.length > 0
      ? Math.round(
          results.reduce((a, r) => a + (Number(r.durationMs) || 0), 0) / results.length,
        )
      : 0;

  return NextResponse.json({
    ok: true,
    generatedAt,
    metrics: {
      total,
      passed,
      failed: total - passed,
      recallAtN: `${((passed / total) * 100).toFixed(1)}%`,
      avgDurationMs,
    },
    sourceAvailability: availability,
    results,
  });
}
