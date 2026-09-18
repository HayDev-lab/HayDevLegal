// src/lib/case-workspace/entities/resolver.ts
//
// §9 — Entity resolver. Given a candidate entity (surface + type + evidenceRef),
// look up existing CaseEntity by exact canonicalName OR alias match.
// If found: append evidenceRef + alias (if surface not already in aliases).
// If not found: create new CaseEntity.
//
// CRITICAL (§9): Do NOT merge by fuzzy name. Use exact alias/canonical match
// only — uncertain name matches stay separate entities. The user may merge
// them later via UI.

import { db } from "@/lib/db";
import type { EntityType, EvidenceRef } from "../analysis-types";

export interface EntityCandidateInput {
  surface: string;
  type: EntityType;
  evidenceRef: EvidenceRef;
}

export interface ResolveEntityResult {
  canonical: {
    id: string;
    caseId: string;
    canonicalName: string;
    aliases: string[];
    type: EntityType;
    roles: string[];
    evidenceRefs: EvidenceRef[];
  };
  isNew: boolean;
}

function safeParseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
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

function safeParseRoles(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/**
 * §9 — Resolve a candidate entity against existing CaseEntity records for
 * the case. Exact-match by canonicalName OR alias only (NO fuzzy match).
 */
export async function resolveEntity(
  caseId: string,
  candidate: EntityCandidateInput
): Promise<ResolveEntityResult> {
  if (!caseId) throw new Error("caseId required");
  if (!candidate?.surface) throw new Error("candidate.surface required");

  const surface = candidate.surface.trim();
  const surfaceLower = surface.toLowerCase();

  // Look up ALL existing CaseEntity records of the same type for this case.
  // SQLite can't query JSON array contents natively, so we fetch + filter in
  // memory. Case entity counts per case are bounded (hundreds at most), so
  // this is fine.
  const existing = await db.caseEntity.findMany({
    where: { caseId, type: candidate.type },
  });

  let matched: (typeof existing)[number] | null = null;
  for (const e of existing) {
    if (e.canonicalName.toLowerCase() === surfaceLower) {
      matched = e;
      break;
    }
    const aliases = safeParseAliases(e.aliases);
    if (aliases.some((a) => a.toLowerCase() === surfaceLower)) {
      matched = e;
      break;
    }
  }

  if (matched) {
    // Append the new evidenceRef + alias (if not already present).
    const existingAliases = safeParseAliases(matched.aliases);
    const existingRefs = safeParseEvidenceRefs(matched.evidenceRefs);
    const hasAlias = existingAliases.some(
      (a) => a.toLowerCase() === surfaceLower
    );
    const hasRef = existingRefs.some(
      (r) =>
        r.documentId === candidate.evidenceRef.documentId &&
        r.page === candidate.evidenceRef.page &&
        r.quote === candidate.evidenceRef.quote
    );

    const newAliases = hasAlias
      ? existingAliases
      : [...existingAliases, surface];
    const newRefs = hasRef ? existingRefs : [...existingRefs, candidate.evidenceRef];

    // Only update if anything actually changed.
    if (!hasAlias || !hasRef) {
      await db.caseEntity.update({
        where: { id: matched.id },
        data: {
          aliases: JSON.stringify(newAliases),
          evidenceRefs: JSON.stringify(newRefs),
        },
      });
    }

    return {
      canonical: {
        id: matched.id,
        caseId: matched.caseId,
        canonicalName: matched.canonicalName,
        aliases: newAliases,
        type: matched.type as EntityType,
        roles: safeParseRoles(matched.roles),
        evidenceRefs: newRefs,
      },
      isNew: false,
    };
  }

  // Create a new CaseEntity. canonicalName = surface, aliases = [].
  const created = await db.caseEntity.create({
    data: {
      caseId,
      canonicalName: surface,
      aliases: "[]",
      type: candidate.type,
      roles: "[]",
      evidenceRefs: JSON.stringify([candidate.evidenceRef]),
    },
  });

  return {
    canonical: {
      id: created.id,
      caseId: created.caseId,
      canonicalName: created.canonicalName,
      aliases: [],
      type: created.type as EntityType,
      roles: [],
      evidenceRefs: [candidate.evidenceRef],
    },
    isNew: true,
  };
}
