// src/lib/case-workspace/evidence/linker.ts
//
// §11 — Evidence linker. Create / delete CaseEvidenceLink records between
// a fact and an evidence item (with relation SUPPORTS | CONTRADICTS |
// CONTEXT | AUTHENTICATES and strength DIRECT | INDIRECT | CONTEXTUAL).

import { db } from "@/lib/db";
import type {
  CaseEvidenceLinkRecord,
  EvidenceRef,
  EvidenceRelation,
  EvidenceStrength,
} from "../analysis-types";

export interface LinkEvidenceInput {
  caseId: string;
  factId: string | null;
  evidenceRef: EvidenceRef;
  relation: EvidenceRelation;
  strength: EvidenceStrength;
}

/**
 * §11 — Create an evidence link.
 */
export async function linkEvidence(
  factId: string,
  evidenceRef: EvidenceRef,
  relation: EvidenceRelation,
  strength: EvidenceStrength
): Promise<CaseEvidenceLinkRecord> {
  if (!factId) throw new Error("factId required (use null when linking case-level evidence only)");
  // Look up the caseId from the fact (we accept factId+caseId semantics here;
  // the caller may pass caseId inside evidenceRef but Prisma requires a real
  // caseId on the link row).
  const fact = await db.caseFact.findUnique({
    where: { id: factId },
    select: { caseId: true },
  });
  if (!fact) throw new Error(`Fact not found: ${factId}`);

  const row = await db.caseEvidenceLink.create({
    data: {
      caseId: fact.caseId,
      factId,
      evidenceRef: JSON.stringify(evidenceRef),
      relation,
      strength,
    },
  });

  return {
    id: row.id,
    caseId: row.caseId,
    factId: row.factId,
    evidenceRef,
    relation: row.relation as EvidenceRelation,
    strength: row.strength as EvidenceStrength,
  };
}

/**
 * §11 — Delete an evidence link by id.
 */
export async function unlinkEvidence(linkId: string): Promise<void> {
  if (!linkId) return;
  await db.caseEvidenceLink.delete({ where: { id: linkId } });
}

/**
 * Convenience: create a link using an explicit caseId (used by UI when
 * attaching evidence to a fact that may not yet exist).
 */
export async function linkEvidenceForCase(
  input: LinkEvidenceInput
): Promise<CaseEvidenceLinkRecord> {
  const row = await db.caseEvidenceLink.create({
    data: {
      caseId: input.caseId,
      factId: input.factId,
      evidenceRef: JSON.stringify(input.evidenceRef),
      relation: input.relation,
      strength: input.strength,
    },
  });
  return {
    id: row.id,
    caseId: row.caseId,
    factId: row.factId,
    evidenceRef: input.evidenceRef,
    relation: row.relation as EvidenceRelation,
    strength: row.strength as EvidenceStrength,
  };
}
