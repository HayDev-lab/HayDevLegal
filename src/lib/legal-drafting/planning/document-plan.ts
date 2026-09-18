// src/lib/legal-drafting/planning/document-plan.ts
// Phase 6 §12 — Build a structured DocumentPlan BEFORE prose.
//
// §12 — Every section has a required/optional flag + internal source id
// references. The plan verifies:
//   - Factual sections have evidence (every F-id has at least one supporting
//     evidence ref OR the section is flagged [MISSING_INFORMATION]).
//   - Legal issues have authority or an unresolved flag.
//   - Remedy matches goal + document type + verified procedural context.
//   - Required metadata is present, otherwise flagged.
//   - Material contradictions are surfaced.
//
// The plan NEVER fabricates missing fields — they are flagged as
// [MISSING_INFORMATION] and the plan's `missing_metadata` /
// `materialContradictions` arrays surface them for the drafter.

import {
  allSectionsForType,
  getDocumentTypeSpec,
  validateDraftMetadata,
} from "../registry/document-types";
import { selectIssuesForDraft } from "./issue-selection";
import type {
  DocumentPlan,
  DocumentPlanSection,
  DocumentType,
  DraftingContext,
  SectionWarning,
  SectionType,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** §9 — Return the set of source ids for facts that have at least one supporting evidence ref. */
function factsWithEvidence(ctx: DraftingContext): Set<string> {
  const out = new Set<string>();
  for (const f of ctx.facts) {
    if (f.supportingEvidence.length > 0) out.add(f.sourceId);
  }
  return out;
}

/** Return the set of source ids for facts that are contradicted / disputed. */
function contradictedFacts(ctx: DraftingContext): Set<string> {
  const out = new Set<string>();
  for (const f of ctx.facts) {
    if (
      f.status === "DISPUTED" ||
      f.status === "CONTRADICTED" ||
      f.contradictingEvidence.length > 0
    ) {
      out.add(f.sourceId);
    }
  }
  return out;
}

/** Return all legal-authority source ids (legislation + cassation + concourt + echr). */
function allAuthoritySourceIds(ctx: DraftingContext): Set<string> {
  const out = new Set<string>();
  for (const l of ctx.legislation) out.add(l.sourceId);
  for (const c of ctx.cassationCases) out.add(c.sourceId);
  for (const c of ctx.conCourtCases) out.add(c.sourceId);
  for (const e of ctx.echrCases) out.add(e.sourceId);
  return out;
}

// ---------------------------------------------------------------------------
// Per-section source-id collectors
// ---------------------------------------------------------------------------

function collectSourceIdsForSection(
  sectionType: SectionType,
  ctx: DraftingContext,
  factsWithEv: Set<string>,
  contradicted: Set<string>,
  authorities: Set<string>,
  selectedIssueIds: string[],
): { sourceIds: string[]; missing: boolean; needsSupport: boolean; warnings: SectionWarning[] } {
  const sourceIds: string[] = [];
  const warnings: SectionWarning[] = [];
  let missing = false;
  let needsSupport = false;

  switch (sectionType) {
    case "header":
    case "introduction":
    case "attachments":
    case "missing_information":
      // Mechanical sections — no source ids needed (deterministic assembler
      // fills them from ctx identity fields).
      break;

    case "procedural_history":
      for (const e of ctx.chronology) {
        sourceIds.push(e.sourceId);
        if (e.hasConflict) {
          warnings.push({
            type: "PROCEDURAL_CONFLICT",
            detail: `Chronology event ${e.sourceId} has a documented conflict: ${e.conflictDetail ?? "(no detail)"}`,
            sourceId: e.sourceId,
          });
        }
      }
      if (ctx.chronology.length === 0) {
        missing = true;
        warnings.push({
          type: "MISSING_PROCEDURAL_HISTORY",
          detail:
            "No verified chronology events in the bounded context — procedural_history section cannot be assembled from documentary evidence.",
        });
      }
      break;

    case "facts":
      for (const f of ctx.facts) {
        sourceIds.push(f.sourceId);
        if (!factsWithEv.has(f.sourceId) && f.status !== "USER_CONFIRMED") {
          warnings.push({
            type: "FACT_WITHOUT_EVIDENCE",
            detail: `Fact ${f.sourceId} has no supporting evidence ref in the context.`,
            sourceId: f.sourceId,
          });
          needsSupport = true;
        }
      }
      if (ctx.facts.length === 0) {
        missing = true;
        warnings.push({
          type: "NO_FACTS_IN_CONTEXT",
          detail:
            "No verified facts available — facts section cannot be drafted from documentary evidence.",
        });
      }
      break;

    case "legal_issues":
      for (const issueId of selectedIssueIds) {
        const issue = ctx.legalIssues.find((l) => l.issueId === issueId);
        if (!issue) continue;
        sourceIds.push(...issue.factSourceIds);
        sourceIds.push(...issue.legislationSourceIds);
        sourceIds.push(...issue.precedentSourceIds);
        if (
          issue.legislationSourceIds.length === 0 &&
          issue.precedentSourceIds.length === 0
        ) {
          warnings.push({
            type: "ISSUE_WITHOUT_AUTHORITY",
            detail: `Legal issue ${issue.issueId} has no governing legislation or precedent — will be flagged [SUPPORT_REQUIRED] in the draft.`,
            sourceId: issue.issueId,
          });
          needsSupport = true;
        }
      }
      if (selectedIssueIds.length === 0) {
        missing = true;
        warnings.push({
          type: "NO_ISSUES_SELECTED",
          detail:
            "No legal issues selected for this draft — legal_issues section will list [MISSING_INFORMATION].",
        });
      }
      break;

    case "applicable_law":
      for (const l of ctx.legislation) sourceIds.push(l.sourceId);
      if (ctx.legislation.length === 0) {
        missing = true;
        warnings.push({
          type: "NO_LEGISLATION_IN_CONTEXT",
          detail:
            "No applicable legislation in the bounded context — applicable_law section will list [SUPPORT_REQUIRED].",
        });
        needsSupport = true;
      }
      break;

    case "precedents":
      for (const c of ctx.cassationCases) sourceIds.push(c.sourceId);
      for (const c of ctx.conCourtCases) sourceIds.push(c.sourceId);
      for (const e of ctx.echrCases) sourceIds.push(e.sourceId);
      if (
        ctx.cassationCases.length === 0 &&
        ctx.conCourtCases.length === 0 &&
        ctx.echrCases.length === 0
      ) {
        missing = true;
        warnings.push({
          type: "NO_PRECEDENTS_IN_CONTEXT",
          detail:
            "No Cassation / ConCourt / ECHR precedents in the bounded context — precedents section will list [SUPPORT_REQUIRED].",
        });
        needsSupport = true;
      }
      // Surface distinguishing factors (§20).
      for (const [sid, factors] of Object.entries(ctx.distinguishing)) {
        if (factors.length > 0) {
          warnings.push({
            type: "DISTINGUISHING_FACTOR",
            detail: `Precedent ${sid} is distinguished by: ${factors.join("; ")}`,
            sourceId: sid,
          });
        }
      }
      break;

    case "arguments": {
      // Arguments use the argument map entries — each entry references
      // supporting / counter authority ids (§8, §20).
      const used = new Set<string>();
      for (const a of ctx.argumentMap) {
        sourceIds.push(a.sourceId);
        for (const s of a.supportingAuthorities) {
          sourceIds.push(s);
          used.add(s);
        }
        for (const c of a.counterAuthorities) {
          sourceIds.push(c);
          used.add(c);
        }
      }
      // Also surface the explicit authority ids we know are relevant
      // (legislation + precedents) so the drafter has them in scope.
      for (const a of authorities) sourceIds.push(a);
      if (ctx.argumentMap.length === 0) {
        warnings.push({
          type: "NO_ARGUMENT_MAP",
          detail:
            "No argument map in the bounded context — drafter will rely on issues + authorities directly.",
        });
      }
      break;
    }

    case "counterarguments": {
      // §20 — surface serious adverse authority.
      const counterIds = ctx.counterAuthorities.slice();
      // Also include any contradicting evidence + contradicted facts.
      for (const f of ctx.facts) {
        if (contradicted.has(f.sourceId)) sourceIds.push(f.sourceId);
      }
      // If there are counter-authority ids in the argument map, surface them.
      for (const a of ctx.argumentMap) {
        for (const c of a.counterAuthorities) sourceIds.push(c);
      }
      sourceIds.push(...counterIds);
      if (counterIds.length === 0 && contradicted.size === 0) {
        warnings.push({
          type: "NO_COUNTERAUTHORITY",
          detail:
            "No counter-authority or contradicted facts in the bounded context — counterarguments section will list [SUPPORT_REQUIRED].",
        });
        needsSupport = true;
      }
      break;
    }

    case "requested_relief":
      // §21 — relief comes from goal + document type + verified procedural
      // context. The planner does not produce text here — it just records
      // that the section is required and references the goal.
      break;
  }

  return {
    sourceIds: Array.from(new Set(sourceIds)),
    missing,
    needsSupport,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// buildDocumentPlan
// ---------------------------------------------------------------------------

export async function buildDocumentPlan(
  draftId: string,
  ctx: DraftingContext,
  docType: DocumentType,
  goal: string,
): Promise<DocumentPlan> {
  const spec = getDocumentTypeSpec(docType);
  const allSections = allSectionsForType(docType);
  const selectedIssueIds = selectIssuesForDraft(ctx, docType, goal);

  // §11 — captured case identity (never invented).
  const parties = ctx.parties;
  const caseNumber = ctx.caseNumber;
  const court = ctx.court;
  const jurisdiction = ctx.jurisdiction;

  // §12 — material contradictions: any fact in DISPUTED/CONTRADICTED status.
  const materialContradictions: SectionWarning[] = [];
  for (const f of ctx.facts) {
    if (f.status === "DISPUTED" || f.status === "CONTRADICTED") {
      materialContradictions.push({
        type: "MATERIALIZED_CONTRADICTION",
        detail: `Fact ${f.sourceId} is in ${f.status} status — draft language must reflect this per §9.`,
        sourceId: f.sourceId,
      });
    }
  }
  // Chronology conflicts.
  for (const e of ctx.chronology) {
    if (e.hasConflict) {
      materialContradictions.push({
        type: "CHRONOLOGY_CONFLICT",
        detail: `Chronology event ${e.sourceId} has a documented conflict: ${e.conflictDetail ?? "(no detail)"}`,
        sourceId: e.sourceId,
      });
    }
  }

  // §12 — missing metadata. Use validateDraftMetadata against the captured
  // identity fields.
  const metadataRecord: Record<string, unknown> = {
    court: court ?? "",
    caseNumber: caseNumber ?? "",
    parties: parties.length > 0 ? parties : "",
    jurisdiction: jurisdiction ?? "",
    proceduralStage: ctx.proceedingType ?? "",
  };
  const metaValidation = validateDraftMetadata(docType, metadataRecord);
  const missingMetadata = metaValidation.missing;

  // §21 — requested relief. Derived from goal + document type + verified
  // procedural context. We DO NOT invent remedies here; we just record the
  // goal + the spec's procedural constraints, and the deterministic
  // request-sections assembler renders relief from them.
  const requestedRelief = goal && goal.length > 0 ? goal : null;

  // ---- Per-section plan entries -----------------------------------------
  const factWithEv = factsWithEvidence(ctx);
  const contradicted = contradictedFacts(ctx);
  const authorities = allAuthoritySourceIds(ctx);

  const sections: DocumentPlanSection[] = allSections.map((sectionType) => {
    const required = spec.requiredSections.includes(sectionType);
    const collected = collectSourceIdsForSection(
      sectionType,
      ctx,
      factWithEv,
      contradicted,
      authorities,
      selectedIssueIds,
    );
    const note = buildSectionNote(sectionType, docType, ctx, collected, goal);
    return {
      sectionType,
      required,
      sourceIds: collected.sourceIds,
      note,
      missing: collected.missing,
      needsSupport: collected.needsSupport,
      warnings: collected.warnings,
    };
  });

  return {
    draftId,
    documentType: docType,
    goal,
    parties,
    caseNumber,
    court,
    jurisdiction,
    sections,
    materialContradictions,
    missingMetadata,
    requestedRelief,
  };
}

// ---------------------------------------------------------------------------
// Section note (deterministic free-text hint for the drafter)
// ---------------------------------------------------------------------------

function buildSectionNote(
  sectionType: SectionType,
  docType: DocumentType,
  ctx: DraftingContext,
  collected: {
    sourceIds: string[];
    missing: boolean;
    needsSupport: boolean;
    warnings: SectionWarning[];
  },
  goal: string,
): string {
  const lines: string[] = [];
  switch (sectionType) {
    case "header":
      lines.push(
        `Mechanical header. Court: ${ctx.court ?? "[MISSING_INFORMATION]"}. Case number: ${ctx.caseNumber ?? "[MISSING_INFORMATION]"}. Parties: ${ctx.parties.length > 0 ? ctx.parties.join(", ") : "[MISSING_INFORMATION]"}.`,
      );
      break;
    case "introduction":
      lines.push(
        `Brief introduction framing the document's purpose: ${goal || "[MISSING_INFORMATION]"}.`,
      );
      break;
    case "procedural_history":
      lines.push(
        `Chronology-driven procedural history. ${ctx.chronology.length} event(s) selected: ${ctx.chronology.map((e) => e.sourceId).join(", ") || "(none)"}.`,
      );
      break;
    case "facts":
      lines.push(
        `Factual narrative reflecting fact status per §9. ${ctx.facts.length} fact(s) selected: ${ctx.facts.map((f) => f.sourceId).join(", ") || "(none)"}.`,
      );
      break;
    case "legal_issues":
      lines.push(
        `Legal issues selected for this draft. Source ids: ${collected.sourceIds.join(", ") || "(none)"}.`,
      );
      break;
    case "applicable_law":
      lines.push(
        `Applicable legislation. ${ctx.legislation.length} article(s): ${ctx.legislation.map((l) => l.sourceId).join(", ") || "(none)"}.`,
      );
      break;
    case "precedents":
      lines.push(
        `Precedents. Cassation: ${ctx.cassationCases.length}; ConCourt: ${ctx.conCourtCases.length}; ECHR: ${ctx.echrCases.length}.`,
      );
      break;
    case "arguments":
      lines.push(
        `Arguments. ${ctx.argumentMap.length} argument-map entries; authorities in scope: ${collected.sourceIds.length}.`,
      );
      break;
    case "counterarguments":
      lines.push(
        `§20 — serious adverse authority / counterarguments. Counter-authorities: ${ctx.counterAuthorities.length}; contradicted facts: ${collected.sourceIds.length}.`,
      );
      break;
    case "requested_relief":
      lines.push(
        `§21 — relief from goal + document type + verified procedural context. Goal: ${goal || "[MISSING_INFORMATION]"}. Type: ${docType}.`,
      );
      break;
    case "attachments":
      lines.push(
        `Mechanical attachment list. ${ctx.evidenceRefs.length} evidence ref(s) available.`,
      );
      break;
    case "missing_information":
      lines.push(
        `Surfaced gaps: ${ctx.missingMaterialFacts.length} material fact(s) missing; ${collected.warnings.filter((w) => w.type.startsWith("MISSING") || w.type.startsWith("NO_")).length} section-level gap(s).`,
      );
      break;
  }
  if (collected.warnings.length > 0) {
    lines.push(
      `Warnings: ${collected.warnings.map((w) => `[${w.type}] ${w.detail}`).join("; ")}`,
    );
  }
  if (collected.missing) {
    lines.push("Section flagged MISSING_INFORMATION — see warnings.");
  }
  if (collected.needsSupport) {
    lines.push("Section needs SUPPORT_REQUIRED — see warnings.");
  }
  return lines.join(" ");
}
