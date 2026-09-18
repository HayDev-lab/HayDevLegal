// src/lib/case-workspace/legal-issues/linker.ts
//
// §13 — Link a legal issue to its case + facts + evidence.
//
// Linking heuristics:
//   - Issue ↔ facts: token-overlap (Jaccard > 0.15) between the issue's
//     statement and a fact's proposition. Conservative — different wording
//     alone does NOT auto-link; the overlap threshold filters out noise.
//   - Issue ↔ evidence: shared documentId/page with the issue's evidenceRef
//     or with any fact linked to the issue.
//
// Persists a LegalIssueLink record (issueId is a generated stable id; the
// Phase 4 LegalIssue is not Prisma-persisted, so we store issueStatement
// and a hash-based issueId).

import { db } from "@/lib/db";
import type {
  EvidenceRef,
  LegalIssueCategory,
  LegalIssueLinkRecord,
  RelatedLaw,
  RelatedPrecedent,
} from "../analysis-types";

export interface LinkIssueInput {
  caseId: string;
  statement: string;
  category: LegalIssueCategory;
  evidenceRef: EvidenceRef;
}

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
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function stableId(input: string): string {
  // Simple non-cryptographic hash → safe to use as a Prisma issueId.
  // FNV-1a-ish.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `issue-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * §13 — Link a legal issue to its case + facts (token-overlap) + evidence
 * (shared documentId/page).
 *
 * Returns the persisted LegalIssueLink record.
 */
export async function linkIssueToCase(
  caseId: string,
  issue: {
    statement: string;
    category: LegalIssueCategory;
    evidenceRef: EvidenceRef;
  }
): Promise<LegalIssueLinkRecord> {
  if (!caseId) throw new Error("caseId required");
  if (!issue?.statement) throw new Error("issue.statement required");

  const issueId = stableId(`${caseId}|${issue.statement}`);
  const issueTokens = tokenize(issue.statement);

  // Find facts in this case whose proposition overlaps the issue statement.
  const facts = await db.caseFact.findMany({ where: { caseId } });
  const factIds: string[] = [];
  const evidenceRefs: EvidenceRef[] = [issue.evidenceRef];
  for (const f of facts) {
    const ft = tokenize(f.proposition);
    const sim = jaccard(issueTokens, ft);
    if (sim >= 0.15) {
      factIds.push(f.id);
      // Pull fact's evidence refs into the issue's evidence set.
      try {
        const refs = JSON.parse(f.supportingEvidence || "[]") as EvidenceRef[];
        if (Array.isArray(refs)) {
          for (const r of refs) evidenceRefs.push(r);
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Deduplicate evidence refs by (documentId, page, quote).
  const dedupRefs: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const r of evidenceRefs) {
    const key = `${r.documentId ?? "?"}|${r.page ?? "?"}|${r.quote ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupRefs.push(r);
  }

  const row = await db.legalIssueLink.create({
    data: {
      caseId,
      issueId,
      issueStatement: issue.statement,
      factIds: JSON.stringify(factIds),
      evidenceRefs: JSON.stringify(dedupRefs),
      relatedLaw: "[]",
      relatedPrecedents: "[]",
    },
  });

  return {
    id: row.id,
    caseId: row.caseId,
    issueId: row.issueId,
    issueStatement: row.issueStatement,
    factIds,
    evidenceRefs: dedupRefs,
    relatedLaw: [],
    relatedPrecedents: [],
  };
}

/**
 * Convenience: attach a RelatedLaw entry (from HayDevLegal federated search)
 * to an existing LegalIssueLink.
 */
export async function attachRelatedLaw(
  linkId: string,
  law: RelatedLaw
): Promise<void> {
  if (!linkId) return;
  const row = await db.legalIssueLink.findUnique({ where: { id: linkId } });
  if (!row) return;
  const arr: RelatedLaw[] = (() => {
    try {
      const parsed = JSON.parse(row.relatedLaw || "[]");
      return Array.isArray(parsed) ? (parsed as RelatedLaw[]) : [];
    } catch {
      return [];
    }
  })();
  arr.push(law);
  await db.legalIssueLink.update({
    where: { id: linkId },
    data: { relatedLaw: JSON.stringify(arr) },
  });
}

/**
 * Convenience: attach a RelatedPrecedent entry (from Cassation/ConCourt/HUDOC)
 * to an existing LegalIssueLink.
 */
export async function attachRelatedPrecedent(
  linkId: string,
  precedent: RelatedPrecedent
): Promise<void> {
  if (!linkId) return;
  const row = await db.legalIssueLink.findUnique({ where: { id: linkId } });
  if (!row) return;
  const arr: RelatedPrecedent[] = (() => {
    try {
      const parsed = JSON.parse(row.relatedPrecedents || "[]");
      return Array.isArray(parsed) ? (parsed as RelatedPrecedent[]) : [];
    } catch {
      return [];
    }
  })();
  arr.push(precedent);
  await db.legalIssueLink.update({
    where: { id: linkId },
    data: { relatedPrecedents: JSON.stringify(arr) },
  });
}
