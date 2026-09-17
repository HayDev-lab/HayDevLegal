// src/lib/legal-search/engine/reference-extractor.ts
// Cross-source legal reference extraction (Phase 3 §37-§39).
//
// For every resolved decision we detect the exact legal references it
// contains: Armenian case numbers, ՍԴՈ numbers, ECHR application numbers,
// ECLI codes, article references, act numbers. Deep mode uses these for the
// SECOND RESEARCH PASS (follow the important references) and the temporary
// per-request citation graph (§39) — never a persistent graph database.

import type { LegalSearchResult } from "../types";

export type LegalReferenceKind =
  | "armenian_case_number"
  | "concourt_decision"
  | "echr_application"
  | "ecli"
  | "article"
  | "act_number";

export interface LegalReference {
  kind: LegalReferenceKind;
  /** Normalized identifier, e.g. "ԵԴ/1234/02/21", "ՍԴՈ-1842", "11275/07". */
  value: string;
  /** Raw matched text. */
  raw: string;
}

/** Armenian court prefixes seen in case numbers (§29). */
const ARMENIAN_CASE_RE =
  /(?<![Ա-Ֆ])[Ա-Ֆ]{1,6}(?:ՔՐԴ|ՔԴ|Դ)\/\d{2,5}\/\d{2,4}(?:\/\d{2,4})?(?:\.\d{1,2})?/g;

const CONCOURT_RE = /(?<![Ա-ՖA-Za-z])(ՍԴՈ|ՍԴՎ|SDV)\s*[-–—]?\s*(\d{2,5})(?!\d)/g;
const ECHR_APP_RE = /\b(\d{4,5}\/\d{2})\b/g;
const ECLI_RE = /\b(ECLI:\s*[A-Z]{2}:\s*[A-Z]+:\s*[\d]{4}:\s*[\w.]+)\b/gi;
const ARTICLE_RE = /\b(?:Հոդված|հոդված)\s*(\d{1,4})/gu;
const ARTICLE_EN_RE = /\bArticle\s+(\d{1,2})\s*(?:§|para?\s*)?(\d{1,2})?/gi;
const ACT_NUMBER_RE = /\b(?:ՀՕ-\d+|ՆՀ-\d+|ՆՀԿ-\d+|Փ-?\d+)\b/g;

/** Extract all legal references from a document text (§37). */
export function extractLegalReferences(text: string): LegalReference[] {
  if (!text) return [];
  const out: LegalReference[] = [];
  const seen = new Set<string>();
  const push = (kind: LegalReferenceKind, value: string, raw: string) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value, raw });
  };

  let m: RegExpExecArray | null;

  // Armenian case numbers — the primary identifier (§29).
  ARMENIAN_CASE_RE.lastIndex = 0;
  while ((m = ARMENIAN_CASE_RE.exec(text)) !== null) {
    push("armenian_case_number", m[0].replace(/\s+/g, ""), m[0]);
  }

  // Constitutional Court decision numbers.
  CONCOURT_RE.lastIndex = 0;
  while ((m = CONCOURT_RE.exec(text)) !== null) {
    push("concourt_decision", `${m[1]}-${m[2]}`, m[0]);
  }

  // ECHR application numbers — but do not confuse with Armenian case
  // numbers (those have a letter prefix and two slash groups).
  ECHR_APP_RE.lastIndex = 0;
  while ((m = ECHR_APP_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (/[Ա-ՖA-Za-z]\//.test(before.trim().slice(-2))) continue; // part of a longer id
    push("echr_application", m[1], m[0]);
  }

  // ECLI codes.
  ECLI_RE.lastIndex = 0;
  while ((m = ECLI_RE.exec(text)) !== null) {
    push("ecli", m[1].replace(/\s+/g, "").toUpperCase(), m[0]);
  }

  // Article references (Armenian + English).
  ARTICLE_RE.lastIndex = 0;
  while ((m = ARTICLE_RE.exec(text)) !== null) {
    push("article", m[1], m[0]);
  }
  ARTICLE_EN_RE.lastIndex = 0;
  while ((m = ARTICLE_EN_RE.exec(text)) !== null) {
    push("article", m[2] ? `${m[1]}§${m[2]}` : m[1], m[0]);
  }

  // Act numbers.
  ACT_NUMBER_RE.lastIndex = 0;
  while ((m = ACT_NUMBER_RE.exec(text)) !== null) {
    push("act_number", m[0], m[0]);
  }

  return out;
}

/** Rank references by research value for PASS 2 (§38). */
export function rankReferences(refs: LegalReference[]): LegalReference[] {
  const weight: Record<LegalReferenceKind, number> = {
    echr_application: 3, // Armenian court citing ECHR -> cross-source gold
    concourt_decision: 3,
    armenian_case_number: 2,
    ecli: 2,
    act_number: 1,
    article: 0, // too common to follow blindly
  };
  return [...refs].sort((a, b) => weight[b.kind] - weight[a.kind]);
}

export type CitationEdge = {
  fromCaseNumber?: string;
  fromTitle: string;
  ref: LegalReference;
};

/**
 * Temporary per-request citation graph (§39). Case A cites Case B, Case A
 * references ՍԴՈ-X, Case A references ECHR application Y.
 * NEVER persisted — built for the current request only.
 */
export function buildCitationGraph(results: LegalSearchResult[]): CitationEdge[] {
  const edges: CitationEdge[] = [];
  for (const r of results) {
    const text = r.fullText ?? r.passages?.join("\n") ?? "";
    if (!text) continue;
    const refs = extractLegalReferences(text);
    for (const ref of refs) {
      // Skip self-references.
      if (r.caseNumber && ref.value === r.caseNumber) continue;
      edges.push({ fromCaseNumber: r.caseNumber, fromTitle: r.title, ref });
    }
  }
  return edges;
}

/**
 * Select the references worth following in research PASS 2: identifiers that
 * are NOT already present in the evidence (no re-fetching what we have).
 */
export function selectFollowableReferences(
  results: LegalSearchResult[],
  existing: LegalSearchResult[],
  limit: number,
): LegalReference[] {
  // "Already present" = documents we HOLD as evidence (their own identifiers).
  // References merely CITED inside their texts are exactly what we want to
  // follow — they must NOT be filtered out.
  const existingIds = new Set<string>();
  for (const r of existing) {
    if (r.caseNumber) existingIds.add(r.caseNumber.replace(/\s+/g, ""));
    if (r.externalId) existingIds.add(r.externalId);
  }

  const graph = buildCitationGraph(results);
  const ranked = rankReferences(graph.map((e) => e.ref)).filter(
    (ref) =>
      (ref.kind === "echr_application" ||
        ref.kind === "armenian_case_number" ||
        ref.kind === "concourt_decision" ||
        ref.kind === "ecli") &&
      !existingIds.has(ref.value),
  );

  // Dedup again after filtering.
  const seen = new Set<string>();
  const out: LegalReference[] = [];
  for (const ref of ranked) {
    if (seen.has(ref.value)) continue;
    seen.add(ref.value);
    out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}
