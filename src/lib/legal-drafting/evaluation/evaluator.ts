// src/lib/legal-drafting/evaluation/evaluator.ts
// Phase 6 — §31 — Drafting gold evaluator.
//
// Loads a draft, runs the verification firewalls, and computes the §31 hard
// metrics. The metrics measure how many fabrications the draft CONTAINS —
// a clean (verified) draft has all metrics = 0. A draft with any non-zero
// metric has a fabrication the firewall should have flagged.
//
// CRITICAL — §31: "Hard metrics computed, not invented — all must be 0."

import { db } from "@/lib/db";
import type {
  DraftingContext,
  DraftSection,
  DocumentPlan,
  SourceIdMap,
} from "@/lib/legal-drafting/types";
import { runAllVerification } from "@/lib/legal-drafting/verification";
import {
  ZERO_GOLD_METRICS,
  type DraftingGoldMetrics,
} from "@/lib/legal-drafting/evaluation/drafting-gold-set";

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type DraftRow = {
  id: string;
  documentType: string;
  title: string;
  goal: string | null;
  contextSummary: string;
  plan: string;
};

type VersionRow = {
  id: string;
  draftId: string;
  version: number;
  sourceIdMap: string;
  verificationStatus: string;
};

type SectionRow = {
  id: string;
  draftId: string;
  versionId: string;
  sectionType: string;
  title: string;
  content: string;
  reviewStatus: string;
  stale: boolean;
  warnings: string;
  previousContent: string | null;
};

// ---------------------------------------------------------------------------
// Helpers — parsing
// ---------------------------------------------------------------------------

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function parseSectionContent(raw: string): DraftSection[] {
  if (!raw) return [];
  const arr = safeParseJson<unknown[]>(raw, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && "sectionType" in x,
    )
    .map((s) => {
      const content = (s.content as { text?: string; sourceIds?: string[] } | undefined) ?? {};
      const sourceIds = Array.isArray(content.sourceIds)
        ? (content.sourceIds as string[])
        : [];
      return {
        id: String(s.id ?? ""),
        draftId: String(s.draftId ?? ""),
        versionId: String(s.versionId ?? ""),
        sectionType: String(s.sectionType) as DraftSection["sectionType"],
        title: String(s.title ?? ""),
        content: {
          text: typeof content.text === "string" ? content.text : "",
          sourceIds,
        },
        reviewStatus: String(s.reviewStatus ?? "UNREVIEWED") as DraftSection["reviewStatus"],
        stale: Boolean(s.stale),
        warnings: Array.isArray(s.warnings)
          ? (s.warnings as DraftSection["warnings"])
          : [],
        previousContent: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } satisfies DraftSection;
    });
}

// ---------------------------------------------------------------------------
// §31 — Hard metric computation
// ---------------------------------------------------------------------------

const FACT_RE = /^F\d+$/;
const LEGISLATION_RE = /^L\d+$/;
const CASSATION_RE = /^C\d+$/;
const CONCOURT_RE = /^CC\d+$/;
const ECHR_RE = /^E\d+$/;
const EVIDENCE_RE = /^CE/;

const ARTICLE_PATTERNS = [
  /\barticle\s+(\d+(?:\.\d+)*)\b/gi,
  /\bart\.?\s+(\d+(?:\.\d+)*)\b/gi,
  /\bհոդված\s+(\d+(?:\.\d+)*)\b/gi,
  /\bстатья\s+(\d+(?:\.\d+)*)\b/gi,
];
const CASE_NUMBER_PATTERNS = [
  /\b(?:decision|վճիռ|решение|judgment|ruling)\s+([A-ZԱՖՐա-ֆА-Яа-я]{2,5}[/\-]\d{2,6}(?:[/\-]\d{2,4})?)\b/gi,
];
const QUOTATION_PAIRS: Array<[string, string]> = [
  ["«", "»"],
  ["„", "“"],
  ['"', '"'],
  ["“", "”"],
];

function extractQuoted(text: string): string[] {
  const out: string[] = [];
  for (const [open, close] of QUOTATION_PAIRS) {
    let i = 0;
    while (i < text.length) {
      const startIdx = text.indexOf(open, i);
      if (startIdx < 0) break;
      const endIdx = text.indexOf(close, startIdx + 1);
      if (endIdx < 0) break;
      out.push(text.slice(startIdx + 1, endIdx));
      i = endIdx + 1;
    }
  }
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function collectContextPassages(ctx: DraftingContext): string[] {
  const out: string[] = [];
  for (const leg of ctx.legislation ?? []) {
    for (const p of leg.passages ?? []) out.push(normalizeWhitespace(p));
  }
  for (const c of ctx.cassationCases ?? []) {
    for (const p of c.passages ?? []) out.push(normalizeWhitespace(p));
  }
  for (const c of ctx.conCourtCases ?? []) {
    for (const p of c.passages ?? []) out.push(normalizeWhitespace(p));
  }
  for (const e of ctx.echrCases ?? []) {
    for (const p of e.passages ?? []) out.push(normalizeWhitespace(p));
  }
  for (const ev of ctx.evidenceRefs ?? []) {
    if (ev.quote) out.push(normalizeWhitespace(ev.quote));
  }
  return out;
}

/**
 * §31 — Compute hard metrics by directly inspecting the draft sections
 * against the closed DraftingContext + SourceIdMap. This is INDEPENDENT from
 * the verification firewalls — the metrics measure the draft's quality.
 *
 * @param sections    the DraftSection[] (parsed)
 * @param ctx         the closed DraftingContext
 * @param sourceIdMap the SourceIdMap
 * @returns the DraftingGoldMetrics (all should be 0 for a clean draft)
 */
export function computeDraftingMetrics(
  sections: DraftSection[],
  ctx: DraftingContext,
  sourceIdMap: SourceIdMap,
): DraftingGoldMetrics {
  const metrics: DraftingGoldMetrics = { ...ZERO_GOLD_METRICS };

  // Counters per metric.
  let factCitedTotal = 0;
  let factCitedMissing = 0;
  let evidenceCitedTotal = 0;
  let evidenceCitedMissing = 0;
  let caseCitedTotal = 0;
  let caseCitedMissing = 0;
  let articleCitedTotal = 0;
  let articleCitedMissing = 0;
  let quoteTotal = 0;
  let quoteMissing = 0;
  let partyClaimTotal = 0;
  let partyClaimAsHolding = 0;
  let metadataOnlyTotal = 0;
  let metadataOnlyHolding = 0;
  let legalAssertionTotal = 0;
  let unsupportedLegalAssertion = 0;
  let sectionsNeedingMissingInfoTotal = 0;
  let hiddenMissingInfo = 0;

  const factIds = new Set((ctx.facts ?? []).map((f) => f.sourceId));
  const evidenceIds = new Set((ctx.evidenceRefs ?? []).map((e) => e.sourceId));
  const metadataOnlyPrecedentIds = new Set<string>();

  // Build the set of metadata-only precedent source ids — precedents whose
  // passages array is empty.
  for (const c of ctx.cassationCases ?? []) {
    if (!c.passages || c.passages.length === 0) metadataOnlyPrecedentIds.add(c.sourceId);
  }
  for (const c of ctx.conCourtCases ?? []) {
    if (!c.passages || c.passages.length === 0) metadataOnlyPrecedentIds.add(c.sourceId);
  }
  for (const e of ctx.echrCases ?? []) {
    if (!e.passages || e.passages.length === 0) metadataOnlyPrecedentIds.add(e.sourceId);
  }

  // Build the set of normalized citation strings present in the sourceIdMap.
  const normalizedCitations = new Set<string>();
  for (const entry of Object.values(sourceIdMap ?? {})) {
    if (entry?.citation) {
      normalizedCitations.add(normalizeWhitespace(entry.citation.toLowerCase()));
    }
  }

  const contextPassages = collectContextPassages(ctx);

  for (const section of sections) {
    const text = section.content?.text ?? "";
    const sourceIds = section.content?.sourceIds ?? [];

    // 1) fabricatedFactRate — fact source ids cited but not in ctx.facts.
    for (const sid of sourceIds) {
      if (FACT_RE.test(sid)) {
        factCitedTotal++;
        if (!factIds.has(sid)) factCitedMissing++;
      }
      if (EVIDENCE_RE.test(sid)) {
        evidenceCitedTotal++;
        if (!evidenceIds.has(sid)) evidenceCitedMissing++;
      }
    }

    // 2) fabricatedArticleRate — article numbers in body that don't match
    //    any sourceIdMap citation.
    for (const re of ARTICLE_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        articleCitedTotal++;
        const num = m[1];
        const matched = Array.from(normalizedCitations).some((c) =>
          c.includes(num),
        );
        if (!matched) articleCitedMissing++;
      }
    }

    // 3) fabricatedCaseRate — case numbers in body that don't match.
    for (const re of CASE_NUMBER_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        caseCitedTotal++;
        const cn = m[1];
        const matched = Array.from(normalizedCitations).some((c) =>
          c.includes(normalizeWhitespace(cn.toLowerCase())),
        );
        if (!matched) caseCitedMissing++;
      }
    }

    // 4) fabricatedQuoteRate — quotes not verbatim in any context passage.
    const quotes = extractQuoted(text).filter((q) => q.trim().length >= 3);
    for (const q of quotes) {
      quoteTotal++;
      const nq = normalizeWhitespace(q);
      let found = false;
      for (const p of contextPassages) {
        if (p.includes(nq)) {
          found = true;
          break;
        }
      }
      if (!found) quoteMissing++;
    }

    // 5) partyClaimAsHoldingRate — fact refs that are party claims (status
    //    ALLEGED with category PRESENCE, OBJECT_ORIGIN, CHARGE, etc.) but
    //    are referenced with "established" language in the section.
    const partyClaimCategories = new Set([
      "PRESENCE",
      "OBJECT_ORIGIN",
      "CHARGE",
      "RISK_ASSESSMENT",
    ]);
    const lowerText = text.toLowerCase();
    const hasEstablishedLang =
      lowerText.includes("established") ||
      lowerText.includes("հաստատված") ||
      lowerText.includes("установлено") ||
      lowerText.includes("proven") ||
      lowerText.includes("verified");
    for (const sid of sourceIds) {
      if (!FACT_RE.test(sid)) continue;
      const fact = (ctx.facts ?? []).find((f) => f.sourceId === sid);
      if (!fact) continue;
      if (fact.status === "ALLEGED" && partyClaimCategories.has(fact.category)) {
        partyClaimTotal++;
        if (hasEstablishedLang) partyClaimAsHolding++;
      }
    }

    // 6) metadataOnlyHoldingRate — precedent citations that are metadata-
    //    only and referenced as a holding ("Cassation held" etc.).
    const hasHoldingLang =
      lowerText.includes("held") ||
      lowerText.includes("հաստատել է") ||
      lowerText.includes("որոշել է") ||
      lowerText.includes("суд установил");
    for (const sid of sourceIds) {
      if (!metadataOnlyPrecedentIds.has(sid)) continue;
      metadataOnlyTotal++;
      if (hasHoldingLang) metadataOnlyHolding++;
    }

    // 7) unsupportedStrongLegalAssertionRate — legal-assertion trigger
    //    phrases ("law requires", "Cassation held", ...) without an
    //    authority source id.
    const legalTriggers = [
      "law requires",
      "cassation held",
      "concourt stated",
      "constitutional court stated",
      "constitutional court held",
      "echr requires",
      "ecthr held",
      "օրենքը պահանջում է",
      "վճռաբեկ դատարանը հաստատել է",
      "սահմանադրական դատարանը նշել է",
      "եվրոպական դատարանը պահանջում է",
      "закон требует",
      "кассационный суд установил",
      "конституционный суд указал",
      "ектр требует",
    ];
    let sectionHasLegalTrigger = false;
    for (const t of legalTriggers) {
      if (lowerText.includes(t.toLowerCase())) {
        sectionHasLegalTrigger = true;
        break;
      }
    }
    if (sectionHasLegalTrigger) {
      legalAssertionTotal++;
      const hasAuthorityRef = sourceIds.some(
        (s) =>
          LEGISLATION_RE.test(s) ||
          CASSATION_RE.test(s) ||
          CONCOURT_RE.test(s) ||
          ECHR_RE.test(s),
      );
      if (!hasAuthorityRef) unsupportedLegalAssertion++;
    }

    // 8) hiddenMissingInformationRate — sections (per plan) that should
    //    surface [MISSING_INFORMATION] but don't. We approximate by
    //    checking whether empty / stub sections of facts / procedural_
    //    history include the marker.
    if (
      section.sectionType === "facts" ||
      section.sectionType === "procedural_history"
    ) {
      if (text.trim().length === 0 || /\[TODO\]|\[TBD\]|\[\.\.\.]/i.test(text)) {
        sectionsNeedingMissingInfoTotal++;
        if (!/\[MISSING_INFORMATION\]/i.test(text)) hiddenMissingInfo++;
      }
    }
  }

  metrics.fabricatedFactRate = factCitedTotal === 0 ? 0 : factCitedMissing / factCitedTotal;
  metrics.invalidEvidenceIdRate =
    evidenceCitedTotal === 0 ? 0 : evidenceCitedMissing / evidenceCitedTotal;
  metrics.fabricatedCaseRate =
    caseCitedTotal === 0 ? 0 : caseCitedMissing / caseCitedTotal;
  metrics.fabricatedArticleRate =
    articleCitedTotal === 0 ? 0 : articleCitedMissing / articleCitedTotal;
  metrics.fabricatedQuoteRate =
    quoteTotal === 0 ? 0 : quoteMissing / quoteTotal;
  metrics.partyClaimAsHoldingRate =
    partyClaimTotal === 0 ? 0 : partyClaimAsHolding / partyClaimTotal;
  metrics.metadataOnlyHoldingRate =
    metadataOnlyTotal === 0 ? 0 : metadataOnlyHolding / metadataOnlyTotal;
  metrics.unsupportedStrongLegalAssertionRate =
    legalAssertionTotal === 0 ? 0 : unsupportedLegalAssertion / legalAssertionTotal;
  metrics.hiddenMissingInformationRate =
    sectionsNeedingMissingInfoTotal === 0
      ? 0
      : hiddenMissingInfo / sectionsNeedingMissingInfoTotal;

  return metrics;
}

// ---------------------------------------------------------------------------
// §31 — evaluateDraft
// ---------------------------------------------------------------------------

/**
 * §31 — Evaluate a draft against the gold metric rubric.
 *
 * Loads the draft + its latest DraftVersion + sections, rebuilds the
 * DraftingContext + SourceIdMap + DocumentPlan from the stored JSON fields,
 * runs `runAllVerification`, and independently computes the hard metrics by
 * inspecting the draft sections against the closed context.
 *
 * @returns `{ passed, metrics }`:
 *   - `passed` = true iff all hard metrics are 0 AND runAllVerification
 *     returned `passed: true`.
 *   - `metrics` = the computed DraftingGoldMetrics.
 *
 * CRITICAL — §31: "Hard metrics computed, not invented — all must be 0."
 */
export async function evaluateDraft(
  draftId: string,
): Promise<{ passed: boolean; metrics: DraftingGoldMetrics }> {
  // Load the draft.
  const draft = (await db.legalDraft.findUnique({
    where: { id: draftId },
  })) as DraftRow | null;
  if (!draft) {
    throw new Error(`LegalDraft ${draftId} not found`);
  }

  // Load the latest DraftVersion.
  const version = (await db.draftVersion.findFirst({
    where: { draftId },
    orderBy: { version: "desc" },
  })) as VersionRow | null;
  if (!version) {
    // No versions yet — no draft content to evaluate. Metrics are zero
    // (nothing to fabricate), but the draft cannot pass.
    return { passed: false, metrics: { ...ZERO_GOLD_METRICS } };
  }

  // Load DraftSection rows for the version.
  const sectionRows = (await db.draftSection.findMany({
    where: { versionId: version.id },
  })) as SectionRow[];

  // Parse sections into the typed shape.
  const sections: DraftSection[] = sectionRows.map((row) => {
    const content = safeParseJson<{
      text?: string;
      sourceIds?: string[];
    }>(row.content, { text: "", sourceIds: [] });
    return {
      id: row.id,
      draftId: row.draftId,
      versionId: row.versionId,
      sectionType: row.sectionType as DraftSection["sectionType"],
      title: row.title,
      content: {
        text: content.text ?? "",
        sourceIds: Array.isArray(content.sourceIds) ? content.sourceIds : [],
      },
      reviewStatus: row.reviewStatus as DraftSection["reviewStatus"],
      stale: row.stale,
      warnings: safeParseJson<DraftSection["warnings"]>(row.warnings, []),
      previousContent: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  });

  // Rebuild the DraftingContext + SourceIdMap + DocumentPlan from the
  // stored JSON fields on the draft / version rows.
  const ctx: DraftingContext = safeParseJson<DraftingContext>(
    draft.contextSummary,
    {
      caseId: draftId,
      parties: [],
      jurisdiction: null,
      court: null,
      caseNumber: null,
      caseTitle: null,
      caseType: null,
      proceedingType: null,
      facts: [],
      chronology: [],
      evidenceRefs: [],
      legalIssues: [],
      legislation: [],
      cassationCases: [],
      conCourtCases: [],
      echrCases: [],
      distinguishing: {},
      counterAuthorities: [],
      argumentMap: [],
      missingMaterialFacts: [],
      totalChars: 0,
      truncated: false,
    },
  );

  const sourceIdMap: SourceIdMap = safeParseJson<SourceIdMap>(
    version.sourceIdMap,
    {},
  );

  const plan: DocumentPlan = safeParseJson<DocumentPlan>(draft.plan, {
    draftId,
    documentType: draft.documentType as DocumentPlan["documentType"],
    goal: draft.goal ?? "",
    parties: [],
    caseNumber: null,
    court: null,
    jurisdiction: null,
    sections: [],
    materialContradictions: [],
    missingMetadata: [],
    requestedRelief: null,
  });

  // Run the verification firewalls.
  const verification = await runAllVerification(
    draftId,
    sections,
    ctx,
    plan,
    sourceIdMap,
    draft.goal ?? "",
    draft.documentType as DocumentPlan["documentType"],
  );

  // Independently compute the hard metrics.
  const metrics = computeDraftingMetrics(sections, ctx, sourceIdMap);

  // §31 — "all must be 0". The draft passes iff all hard metrics are 0 AND
  // the verification firewalls passed.
  const allMetricsZero = (Object.values(metrics) as number[]).every(
    (v) => v === 0,
  );
  const passed = allMetricsZero && verification.passed;

  return { passed, metrics };
}

// Re-export metrics + fixtures for downstream consumers (the API + UI).
export { ZERO_GOLD_METRICS } from "@/lib/legal-drafting/evaluation/drafting-gold-set";
export type { DraftingGoldMetrics, DraftingGoldFixture } from "@/lib/legal-drafting/evaluation/drafting-gold-set";
