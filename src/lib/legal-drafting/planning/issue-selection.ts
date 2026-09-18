// src/lib/legal-drafting/planning/issue-selection.ts
// Phase 6 §12 — Select LegalIssueLink ids relevant to a draft goal.
//
// The selection is DETERMINISTIC (no AI call). It scores each LegalIssueLink
// by token overlap with the goal + the document type's typical issue
// categories, returning the top-N (default = number of required arguments
// sections in the document type, capped at 12).
//
// Per §12: "verify plan — factual sections have evidence; legal issues have
// authority or unresolved flag". This module's output feeds the planner's
// legal_issues section. If no issue is selected, the planner surfaces a
// MISSING_INFORMATION flag (never invents).

import { getDocumentTypeSpec } from "../registry/document-types";
import type { DocumentType, DraftingContext } from "../types";

const MAX_SELECTED_ISSUES = 12;

// ---------------------------------------------------------------------------
// Tokenize — works for Armenian / Cyrillic / Latin (matches the case-
// workspace chronology builder tokenizer).
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    if (t.length > 2) tokens.add(t);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Document-type default issue-category hints.
// ---------------------------------------------------------------------------
// These are NOT categories invented by the AI — they are deterministic
// keyword hints used to bias the issue-selection scoring.

const DOC_TYPE_HINTS: Record<DocumentType, string[]> = {
  MOTION: ["procedural", "evidence", "exclusion", "release", "deadline"],
  OBJECTION: ["procedural", "evidence", "admissibility", "exclusion"],
  CLAIM: ["substantive", "damages", "liability", "contract", "tort"],
  RESPONSE: ["defense", "counterclaim", "procedural", "evidence"],
  APPEAL: ["procedural", "substantive", "error", "lower court", "ground"],
  CASSATION_APPEAL: [
    "substantive",
    "procedural",
    "violation",
    "cassation",
    "ground",
  ],
  CONSTITUTIONAL_COMPLAINT: [
    "constitutional",
    "right",
    "violation",
    "fundamental",
  ],
  ECHR_APPLICATION_SUPPORT: [
    "convention",
    "echr",
    "article",
    "remedy",
    "exhaustion",
  ],
  LEGAL_MEMORANDUM: [
    "substantive",
    "procedural",
    "evidentiary",
    "jurisdictional",
  ],
  FACTUAL_STATEMENT: ["substantive", "temporal", "spatial", "identity"],
  REQUEST_TO_AUTHORITY: ["administrative", "right", "remedy", "obligation"],
  OTHER: [],
};

// ---------------------------------------------------------------------------
// selectIssuesForDraft
// ---------------------------------------------------------------------------

/**
 * Select LegalIssueLink ids relevant to the document goal. Pure string-token
 * Jaccard similarity + a small bias for the document type's issue-category
 * hints. Returns at most MAX_SELECTED_ISSUES (or the document type's
 * required-arguments count if larger).
 *
 * When `ctx.legalIssues` is empty, returns [] (the planner surfaces
 * MISSING_INFORMATION — never invented).
 */
export function selectIssuesForDraft(
  ctx: DraftingContext,
  docType: DocumentType,
  goal: string,
): string[] {
  const spec = getDocumentTypeSpec(docType);
  const requiredArgsCount = spec.requiredSections.filter(
    (s) => s === "arguments" || s === "counterarguments",
  ).length;
  const cap = Math.max(MAX_SELECTED_ISSUES, requiredArgsCount);

  if (ctx.legalIssues.length === 0) return [];

  const goalTokens = tokenize(goal);
  const hintTokens = new Set(
    DOC_TYPE_HINTS[docType].flatMap((h) => [...tokenize(h)]),
  );

  const scored = ctx.legalIssues.map((issue) => {
    const issueTokens = tokenize(issue.issueStatement);
    const goalScore = jaccard(goalTokens, issueTokens);
    const hintScore = jaccard(hintTokens, issueTokens);
    // Weight goal-issues higher than hint-issues (the goal is the user's
    // primary intent; hints break ties).
    const score = goalScore * 2 + hintScore;
    return { issueId: issue.issueId, score };
  });

  // Stable sort: high score first, ties broken by issueId for determinism.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.issueId.localeCompare(b.issueId);
  });

  return scored.slice(0, cap).map((s) => s.issueId);
}
