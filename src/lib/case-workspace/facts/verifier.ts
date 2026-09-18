// src/lib/case-workspace/facts/verifier.ts
//
// §10 — Fact verifier + promoter.
//
// verifyFact(factId): re-evaluate a fact's status based on its CaseEvidenceLink
// inventory:
//   VERIFIED: ≥1 DIRECT SUPPORTS link AND no CONTRADICTS link
//   DISPUTED: both SUPPORTS and CONTRADICTS links exist
//   CONTRADICTED: only CONTRADICTS links exist (no SUPPORTS)
//   UNKNOWN: no links at all
//   ALLEGED: user-entered / AI-proposed but no DIRECT SUPPORTS yet (default)
//
// promoteFact(factId, status): only allowed when evidence supports the new
// status. Per §10: AI CANNOT promote to VERIFIED without evidence (≥1 DIRECT
// SUPPORTS link required).

import { db } from "@/lib/db";
import type { CaseFactRecord, FactStatus } from "../analysis-types";

export interface VerifyResult {
  status: FactStatus;
  supportingCount: number;
  contradictingCount: number;
}

function safeParseRef(raw: string): EvidenceRefShape | null {
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null ? (obj as EvidenceRefShape) : null;
  } catch {
    return null;
  }
}

interface EvidenceRefShape {
  documentId?: string;
  page?: number;
  quote?: string;
  section?: string;
}

function computeStatus(
  links: Array<{ relation: string; strength: string }>
): {
  status: FactStatus;
  supportingCount: number;
  contradictingCount: number;
} {
  let directSupports = 0;
  let indirectSupports = 0;
  let directContradicts = 0;
  let indirectContradicts = 0;
  for (const l of links) {
    if (l.relation === "SUPPORTS") {
      if (l.strength === "DIRECT") directSupports++;
      else indirectSupports++;
    } else if (l.relation === "CONTRADICTS") {
      if (l.strength === "DIRECT") directContradicts++;
      else indirectContradicts++;
    }
  }
  const supports = directSupports + indirectSupports;
  const contradicts = directContradicts + indirectContradicts;

  let status: FactStatus;
  if (supports === 0 && contradicts === 0) {
    status = "UNKNOWN";
  } else if (supports > 0 && contradicts > 0) {
    status = "DISPUTED";
  } else if (contradicts > 0) {
    status = "CONTRADICTED";
  } else if (directSupports >= 1) {
    status = "VERIFIED"; // §10 — requires ≥1 DIRECT SUPPORTS AND no CONTRADICTS
  } else {
    // only indirect SUPPORTS — still ALLEGED (no direct evidence)
    status = "ALLEGED";
  }
  return { status, supportingCount: supports, contradictingCount: contradicts };
}

export async function verifyFact(factId: string): Promise<VerifyResult> {
  if (!factId) return { status: "UNKNOWN", supportingCount: 0, contradictingCount: 0 };
  const fact = await db.caseFact.findUnique({
    where: { id: factId },
    include: { evidenceLinks: true },
  });
  if (!fact) return { status: "UNKNOWN", supportingCount: 0, contradictingCount: 0 };

  const { status, supportingCount, contradictingCount } = computeStatus(
    fact.evidenceLinks.map((l) => ({ relation: l.relation, strength: l.strength }))
  );

  if (fact.status !== status) {
    await db.caseFact.update({
      where: { id: factId },
      data: { status },
    });
  }

  return { status, supportingCount, contradictingCount };
}

/**
 * §10 — Promote a fact to a new status. ONLY allowed when the current
 * evidence supports the new status.
 *
 * Rules:
 *   - promoteFact(factId, "VERIFIED") requires ≥1 DIRECT SUPPORTS link and
 *     zero CONTRADICTS links (§10 — AI cannot promote to VERIFIED without
 *     evidence).
 *   - promoteFact(factId, "DISPUTED") requires both SUPPORTS and CONTRADICTS.
 *   - promoteFact(factId, "CONTRADICTED") requires ≥1 CONTRADICTS link.
 *   - promoteFact(factId, "ALLEGED") is always allowed (user may downgrade).
 *   - promoteFact(factId, "UNKNOWN") is always allowed.
 *
 * Throws Error if the promotion is not justified by the evidence inventory.
 */
export async function promoteFact(
  factId: string,
  status: FactStatus
): Promise<CaseFactRecord> {
  if (!factId) throw new Error("factId required");
  const fact = await db.caseFact.findUnique({
    where: { id: factId },
    include: { evidenceLinks: true },
  });
  if (!fact) throw new Error(`Fact not found: ${factId}`);

  const inv = computeStatus(
    fact.evidenceLinks.map((l) => ({ relation: l.relation, strength: l.strength }))
  );

  const allow =
    status === "ALLEGED" ||
    status === "UNKNOWN" ||
    (status === "VERIFIED" &&
      inv.supportingCount >= 1 &&
      // Need ≥1 DIRECT SUPPORTS — recompute directSupports.
      fact.evidenceLinks.some(
        (l) => l.relation === "SUPPORTS" && l.strength === "DIRECT"
      ) &&
      inv.contradictingCount === 0) ||
    (status === "DISPUTED" &&
      inv.supportingCount >= 1 &&
      inv.contradictingCount >= 1) ||
    (status === "CONTRADICTED" &&
      inv.contradictingCount >= 1);

  if (!allow) {
    throw new Error(
      `§10 — Cannot promote fact ${factId} to ${status} without supporting evidence (supports=${inv.supportingCount}, contradicts=${inv.contradictingCount}).`
    );
  }

  const updated = await db.caseFact.update({
    where: { id: factId },
    data: { status },
  });

  const evidenceRefs: EvidenceRefShape[] = [];
  const rawSupp = (() => {
    try {
      const parsed = JSON.parse(fact.supportingEvidence || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  for (const r of rawSupp as EvidenceRefShape[]) {
    if (r && typeof r === "object") evidenceRefs.push(r);
  }

  const rawContra = (() => {
    try {
      const parsed = JSON.parse(fact.contradictingEvidence || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const contraRefs: EvidenceRefShape[] = [];
  for (const r of rawContra as EvidenceRefShape[]) {
    if (r && typeof r === "object") contraRefs.push(r);
  }

  const rawRelated = (() => {
    try {
      const parsed = JSON.parse(updated.relatedIssues || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  return {
    id: updated.id,
    caseId: updated.caseId,
    proposition: updated.proposition,
    category: updated.category as CaseFactRecord["category"],
    status: updated.status as FactStatus,
    supportingEvidence: evidenceRefs,
    contradictingEvidence: contraRefs,
    relatedIssues: rawRelated as string[],
    materiality: updated.materiality as CaseFactRecord["materiality"],
    source: updated.source as CaseFactRecord["source"],
  };
}

// `safeParseRef` is exported for testing — used by the verification path to
// inspect an EvidenceRef string. Kept here to avoid a circular import with
// the linker module.
export { safeParseRef };
