// src/lib/legal-research/pipeline.ts
// RESEARCH INTELLIGENCE PIPELINE (master prompt §3, §72, §104-§109).
//
//   ISSUE MAP -> ROLE CLASSIFICATION -> HOLDING EXTRACTION ->
//   MATERIAL FACTS -> APPLICABILITY -> DISTINGUISHING ->
//   RELATIONS -> TEMPORAL -> HIERARCHY -> CONFLICTS ->
//   ARGUMENT MAP -> COMPLETENESS -> RESEARCH REPORT
//
// Budgets (§71-§72): only the strongest 6-8 full-text authorities enter deep
// analysis; every LLM call is structured + fail-closed; independent
// documents are analyzed in a bounded parallel pool (§106); identical
// contentHash is analyzed once (§107, §73). Every stage is timed and traced
// (§104, §109). Partial results are returned with a warning (§105).

import { ANALYSIS } from "@/lib/legal-search/config";
import type { LegalEvidence } from "@/lib/legal-search/types";
import type {
  ApplicabilityResult,
  DocumentRoleAssessment,
  LegalHolding,
  MaterialFact,
  ResearchReport,
  ResearchStageTrace,
  ResearchInput,
  TemporalAnalysis,
} from "./types";
import { buildIssueMap } from "./issue-map/issue-map";
import { classifyDocumentRole, analysisPriority } from "./analysis/document-role";
import { extractHoldings } from "./analysis/holding-extractor";
import { extractMaterialFacts } from "./analysis/material-facts";
import { analyzeApplicability } from "./analysis/applicability";
import { analyzePrecedentRelations } from "./analysis/precedent-relations";
import { analyzeTemporalApplicability } from "./analysis/temporal-analysis";
import { assessAuthority } from "./analysis/hierarchy-analysis";
import { analyzeConflicts, holdingPolarity } from "./analysis/conflict-analysis";
import { buildArgumentMap } from "./argument/argument-map";
import { detectMissingFacts } from "./analysis/missing-facts";
import { zaiStructuredLlm, runPool, type StructuredLlm } from "./llm";
import { cacheGet, cacheSet } from "./analysis-cache";
import { contentHash } from "@/lib/legal-search/security/url-policy";

export interface PipelineOptions {
  /** Injectable LLM (tests pass a deterministic mock). */
  llm?: StructuredLlm | null;
}

/**
 * Run the full research pipeline over an evidence pack (deep mode only).
 * NEVER throws — always returns a (possibly partial) report (§105/§76).
 */
export async function runResearchPipeline(
  input: ResearchInput,
  opts: PipelineOptions = {},
): Promise<ResearchReport> {
  const t0 = Date.now();
  const stages: ResearchStageTrace[] = [];
  const notes: string[] = [];
  const llm = opts.llm === undefined ? zaiStructuredLlm : opts.llm;

  const timed = async (
    stage: ResearchStageTrace["stage"],
    fn: () => Promise<string | void>,
  ): Promise<string | void> => {
    const s = Date.now();
    try {
      const detail = await fn();
      stages.push({ stage, status: "ok", durationMs: Date.now() - s, detail: detail ?? undefined });
      return detail;
    } catch (err) {
      stages.push({
        stage,
        status: "failed",
        durationMs: Date.now() - s,
        detail: err instanceof Error ? err.message : "unknown error",
      });
      return undefined;
    }
  };

  const outOfTime = () => Date.now() > input.deadline - 1_500;
  let ranOutOfTime = false;

  // ---- 1. Issue map --------------------------------------------------------
  const issueMap: ResearchReport["issueMap"] = {
    issues: [],
    userFacts: [],
    question: input.query,
    builtBy: "deterministic",
  };
  await timed("issue_map", async () => {
    const map = await buildIssueMap(input.query, input.understanding, llm, input.deadline);
    issueMap.issues = map.issues;
    issueMap.userFacts = map.userFacts;
    issueMap.builtBy = map.builtBy;
    return `${map.issues.length} issues (${map.builtBy})`;
  });

  // ---- 2. Role classification (deterministic) -------------------------------
  let roles: DocumentRoleAssessment[] = [];
  await timed("role_classification", async () => {
    roles = input.evidence.map((e) => classifyDocumentRole(e));
    return `${roles.length} classified`;
  });

  // ---- 3. Select analyzable precedents (§72: 6-8 strongest) -----------------
  const analyzable = input.evidence
    .filter((e) => e.fullTextVerified && (e.passage?.length ?? 0) >= 120)
    .map((e) => ({ e, role: roles.find((r) => r.evidenceId === e.id)! }))
    .sort((a, b) => analysisPriority(b.role, b.e) - analysisPriority(a.role, a.e))
    .slice(0, ANALYSIS.maxPrecedentsAnalyzed)
    .map((x) => x.e);

  // ---- 4. Holdings + material facts (parallel, cached, bounded) --------------
  const holdingsByDoc = new Map<string, LegalHolding[]>();
  const factsByDoc = new Map<string, MaterialFact[]>();

  await timed("holding_extraction", async () => {
    const results = await runPool(analyzable, ANALYSIS.maxConcurrentLlmCalls, async (item) => {
      const e = item as LegalEvidence;
      if (outOfTime()) {
        ranOutOfTime = true;
        return [];
      }
      const hash = contentHash(e.passage);
      const cached = cacheGet<LegalHolding[]>(hash, "holdings");
      if (cached) return cached;
      const hs = llm ? await extractHoldings(e, llm, input.deadline) : [];
      cacheSet(hash, "holdings", hs);
      return hs;
    });
    results.forEach((hs, i) => holdingsByDoc.set(analyzable[i].id, hs));
    const total = results.reduce((n, hs) => n + hs.length, 0);
    return `${total} verified holdings from ${analyzable.length} docs`;
  });

  await timed("material_facts", async () => {
    const results = await runPool(analyzable, ANALYSIS.maxConcurrentLlmCalls, async (item) => {
      const e = item as LegalEvidence;
      if (outOfTime()) {
        ranOutOfTime = true;
        return [];
      }
      const hash = contentHash(e.passage);
      const cached = cacheGet<MaterialFact[]>(hash, "facts");
      if (cached) return cached;
      const fs = llm ? await extractMaterialFacts(e, 0.7, llm, input.deadline) : [];
      cacheSet(hash, "facts", fs);
      return fs;
    });
    results.forEach((fs, i) => factsByDoc.set(analyzable[i].id, fs));
    const total = results.reduce((n, fs) => n + fs.length, 0);
    return `${total} material facts`;
  });

  // ---- 5. Temporal analysis (deterministic) ----------------------------------
  const temporalByDoc = new Map<string, TemporalAnalysis>();
  await timed("temporal_analysis", async () => {
    for (const e of input.evidence) {
      temporalByDoc.set(e.id, analyzeTemporalApplicability(e, input.evidence, input.understanding));
    }
    const risks = [...temporalByDoc.values()].filter((t) => t.compatibility === "POTENTIALLY_STALE").length;
    return `${risks} temporal risks`;
  });

  // ---- 6. Applicability (per issue x precedent, deterministic) ----------------
  // NOTE: no outOfTime guard here — this stage is deterministic and costs
  // microseconds per pair. Skipping it when the LLM stages overran produced
  // empty applicability for the whole report (§105 violation found in live
  // verification); partial analysis must still carry the structured fields.
  let applicability: ApplicabilityResult[] = [];
  await timed("applicability", async () => {
    for (const issue of issueMap.issues) {
      for (const e of input.evidence) {
        const t = temporalByDoc.get(e.id);
        applicability.push(
          analyzeApplicability(
            issue,
            issueMap.userFacts,
            e,
            input.understanding,
            holdingsByDoc.get(e.id) ?? [],
            factsByDoc.get(e.id) ?? [],
            t?.compatibility ?? "UNKNOWN",
            t?.laterAuthorities ?? [],
          ),
        );
      }
    }
    const analyzed = applicability.filter((a) => !a.metadataOnly).length;
    return `${analyzed} analyzed pairs`;
  });

  // ---- 7. Relations (deterministic) -------------------------------------------
  let relations: ResearchReport["relations"] = [];
  await timed("precedent_relations", async () => {
    relations = analyzePrecedentRelations(input.evidence);
    return `${relations.length} relations`;
  });

  // ---- 8. Hierarchy (deterministic) --------------------------------------------
  let hierarchy: ResearchReport["hierarchy"] = [];
  await timed("hierarchy_analysis", async () => {
    hierarchy = input.evidence.map(assessAuthority);
    return `${hierarchy.length} assessments`;
  });

  // ---- 9. Conflicts (deterministic, conservative) --------------------------------
  let conflicts: ResearchReport["conflicts"] = [];
  await timed("conflict_analysis", async () => {
    conflicts = analyzeConflicts(issueMap.issues, input.evidence, [...holdingsByDoc.values()].flat(), relations);

    // §48 — role upgrade: a verified holding that addresses the user's issue
    // with the OPPOSITE polarity is a COUNTER_AUTHORITY (never hidden).
    for (const e of analyzable) {
      const hs = holdingsByDoc.get(e.id) ?? [];
      const app = applicability.find((a) => a.precedentId === e.id);
      const addressesIssue =
        !!app && (app.legalIssueMatch === "STRONG" || app.legalIssueMatch === "PARTIAL");
      const negative = hs.some((h) => h.verification !== "REJECT" && holdingPolarity(h) === -1);
      if (addressesIssue && negative) {
        const role = roles.find((r) => r.evidenceId === e.id);
        if (role && role.role !== "COUNTER_AUTHORITY") {
          role.role = "COUNTER_AUTHORITY";
          role.rationale = "Ստուգված իրավական դիրքը հակադիր եզրակացություն է պարունակում այս հարցի վերաբերյալ։";
        }
      }
    }
    return `${conflicts.length} conflicts`;
  });

  // ---- 10. Argument map ------------------------------------------------------------
  const allHoldings = [...holdingsByDoc.values()].flat();
  let arguments_ : ResearchReport["arguments"] = [];
  await timed("argument_map", async () => {
    arguments_ = buildArgumentMap(issueMap.issues, input.evidence, roles, allHoldings, applicability, relations);
    return `${arguments_.length} arguments`;
  });

  // ---- 11. Missing facts --------------------------------------------------------------
  const missingFacts = detectMissingFacts(issueMap.issues, applicability);

  // ---- 12. Completeness + report --------------------------------------------------------
  const precedentsAnalyzed = analyzable.length;
  const counterAuthorities = applicability.filter(
    (a) =>
      a.conclusion === "NOT_MATERIALLY_APPLICABLE" ||
      roles.find((r) => r.evidenceId === a.precedentId)?.role === "COUNTER_AUTHORITY",
  ).length;
  const temporalRisks = [...temporalByDoc.values()].filter(
    (t) => t.compatibility === "POTENTIALLY_STALE" || t.compatibility === "INCOMPATIBLE",
  ).length;

  await timed("synthesis", async () => "report assembled");

  const partial =
    stages.some((s) => s.status === "failed") ||
    ranOutOfTime ||
    Date.now() > input.deadline ||
    (llm === null && analyzable.length > 0);
  if (stages.some((s) => s.status === "failed")) {
    notes.push("Որոշ վերլուծական փուլեր չեն ավարտվել. արդյունքները մասնակի են։");
  }
  if (llm === null) {
    notes.push("Վերլուծական մոդելն անհասանելի էր (ANALYSIS_UNAVAILABLE). կիրառելիության կառուցվածքային դաշտերը որոշված են, բայց holding-ներ չկան։");
  }

  return {
    version: ANALYSIS.cacheVersion,
    mode: "deep",
    issueMap,
    roles,
    holdings: allHoldings,
    materialFacts: [...factsByDoc.values()].flat(),
    applicability,
    relations,
    temporal: [...temporalByDoc.values()],
    hierarchy,
    conflicts,
    arguments: arguments_,
    missingFacts,
    completeness: {
      issuesIdentified: issueMap.issues.length,
      issuesSupported: issueMap.issues.filter((i) => i.status === "SUPPORTED").length,
      unresolvedIssues: issueMap.issues.filter((i) => i.status === "UNRESOLVED" || i.status === "OPEN").length,
      precedentsAnalyzed,
      counterAuthoritiesFound: counterAuthorities,
      temporalRisks,
    },
    stages,
    partial,
    notes,
  };
}
