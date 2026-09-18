// src/lib/legal-search/engine/search-engine.ts
// The LIVE FEDERATED LEGAL SEARCH engine (spec §0, §14, §23) — v2 (Phase 3).
//
//   QUERY UNDERSTANDING -> SEMANTIC QUERY EXPANSION -> PARALLEL LIVE SEARCH
//   -> UNIVERSAL DOCUMENT RESOLUTION (2.0) -> PASSAGE EXTRACTION
//   -> LEGAL RERANKING -> DEDUPLICATION -> TEMPORAL VALIDATION
//   -> [DEEP: SECOND RESEARCH PASS — follow exact references]
//   -> EVIDENCE PACK (grades + verification flags) -> RETRIEVAL COMPLETENESS
//
// Modes:
//   QUICK        — local laws + ARLIS + ConCourt + Datalex (fast answer);
//   DEEP (Խորը)  — LLM decomposition + multi-source + court practice +
//                  Constitutional Court + HUDOC + web cross-check +
//                  reference following (PASS 2).
//
// The engine NEVER does legal analysis (spec §22) — it only collects
// verifiable evidence with canonical URLs.

import { randomUUID } from "node:crypto";
import type {
  FederatedSearchResponse,
  LegalSearchQuery,
  LegalSearchResult,
  QueryUnderstanding,
  ResumableDocument,
  RetrievalCompleteness,
  SearchContext,
  SearchMode,
  SearchTrace,
  SearchWarning,
  SourceTraceEntry,
  TraceStageStatus,
} from "../types";
import { TIMEOUTS, STAGES, RESOLUTION, CONCURRENCY } from "../config";
import { understandQuery, understandQueryWithLLM } from "./query-understanding";
import { expandQuery } from "./query-expansion";
import { orchestrateSources } from "./source-orchestrator";
import { deduplicate } from "./deduplicator";
import { rerank } from "./legal-reranker";
import { extractPassages, bestPassage } from "./passage-extractor";
import { buildEvidencePack, evidenceToLegacySources } from "./evidence-builder";
import { validateTemporal, temporalWarnings } from "./temporal-validator";
import { contentHash } from "../security/url-policy";
import { resolveLegalDocument } from "./document-resolver";
import { selectFollowableReferences } from "./reference-extractor";
import { datalexSearchGridCached } from "../sources/datalex/client";
import { concourtSearch } from "../sources/constitutional-court/client";
import { searchHudocViaWebDiscovery } from "../sources/hudoc/client";
import { HudocQueryBuilder } from "../sources/hudoc/query-builder";
import { invokeWebSearch } from "../sources/web-search-client";
import { runResearchPipeline } from "@/lib/legal-research/pipeline";
import { ANALYSIS, OFFICIAL_DOMAINS } from "../config";
import { tokenize } from "@/lib/legal/normalizer";

/** Official-grade sources for evidence classification (§45). */
const OFFICIAL_SOURCE_IDS = new Set([
  "arlis",
  "local-laws",
  "constitutional-court",
  "judiciary",
  "datalex",
  "hudoc",
]);

export async function federatedSearch(
  rawQuery: string,
  opts: { mode?: SearchMode } = {},
): Promise<FederatedSearchResponse> {
  const start = Date.now();
  const mode: SearchMode = opts.mode === "deep" ? "deep" : "quick";
  const requestId = randomUUID();

  const deadline = Date.now() + (mode === "deep" ? TIMEOUTS.deepTotalMs : TIMEOUTS.quickTotalMs);
  const context: SearchContext = {
    deadline,
    sourceTimeoutMs: TIMEOUTS.sourceMs,
    documentTimeoutMs: TIMEOUTS.documentMs,
    mode,
    requestId,
  };

  // ---- 1. Query understanding (+ LLM decomposition in deep mode, §24) ------
  let understanding: QueryUnderstanding = understandQuery(rawQuery);
  if (mode === "deep" && !understanding.hasExactReference && rawQuery.length > 25) {
    understanding = await understandQueryWithLLM(rawQuery, understanding, TIMEOUTS.llmUnderstandingMs);
  }
  understanding = expandQuery(understanding, mode);

  const query: LegalSearchQuery = {
    raw: rawQuery,
    understanding,
    variants: understanding.variants,
    mode,
  };

  const trace: SearchTrace = {
    mode,
    sources: [],
    expandedQueries: understanding.variants.map((v) => v.text),
    subquestions: understanding.subquestions,
    documentsFetched: 0,
    passagesExtracted: 0,
    totalDurationMs: 0,
  };
  const warnings: SearchWarning[] = [];

  // ---- 2. Parallel live source search (stage 1) -----------------------------
  const orchestrated = await orchestrateSources(query, context);
  trace.sources = orchestrated.trace;

  // Surface RESTRICTED sources as user-visible warnings (spec §12).
  for (const t of orchestrated.trace) {
    if (t.status === "RESTRICTED") {
      warnings.push({
        kind: "restricted",
        message: `${t.name}. ${t.detail ?? "Աղբյուրը սահմանափակված է ավտոմատ մուտքի համար։"}${
          t.fallbackUrl ? " Որոնումը կարող եք բացել ձեր բրաուզերով՝ «Որոնումը կատարվել է» բլոկում։" : ""
        }`,
      });
    }
  }

  let candidates = orchestrated.results;

  // ---- 3. Deduplicate (spec §19) ----------------------------------------------
  candidates = deduplicate(candidates);

  // ---- 4. Rerank pass 1 -> top-K (stage 2) --------------------------------------
  let top = rerank(candidates, understanding, mode, STAGES.rerankKeep);

  // ---- 5. Universal document resolution (stage 3, Phase 3 §30-§33) ------------
  const fetchBudget = mode === "deep" ? STAGES.deepFetchDocs : STAGES.quickFetchDocs;
  const toResolve = top.slice(0, fetchBudget);
  const resolverOpts = { fallback: mode === "deep" ? ("full" as const) : ("official" as const) };

  const queryTokens = new Set(understanding.parsed.keywords.filter((k) => k.length >= 3));
  // Multilingual variants join the token set so English/Russian documents
  // score against the translated concepts too (spec §11).
  for (const mv of understanding.multilingual ?? []) {
    for (const t of mv.text.toLowerCase().split(/[^a-zа-яё0-9]+/)) {
      if (t.length >= 4) queryTokens.add(t);
    }
  }
  const conceptPhrases = [
    ...understanding.concepts.map((c) => c.hy),
    ...understanding.concepts.map((c) => c.en ?? "").filter(Boolean),
  ];

  let fetched = 0;
  let extracted = 0;
  const resolutionNotes = new Map<string, string>();

  // Bounded concurrency pool for document resolution (§55).
  const queue = [...toResolve];
  const workers = Array.from({ length: Math.min(CONCURRENCY.maxConcurrentDocumentFetches, queue.length) }, async () => {
    while (queue.length > 0 && Date.now() < context.deadline - 800) {
      const r = queue.shift();
      if (!r) break;
      try {
        const resolved = await resolveLegalDocument(
          {
            sourceId: r.sourceId,
            sourceName: r.sourceName,
            sourceType: r.sourceType,
            authority: r.authority,
            url: r.url,
            title: r.title,
            court: r.court,
            caseNumber: r.caseNumber,
            applicationNumber: r.sourceId === "hudoc" ? r.caseNumber : undefined,
            actNumber: r.actNumber,
            article: r.article,
            date: r.date,
            externalId: r.externalId,
            excerpt: r.excerpt,
          },
          context,
          resolverOpts,
        );

        if (resolved.status === "FULL_TEXT" && resolved.text) {
          r.fullText = resolved.text;
          r.fullTextVerified = resolved.identityVerified;
          r.identityVerified = resolved.identityVerified;
          r.resolvedVia = resolved.method;
          r.resolvedViaUrl = resolved.sourceUrl;
          r.resolvedViaSource = resolved.sourceName;
          r.accessState = "DIRECT";
          fetched++;
          const passages = extractPassages(r, resolved.text, queryTokens, conceptPhrases);
          if (passages.length > 0) extracted++;
          if (resolved.method !== "DIRECT_API") {
            resolutionNotes.set(
              r.sourceId,
              `ամբողջական տեքստը գտնվել է այլ աղբյուրում՝ ${resolved.sourceName}`,
            );
          }
        } else if (resolved.status === "CAPTCHA_REQUIRED") {
          r.accessState = "CAPTCHA_REQUIRED";
          r.fullTextVerified = false;
        } else if (resolved.status === "METADATA_ONLY" && resolved.accessState === "RESTRICTED") {
          r.accessState = "RESTRICTED";
        }
        // METADATA_ONLY without restriction: keep the honest default flags.
      } catch {
        // best-effort: metadata remains
      }
    }
  });
  await Promise.allSettled(workers);
  trace.documentsFetched = fetched;
  trace.passagesExtracted = extracted;

  // ---- 6. Rerank pass 2 (passages now available) + temporal validation ----------
  top = rerank(top, understanding, mode, STAGES.rerankKeep);
  top = top.map(validateTemporal);

  // ---- 6b. DEEP MODE: second research pass — follow exact references (§38) ----
  let pass2Added = 0;
  if (
    mode === "deep" &&
    RESOLUTION.maxResearchPasses >= 2 &&
    Date.now() < context.deadline - 6_000
  ) {
    const followRefs = selectFollowableReferences(
      top.filter((r) => r.fullText),
      top,
      RESOLUTION.maxReferenceFollows,
    );

    const pass2Context: SearchContext = {
      ...context,
      deadline: Math.min(context.deadline, Date.now() + 14_000),
    };

    for (const ref of followRefs) {
      if (Date.now() > pass2Context.deadline - 2_000) break;
      try {
        const added = await followReference(ref, pass2Context, queryTokens, conceptPhrases);
        if (added) {
          top.push(added);
          pass2Added++;
        }
      } catch {
        // best-effort reference following
      }
    }

    if (pass2Added > 0) {
      top = rerank(deduplicate(top), understanding, mode, STAGES.rerankKeep).map(validateTemporal);
    }
  }

  // Content hashes for downstream dedup/debugging.
  for (const r of top) {
    const basis = r.passages?.[0] ?? r.excerpt;
    if (basis) r.contentHash = contentHash(basis);
  }

  // ---- 7. Evidence pack (stage 4) with grades + verification flags -------------
  let evidence = buildEvidencePack(top);

  // ---- 7b. Resumable documents (§63-§64) — unlockable via interactive flow ----
  const resumable: ResumableDocument[] = [];
  const seenRefs = new Set<string>();
  for (const r of top) {
    if (r.accessState === "CAPTCHA_REQUIRED" && r.externalId) {
      const ref = `${r.sourceId}:${r.externalId}`;
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      resumable.push({
        documentRef: ref,
        source: r.sourceId,
        sourceName: r.sourceName,
        title: r.title,
        caseNumber: r.caseNumber,
        url: r.url,
        accessState: "CAPTCHA_REQUIRED",
      });
      if (resumable.length >= 3) break; // bounded UI surface
    }
  }

  // ---- 7c. Retrieval completeness (§52) — factual, no fake confidence ----------
  const completeness = computeCompleteness(top, evidence, candidates.length);
  trace.completeness = completeness;

  // Trace v2 (§50): per-source search/metadata/document stages.
  trace.sources = trace.sources.map((entry) => enrichTraceEntry(entry, top, resolutionNotes));

  // ---- 7d. PHASE 4: research intelligence layer (deep mode, §72) --------------
  let research: import("@/lib/legal-research/types").ResearchReport | undefined;
  if (mode === "deep" && evidence.length > 0 && Date.now() < deadline + ANALYSIS.timeBudgetMs) {
    research = await runDeepResearch(
      { query: rawQuery, understanding, evidence, deadline: Date.now() + ANALYSIS.timeBudgetMs },
      top,
      candidates,
      understanding,
      context,
      async (refreshed) => {
        // §70 second pass callback — extend the pack with verified finds.
        top.length = 0;
        top.push(...refreshed);
      },
    );
    evidence = buildEvidencePack(top);

    if (research.completeness.temporalRisks > 0) {
      warnings.push({
        kind: "temporal",
        message: `${research.completeness.temporalRisks} աղբյուր ունի ժամանակային ռիսկ (ավելի ուշ պրակտիկա կամ խմբագրություն). մանրամասները՝ նախադեպի քարտի վրա։`,
      });
    }
    if (research.partial) {
      warnings.push({
        kind: "partial",
        message: "Խորքային վերլուծությունն ավարտվել է մասնակի. որոշ բաղադրիչներ կարող են բացակայել։",
      });
    }
  }

  // ---- 8. Temporal warnings (spec §18) ----------------------------------------
  warnings.push(...temporalWarnings(understanding, top));

  // Partial-results warning when many sources failed.
  const failedSources = trace.sources.filter(
    (s) => s.status === "ERROR" || s.status === "TIMEOUT" || s.status === "RATE_LIMITED",
  );
  if (failedSources.length >= 2 && evidence.length > 0) {
    warnings.push({
      kind: "partial",
      message: `Որոնումը մասնակի է. ${failedSources
        .map((s) => s.name)
        .join(", ")} աղբյուրները ժամանակավորապես անհասանելի էին։`,
    });
  }

  // CAPTCHA note (§51): explain what "source confirmation" means.
  if (resumable.length > 0) {
    warnings.push({
      kind: "partial",
      message: `${resumable.length} դատական գործի ամբողջական տեքստը պահանջում է աղբյուրի հաստատում (Datalex CAPTCHA)։ Մետատվյալները և սկզբնաղբյուրի հղումները վավեր են։`,
    });
  }

  trace.totalDurationMs = Date.now() - start;

  const ok = trace.sources.some((s) => s.status === "SUCCESS" || s.status === "PARTIAL") || evidence.length > 0;

  return {
    query: rawQuery,
    normalizedQuery: understanding.parsed.normalized,
    parsed: understanding.parsed,
    mode,
    results: evidenceToLegacySources(evidence),
    evidence,
    trace,
    warnings,
    completeness,
    resumable,
    research,
    retrieval: {
      ok,
      durationMs: Date.now() - start,
      error: ok ? undefined : "Ոչ մի աղբյուր չի պատասխանել։",
    },
    requestId,
  };
}

// ---------------------------------------------------------------------------
// PHASE 4 — deep research orchestration + bounded second pass (§70, §105)
// ---------------------------------------------------------------------------

async function runDeepResearch(
  input: import("@/lib/legal-research/types").ResearchInput,
  top: LegalSearchResult[],
  _candidates: LegalSearchResult[],
  understanding: QueryUnderstanding,
  context: SearchContext,
  refreshTop: (refreshed: LegalSearchResult[]) => Promise<void>,
): Promise<import("@/lib/legal-research/types").ResearchReport> {
  let report = await runResearchPipeline(input);

  // §70 — bounded SECOND RESEARCH PASS when the applicability engine flags
  // that a later authority may exist (temporal risks with an identified
  // provision). We do NOT make the LLM guess: one bounded exact search per
  // flagged provision, max ANALYSIS.secondPassMaxQueries queries.
  const flagged = report.temporal.filter(
    (t) => t.compatibility === "POTENTIALLY_STALE" && t.lawVersion,
  );
  if (
    flagged.length > 0 &&
    Date.now() < input.deadline + ANALYSIS.secondPassTimeoutMs * ANALYSIS.secondPassMaxQueries
  ) {
    const added: LegalSearchResult[] = [];
    for (const t of flagged.slice(0, ANALYSIS.secondPassMaxQueries)) {
      const ev = input.evidence.find((e) => e.id === t.evidenceId);
      if (!ev) continue;
      const q = `${t.lawVersion} վճռաբեկ դատարան իրավական դիրք նոր պրակտիկա`;
      const items = await invokeWebSearch(q, 3, ANALYSIS.secondPassTimeoutMs);
      if (!items) break; // quota exhausted / timeout — do not keep hammering
      for (const item of items) {
        if (!OFFICIAL_DOMAINS.some((d) => item.url?.includes(d))) continue; // official only
        if (top.some((r) => r.url === item.url)) continue;
        added.push({
          sourceId: "web",
          sourceName: item.host_name ?? "Web",
          sourceType: "web",
          authority: 20,
          title: item.name?.slice(0, 200) ?? "",
          url: item.url,
          excerpt: item.snippet ?? "",
          temporalStatus: "unknown",
          relevance: 0.2,
          retrievedAt: new Date().toISOString(),
        });
      }
    }
    if (added.length > 0) {
      top.push(...added);
      const refreshed = rerank(deduplicate(top), understanding, "deep", STAGES.rerankKeep).map(
        validateTemporal,
      );
      await refreshTop(refreshed);
      const refreshedEvidence = buildEvidencePack(refreshed);
      if (refreshedEvidence.length > 0) {
        input = { ...input, evidence: refreshedEvidence };
        // Cache-warm re-run: analyzed documents are LRU-cached (§73).
        report = await runResearchPipeline({
          ...input,
          deadline: Date.now() + Math.max(4_000, ANALYSIS.timeBudgetMs / 2),
        });
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// PASS 2 — follow one exact reference (§37-§39)
// ---------------------------------------------------------------------------

async function followReference(
  ref: ReturnType<typeof selectFollowableReferences>[number],
  context: SearchContext,
  queryTokens: Set<string>,
  conceptPhrases: string[],
): Promise<LegalSearchResult | null> {
  if (ref.kind === "echr_application") {
    // ECHR application cited by an Armenian court -> HUDOC exact lookup.
    const outcome = await searchHudocViaWebDiscovery(HudocQueryBuilder.exactApplication(ref.value), {
      timeoutMs: Math.max(2_000, context.deadline - Date.now()),
      maxResults: 2,
    });
    if (outcome.kind !== "ok") return null;
    const doc = outcome.documents[0];
    if (!doc) return null;
    const result: LegalSearchResult = {
      sourceId: "hudoc",
      sourceName: "HUDOC — ՄԻԵՎԴ",
      sourceType: "echr",
      authority: 85,
      title: `${doc.caseName}${doc.applicationNumbers[0] ? ` (no. ${doc.applicationNumbers[0]})` : ""}`.slice(0, 200),
      url: doc.canonicalUrl,
      court: "Եվրոպական դատարան (ՄԻԵՎԴ)",
      caseNumber: doc.applicationNumbers[0],
      date: doc.decisionDate,
      temporalStatus: "unknown",
      excerpt: (doc.snippet ?? doc.caseName).slice(0, 500),
      relevance: 0,
      retrievedAt: new Date().toISOString(),
      externalId: doc.itemId,
      metadataVerified: true,
      fullTextVerified: false,
      resolvedVia: "WEB_DISCOVERY",
      meta: { followedReference: ref.value, itemId: doc.itemId },
    };
    void queryTokens;
    void conceptPhrases;
    return result;
  }

  if (ref.kind === "armenian_case_number") {
    // Armenian case number -> Datalex exact lookup (matchType 5, §29).
    for (const tab of ["civil", "criminal", "administrative"] as const) {
      if (Date.now() > context.deadline - 1_500) return null;
      try {
        const grid = await datalexSearchGridCached({
          tab,
          text: ref.value,
          matchType: 5,
          rows: 2,
          timeoutMs: Math.max(2_000, Math.min(8_000, context.deadline - Date.now())),
        });
        const row = grid.result?.data?.[0];
        if (!row) continue;
        const externalId = ((row.case_external_id || row._id) ?? "").toString();
        const caseNumber = (row.case_number ?? "").toString().trim();
        if (!externalId || !caseNumber) continue;
        const isPrec = String(row.is_precedent ?? "") === "1";
        const result: LegalSearchResult = {
          sourceId: isPrec ? "judiciary" : "datalex",
          sourceName: isPrec ? "Վճռաբեկ դատարան — նախադեպ" : "Datalex",
          sourceType: isPrec ? "cassation" : "case_law",
          authority: isPrec ? 90 : 75,
          title: `Դատական գործ ${caseNumber} (հղում այլ որոշումից)`,
          url: `https://datalex.am/?app=${isPrec ? "AppPrecedentCaseSearch" : "AppCaseSearch"}&case_id=${encodeURIComponent(externalId)}`,
          court: (row.court_name || row.instance_name || "").toString().trim() || undefined,
          caseNumber,
          date: (row.verdict_date || row.final_date || row.start_date || "").toString().trim() || undefined,
          temporalStatus: "unknown",
          excerpt: (row.claim ?? caseNumber).toString().slice(0, 400),
          relevance: 0,
          retrievedAt: new Date().toISOString(),
          externalId,
          metadataVerified: true,
          fullTextVerified: false,
          accessState: "CAPTCHA_REQUIRED",
          meta: { followedReference: ref.value, appName: isPrec ? "AppPrecedentCaseSearch" : "AppCaseSearch" },
        };
        return result;
      } catch {
        // best-effort
      }
    }
    return null;
  }

  if (ref.kind === "concourt_decision") {
    // ՍԴՈ number -> Constitutional Court lookup (word-root search on the number).
    try {
      const { decisions } = await concourtSearch(ref.value.replace("ՍԴՈ-", ""), {
        matchType: 5,
        timeoutMs: Math.max(2_000, Math.min(9_000, context.deadline - Date.now())),
      });
      const found = decisions.find((d) => d.number && ref.value.endsWith(d.number.replace(/^ՍԴՈ\s*[-–—]?\s*/, "")));
      if (!found || !found.pdfUrl) return null;
      return {
        sourceId: "constitutional-court",
        sourceName: "Սահմանադրական դատարան",
        sourceType: "constitutional_court",
        authority: 95,
        title: `Սահմանադրական դատարանի որոշում ${found.number ?? ""} (հղում այլ որոշումից)`,
        url: found.pdfUrl,
        court: "ՀՀ Սահմանադրական դատարան",
        caseNumber: found.number,
        date: found.decisionDate ?? found.publicationDate,
        temporalStatus: "unknown",
        excerpt: found.passages[0]?.slice(0, 400) ?? found.title ?? "ՍԴ որոշում",
        passages: found.passages.slice(0, 2),
        relevance: 0,
        retrievedAt: new Date().toISOString(),
        externalId: found.pdfUrl.split("/").pop(),
        metadataVerified: true,
        fullTextVerified: false,
        meta: { followedReference: ref.value },
      };
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trace enrichment + completeness (§50, §52)
// ---------------------------------------------------------------------------

function enrichTraceEntry(
  entry: SourceTraceEntry,
  top: LegalSearchResult[],
  resolutionNotes: Map<string, string>,
): SourceTraceEntry {
  const results = top.filter((r) => r.sourceId === entry.id);
  const search: TraceStageStatus =
    entry.status === "SUCCESS" || entry.status === "PARTIAL"
      ? "ok"
      : entry.status === "EMPTY" || entry.status === "UNSUPPORTED"
        ? "skipped"
        : entry.status === "RESTRICTED"
          ? "restricted"
          : "failed";

  const withMetadata = results.filter((r) => r.metadataVerified).length;
  const metadata: TraceStageStatus =
    entry.status === "PARTIAL" || (entry.status === "SUCCESS" && withMetadata > 0)
      ? "ok"
      : entry.status === "SUCCESS"
        ? "partial" // results without explicit metadata verification
        : search === "ok"
          ? "partial"
          : "skipped";

  const fullTexts = results.filter((r) => r.fullTextVerified).length;
  const gated = results.filter((r) => r.accessState === "CAPTCHA_REQUIRED").length;
  let document: TraceStageStatus;
  if (fullTexts > 0) document = "ok";
  else if (gated > 0) document = "partial";
  else if (entry.status === "RESTRICTED") document = "restricted";
  else if (results.length > 0) document = "partial";
  else document = "skipped";

  const note = resolutionNotes.get(entry.id);
  const resolutionNote =
    note ??
    (gated > 0 && fullTexts === 0
      ? "ամբողջական տեքստը պահանջում է աղբյուրի հաստատում (CAPTCHA)"
      : undefined);

  return { ...entry, stages: { search, metadata, document, resolutionNote } };
}

function computeCompleteness(
  top: LegalSearchResult[],
  evidence: ReturnType<typeof buildEvidencePack>,
  documentsFound: number,
): RetrievalCompleteness {
  const scope = evidence.length > 0 ? evidence : [];
  const metadataVerified = scope.filter((e) => e.metadataVerified).length;
  const fullTextsVerified = scope.filter((e) => e.fullTextVerified).length;
  const resolvedViaFallback = scope.filter((e) =>
    ["OTHER_OFFICIAL_SOURCE", "WEB_DISCOVERY", "SECONDARY_SOURCE"].includes(e.resolvedVia ?? ""),
  ).length;
  const metadataOnly = scope.filter((e) => e.metadataVerified && !e.fullTextVerified).length;
  void top;
  return {
    documentsFound: Math.max(documentsFound, scope.length),
    metadataVerified,
    fullTextsVerified,
    resolvedViaFallback,
    metadataOnly,
  };
}

/** Expose bestPassage for the API layer. */
export { bestPassage };
