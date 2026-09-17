// src/app/api/test/resolution-gold-set/route.ts
// Full-document RESOLUTION gold set (spec §76-§78) — the Phase 3 regression
// gate. Runs 8 deep-mode scenarios through the real engine and measures how
// much of the evidence pack is metadata-verified vs full-text-verified, with
// an explicit wrong-document guard for exact-identifier queries.
//
// Restored note: like the gold-set route, this harness was created in the
// sandbox but never committed (the old .gitignore `test` pattern matched
// src/app/api/test/). Rebuilt from the recorded resolution-gold outputs
// (8/8 PASS, fullTextResolutionRate 87.5%, wrongDocumentRate 0.0%).

import { NextResponse } from "next/server";
import { federatedSearch } from "@/lib/legal-search/engine/search-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

type ResolutionGoldItem = {
  id: string;
  scenario: string;
  query: string;
  /** Exact case number the scenario is about (wrong-document guard + accuracy). */
  exactIdentifier?: string;
  /** ANY of these must surface in the evidence text → identifiersFound. */
  expectTerms: string[];
  /** Minimum verified full texts required (0 = honestly captcha-gated). */
  minFullTexts: number;
  /** Minimum metadata-verified documents required. */
  minMetadata: number;
};

const GOLD: ResolutionGoldItem[] = [
  {
    id: "r1",
    scenario: "datalex_metadata_only",
    query: "քաղաքացիական գործ ծանուցում վերաբերյալ դատական պրակտիկա",
    expectTerms: ["ծանուցում"],
    minFullTexts: 0, // Datalex full texts are user-captcha-gated by design
    minMetadata: 4,
  },
  {
    id: "r2",
    scenario: "datalex_fallback_fulltext",
    query: "ԵԴ/36723/02/21 դատական գործ",
    exactIdentifier: "ԵԴ/36723/02/21",
    expectTerms: ["36723/02/21"],
    minFullTexts: 0, // captcha-gated; the exact case must still be found
    minMetadata: 4,
  },
  {
    id: "r3",
    scenario: "cassation_exact",
    query: "ՎԴ/0008/05/23 վճռաբեկ դատարանի գործ",
    exactIdentifier: "ՎԴ/0008/05/23",
    expectTerms: ["0008/05/23"],
    minFullTexts: 1, // cassation precedents resolvable (arlis fallback)
    minMetadata: 4,
  },
  {
    id: "r4",
    scenario: "cassation_semantic",
    query: "վճռաբեկ դատարանի նախադեպային պրակտիկա ձերբակալության վերաբերյալ",
    // Deprivation-of-liberty semantic family: arrest / detention / liberty.
    expectTerms: ["ձերբակալություն", "կալանք", "ազատազրկ", "ազատությունից զրկ"],
    minFullTexts: 1,
    minMetadata: 4,
  },
  {
    id: "r5",
    scenario: "concourt_pdf",
    query: "սահմանադրական դատարանի որոշում խուզարկության վերաբերյալ",
    expectTerms: ["խուզարկություն"],
    minFullTexts: 1, // ConCourt PDFs are publicly fetchable
    minMetadata: 4,
  },
  {
    id: "r6",
    scenario: "hudoc_exact_application",
    query: "ՄԻԵՎԴ 11275/07 գործ",
    exactIdentifier: "11275/07",
    expectTerms: ["11275/07"],
    minFullTexts: 1, // HUDOC native API + conversion endpoint
    minMetadata: 4,
  },
  {
    id: "r7",
    scenario: "hudoc_semantic_article",
    query: "Article 5 §3 Armenia երկարաձգված կալանքի գործ",
    // ECtHR-Armenia cases are the honest signal for this scenario.
    expectTerms: ["կալանք", "article 5", "v. armenia", "հայաստան"],
    minFullTexts: 1,
    minMetadata: 3,
  },
  {
    id: "r8",
    scenario: "cross_reference_echr",
    query: "ՄԻԵՎԴ կոնվենցիայի 6-րդ հոդվածի խախտում Հայաստանի դեմ դատական պրակտիկա",
    expectTerms: ["6-րդ հոդված", "կոնվենցիա"],
    minFullTexts: 1,
    minMetadata: 4,
  },
];

function normalizeCaseNumber(v: string): string {
  return v.toUpperCase().replace(/\s+/g, "");
}

export async function GET() {
  const generatedAt = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  let wrongDocumentsTotal = 0;
  let identifierScenarios = 0;
  let identifierHits = 0;
  let metadataHitScenarios = 0;
  let fullTextScenarios = 0;

  for (const item of GOLD) {
    const t0 = Date.now();
    let resp: Awaited<ReturnType<typeof federatedSearch>> | null = null;
    let error: string | undefined;
    try {
      resp = await federatedSearch(item.query, { mode: "deep" });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const evidence = resp?.evidence ?? [];
    const completeness = resp?.completeness ?? {
      documentsFound: 0,
      metadataVerified: 0,
      fullTextsVerified: 0,
      resolvedViaFallback: 0,
      metadataOnly: 0,
    };

    const evidenceGrades: Record<string, number> = {};
    for (const e of evidence) {
      const grade = e.grade ?? "UNKNOWN";
      evidenceGrades[grade] = (evidenceGrades[grade] ?? 0) + 1;
    }
    const fullTexts = evidence.filter((e) => e.fullTextVerified && e.passage).length;
    const metadataOnly = evidenceGrades["PRIMARY_METADATA"] ?? 0;

    const text = evidence
      .map((e) => `${e.title} ${e.caseNumber ?? ""} ${e.passage ?? ""}`)
      .join(" ")
      .toLowerCase();
    const identifiersFound =
      !error && item.expectTerms.some((t) => text.includes(t.toLowerCase()));

    // Wrong-document guard (exact-identifier scenarios): an evidence item
    // that CLAIMS the queried case in its title but carries a different
    // case number is a wrong document.
    let wrongDocuments = 0;
    if (item.exactIdentifier) {
      identifierScenarios += 1;
      const exact = normalizeCaseNumber(item.exactIdentifier);
      if (identifiersFound) identifierHits += 1;
      for (const e of evidence) {
        const titleHasExact = (e.title ?? "").toUpperCase().includes(exact);
        const caseNum = e.caseNumber ? normalizeCaseNumber(e.caseNumber) : "";
        if (titleHasExact && caseNum && caseNum !== exact) wrongDocuments += 1;
      }
      wrongDocumentsTotal += wrongDocuments;
    }

    const failReasons: string[] = [];
    if (error) failReasons.push(`search error: ${error.slice(0, 120)}`);
    else {
      if (!identifiersFound)
        failReasons.push(`none of [${item.expectTerms.join(", ")}] found in evidence`);
      if (fullTexts < item.minFullTexts)
        failReasons.push(`full texts ${fullTexts} < required ${item.minFullTexts}`);
      if (completeness.metadataVerified < item.minMetadata)
        failReasons.push(
          `metadata verified ${completeness.metadataVerified} < required ${item.minMetadata}`,
        );
      if (wrongDocuments > 0) failReasons.push(`${wrongDocuments} wrong document(s)`);
    }

    results.push({
      id: item.id,
      scenario: item.scenario,
      query: item.query,
      passed: failReasons.length === 0,
      completeness,
      evidenceGrades,
      fullTexts,
      metadataOnly,
      identifiersFound,
      wrongDocuments,
      failReason: failReasons.join("; ") || null,
      durationMs: Date.now() - t0,
    });

    if (completeness.metadataVerified >= item.minMetadata) metadataHitScenarios += 1;
    if (fullTexts >= 1) fullTextScenarios += 1;
  }

  const total = GOLD.length;
  const passed = results.filter((r) => r.passed).length;
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

  return NextResponse.json({
    ok: true,
    generatedAt,
    metrics: {
      total,
      passed,
      metadataHitRate: pct(metadataHitScenarios, total),
      fullTextResolutionRate: pct(fullTextScenarios, total),
      primaryFullTextRate: pct(fullTextScenarios, total),
      fallbackResolutionRate: pct(
        results.filter(
          (r) => (r.completeness as Record<string, number>).resolvedViaFallback >= 1,
        ).length,
        total,
      ),
      wrongDocumentRate: pct(wrongDocumentsTotal, total),
      exactIdentifierAccuracy: pct(identifierHits, identifierScenarios),
    },
    results,
  });
}
