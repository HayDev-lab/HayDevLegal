// src/lib/case-workspace/evidence/evidence-matrix.ts
//
// §11 — Build the evidence matrix for a case. Index all CaseEvidenceLink
// records both directions (evidence → facts and facts → evidence) for fast
// UI navigation.

import { db } from "@/lib/db";
import type {
  CaseEvidenceLinkRecord,
  EvidenceRef,
  EvidenceRelation,
  EvidenceStrength,
} from "../analysis-types";

function evidenceKey(ref: EvidenceRef): string {
  // Composite key so that the same quote across documents isn't conflated.
  return [ref.documentId ?? "?", ref.page ?? "?", ref.section ?? "?", ref.quote ?? ""].join("|");
}

function safeParseRef(raw: string): EvidenceRef {
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null
      ? (obj as EvidenceRef)
      : { quote: raw };
  } catch {
    return { quote: raw };
  }
}

/**
 * §11 — Build the evidence matrix (bidirectional index of evidence links).
 */
export async function buildEvidenceMatrix(caseId: string): Promise<{
  evidenceToFact: Map<string, string[]>;
  factToEvidence: Map<string, string[]>;
  links: CaseEvidenceLinkRecord[];
}> {
  if (!caseId) {
    return {
      evidenceToFact: new Map(),
      factToEvidence: new Map(),
      links: [],
    };
  }

  const rows = await db.caseEvidenceLink.findMany({
    where: { caseId },
  });

  const links: CaseEvidenceLinkRecord[] = rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    factId: r.factId,
    evidenceRef: safeParseRef(r.evidenceRef),
    relation: r.relation as EvidenceRelation,
    strength: r.strength as EvidenceStrength,
  }));

  const evidenceToFact = new Map<string, string[]>();
  const factToEvidence = new Map<string, string[]>();

  for (const l of links) {
    const eKey = evidenceKey(l.evidenceRef);
    const arr = evidenceToFact.get(eKey) ?? [];
    if (l.factId && !arr.includes(l.factId)) arr.push(l.factId);
    evidenceToFact.set(eKey, arr);

    if (l.factId) {
      const fArr = factToEvidence.get(l.factId) ?? [];
      if (!fArr.includes(eKey)) fArr.push(eKey);
      factToEvidence.set(l.factId, fArr);
    }
  }

  return { evidenceToFact, factToEvidence, links };
}

// Re-export for convenience.
export { evidenceKey };
