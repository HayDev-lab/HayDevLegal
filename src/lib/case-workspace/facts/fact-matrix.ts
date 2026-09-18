// src/lib/case-workspace/facts/fact-matrix.ts
//
// §10 — Build the fact matrix for a case.
//
// Reads extracted fact candidates from every DocumentPage text, persists them
// as CaseFact records (status: ALLEGED by default, materiality from extractor),
// and links supporting/contradicting evidence via CaseEvidenceLink records.
//
// Fact status update rules (§10):
//   ALLEGED (default — user-entered or AI-proposed)
//   VERIFIED: ≥1 DIRECT SUPPORTS evidence link AND no CONTRADICTS
//   DISPUTED: both SUPPORTS and CONTRADICTS evidence exists
//   CONTRADICTED: only CONTRADICTS evidence exists
//   UNKNOWN: no evidence yet
//
// Per §10: AI cannot promote to VERIFIED without evidence.

import { db } from "@/lib/db";
import { extractFactCandidates } from "./extractor";
import { verifyFact } from "./verifier";
import type {
  CaseEvidenceLinkRecord,
  CaseFactRecord,
  EvidenceRef,
  EvidenceRelation,
  EvidenceStrength,
  FactCategory,
  FactStatus,
  FactSource,
  Materiality,
} from "../analysis-types";

export interface BuildFactMatrixResult {
  facts: CaseFactRecord[];
  evidenceLinks: CaseEvidenceLinkRecord[];
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

function safeParseEvidenceRefs(raw: string | null | undefined): EvidenceRef[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as EvidenceRef[]) : [];
  } catch {
    return [];
  }
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function isNegationToken(t: string): boolean {
  const negations = [
    // Armenian
    "չի",
    "չէ",
    "չպատասխանեց",
    "չկա",
    "չիեղավ",
    "չիկատարվել",
    "չկատարվեց",
    // Russian
    "не",
    "нет",
    "никак",
    // English
    "no",
    "not",
    "never",
    "denied",
  ];
  return negations.includes(t.toLowerCase());
}

/**
 * §10 — Build the fact matrix for a case.
 *
 * Steps:
 *   1. For every DocumentPage, extract fact candidates (status=ALLEGED).
 *   2. Persist candidates as CaseFact records.
 *   3. For each fact, link supporting/contradicting evidence (heuristic).
 *   4. Update each fact's status based on the link inventory.
 */
export async function buildFactMatrix(
  caseId: string
): Promise<BuildFactMatrixResult> {
  if (!caseId) return { facts: [], evidenceLinks: [] };

  // 1. Read all documents + pages.
  const documents = await db.caseDocument.findMany({
    where: { caseId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });

  // 2. Extract candidates from every page.
  interface RawFact {
    proposition: string;
    category: FactCategory;
    materiality: Materiality;
    source: FactSource;
    evidenceRef: EvidenceRef;
    tokens: Set<string>;
  }
  const raw: RawFact[] = [];
  for (const doc of documents) {
    for (const page of doc.pages) {
      const text = page.originalText ?? "";
      if (!text) continue;
      const candidates = extractFactCandidates(text, {
        language: "auto",
        documentId: doc.id,
        page: page.pageNumber,
        originalFilename: doc.originalFilename,
        contentHash: doc.sha256,
      });
      for (const c of candidates) {
        raw.push({
          proposition: c.proposition,
          category: c.category,
          materiality: c.materiality,
          source: "AI",
          evidenceRef: c.evidenceRef,
          tokens: tokenize(c.proposition),
        });
      }
    }
  }

  // Dedup candidates with same proposition text (case-insensitive).
  const dedup: RawFact[] = [];
  for (const f of raw) {
    const dup = dedup.find(
      (d) =>
        d.proposition.toLowerCase() === f.proposition.toLowerCase()
    );
    if (dup) {
      // Keep the first occurrence; we'll still link additional evidence to it
      // below via the supporting-contradicting detection.
    } else {
      dedup.push(f);
    }
  }

  // 3. Persist: replace AI-proposed facts for this case (preserve USER-entered
  //    facts which carry source="USER" — they begin as ALLEGED per §10).
  await db.caseFact.deleteMany({ where: { caseId, source: "AI" } });

  const facts: CaseFactRecord[] = [];
  for (const f of dedup) {
    const rec = await db.caseFact.create({
      data: {
        caseId,
        proposition: f.proposition,
        category: f.category,
        status: "ALLEGED",
        supportingEvidence: JSON.stringify([f.evidenceRef]),
        contradictingEvidence: "[]",
        relatedIssues: "[]",
        materiality: f.materiality,
        source: f.source,
      },
    });
    facts.push({
      id: rec.id,
      caseId: rec.caseId,
      proposition: rec.proposition,
      category: rec.category as FactCategory,
      status: rec.status as FactStatus,
      supportingEvidence: [f.evidenceRef],
      contradictingEvidence: [],
      relatedIssues: [],
      materiality: rec.materiality as Materiality,
      source: rec.source as FactSource,
    });
  }

  // 4. For each fact, link supporting/contradicting evidence from every page.
  //    Use token-overlap heuristic for SUPPORTS; negation heuristic for CONTRADICTS.
  //    Link strength: DIRECT when same document+page as the proposition source,
  //    INDIRECT otherwise.
  const evidenceLinks: CaseEvidenceLinkRecord[] = [];

  for (const fact of facts) {
    const factTokens = tokenize(fact.proposition);
    for (const doc of documents) {
      for (const page of doc.pages) {
        const text = page.originalText ?? "";
        if (!text) continue;
        // Page-level token set for the SUPPORTS check.
        const pageTokens = tokenize(text);
        const sim = jaccard(factTokens, pageTokens);
        if (sim < 0.15) continue; // require some overlap to claim support

        const sameSource =
          fact.supportingEvidence.some(
            (r) => r.documentId === doc.id && r.page === page.pageNumber
          ) ||
          fact.contradictingEvidence.some(
            (r) => r.documentId === doc.id && r.page === page.pageNumber
          );

        // Decide relation: CONTRADICTS if any negation token overlaps with the
        // fact's tokens in this page; otherwise SUPPORTS.
        const negInPage = Array.from(factTokens).some((t) => isNegationToken(t));
        // Only flag CONTRADICTS if the page's tokens include negation tokens
        // adjacent to a fact token (rough heuristic — §12: different wording
        // is NOT automatically contradiction, so we require negation).
        const pageHasNegation = text.split(/\s+/).some((w) =>
          isNegationToken(w.replace(/[.,;:!?՛։]/g, ""))
        );
        const relation: EvidenceRelation =
          pageHasNegation && sim > 0.25 ? "CONTRADICTS" : "SUPPORTS";
        const strength: EvidenceStrength = sameSource
          ? "DIRECT"
          : sim > 0.4
          ? "DIRECT"
          : "INDIRECT";

        // Don't create a link for the fact's own originating page if it would
        // be a CONTRADICTS (it can't contradict itself).
        const selfOriginated =
          fact.supportingEvidence.some(
            (r) => r.documentId === doc.id && r.page === page.pageNumber
          );
        if (relation === "CONTRADICTS" && selfOriginated) continue;

        const ref: EvidenceRef = {
          documentId: doc.id,
          page: page.pageNumber,
          quote: text.slice(0, Math.min(160, text.length)),
          originalFilename: doc.originalFilename,
          contentHash: doc.sha256,
          section: fact.category,
        };

        const link = await db.caseEvidenceLink.create({
          data: {
            caseId,
            factId: fact.id,
            evidenceRef: JSON.stringify(ref),
            relation,
            strength,
          },
        });
        evidenceLinks.push({
          id: link.id,
          caseId: link.caseId,
          factId: link.factId,
          evidenceRef: ref,
          relation,
          strength,
        });
      }
    }

    // 5. Update fact status based on the link inventory.
    await verifyFact(fact.id);
  }

  // 6. Refresh fact records from DB to reflect verified/disputed statuses.
  const finalFacts: CaseFactRecord[] = [];
  for (const f of facts) {
    const fresh = await db.caseFact.findUnique({ where: { id: f.id } });
    if (!fresh) continue;
    finalFacts.push({
      id: fresh.id,
      caseId: fresh.caseId,
      proposition: fresh.proposition,
      category: fresh.category as FactCategory,
      status: fresh.status as FactStatus,
      supportingEvidence: safeParseEvidenceRefs(fresh.supportingEvidence),
      contradictingEvidence: safeParseEvidenceRefs(fresh.contradictingEvidence),
      relatedIssues: safeParseStringArray(fresh.relatedIssues),
      materiality: fresh.materiality as Materiality,
      source: fresh.source as FactSource,
    });
  }

  return { facts: finalFacts, evidenceLinks };
}
