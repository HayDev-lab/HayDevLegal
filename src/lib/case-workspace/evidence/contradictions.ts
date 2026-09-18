// src/lib/case-workspace/evidence/contradictions.ts
//
// §12 — Detect contradictions between claims/facts.
//
// Heuristics:
//   - Same event / different date → TEMPORAL contradiction
//   - Same object / different description → IDENTITY
//   - Incompatible location → IDENTITY
//   - Claim vs official record → DIRECT
//   - Expert vs expert → DIRECT
//   - Court statement vs underlying record → PROCEDURAL
//   - Procedural inconsistencies → PROCEDURAL
//
// CRITICAL (§12): different wording is NOT automatically contradiction.
// We require either:
//   (a) temporal disagreement (different dates for the same event), OR
//   (b) negation in one side but not the other for the same proposition
//       (e.g. defendant claims X, official record says NOT X), OR
//   (c) same object/role referenced but with mutually exclusive descriptions.
//
// Significance:
//   HIGH for DIRECT / TEMPORAL on material facts (HIGH materiality).
//   MEDIUM for IDENTITY.
//   LOW for APPARENT / PROCEDURAL.
//
// Status: OPEN (newly detected).

import { db } from "@/lib/db";
import { extractDateCandidates } from "../chronology/extractor";
import type {
  CaseContradictionRecord,
  ContradictionType,
  ContradictionSignificance,
} from "../analysis-types";

// ---------------------------------------------------------------------------
// Helpers
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
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isNegationToken(t: string): boolean {
  const negations = [
    "չի", "չէ", "չկա", "չիեղավ", "չիկատարվել", "չկատարվեց", "չպատասխանեց",
    "не", "нет", "никак",
    "no", "not", "never", "denied", "without",
  ];
  return negations.includes(t.toLowerCase());
}

function hasNegation(tokens: Set<string>): boolean {
  for (const t of tokens) if (isNegationToken(t)) return true;
  return false;
}

function extractDateFromText(text: string): string | undefined {
  // Return the first EXACT-date candidate's ISO value.
  const cs = extractDateCandidates(text, { language: "auto" });
  for (const c of cs) {
    if (c.normalized && c.dateStatus === "EXACT") return c.normalized;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pair comparator
// ---------------------------------------------------------------------------

interface Side {
  id: string;
  proposition: string;
  kind: "claim" | "fact";
  claimType?: string; // for claims
  materiality?: string; // for facts
  source?: unknown; // EvidenceRef-ish; preserved for persistence
}

interface Detected {
  type: ContradictionType;
  significance: ContradictionSignificance;
  reason: string;
}

function detect(a: Side, b: Side): Detected | null {
  const ta = tokenize(a.proposition);
  const tb = tokenize(b.proposition);
  const sim = jaccard(ta, tb);
  // §12 — different wording is NOT automatically contradiction.
  // Require meaningful overlap to even consider a pair.
  if (sim < 0.2) return null;

  // (a) Temporal disagreement: same event, different dates.
  const dateA = extractDateFromText(a.proposition);
  const dateB = extractDateFromText(b.proposition);
  if (dateA && dateB && dateA !== dateB) {
    const sig: ContradictionSignificance =
      a.materiality === "HIGH" || b.materiality === "HIGH" ? "HIGH" : "MEDIUM";
    return {
      type: "TEMPORAL",
      significance: sig,
      reason: `Same event referenced with different dates: ${dateA} vs ${dateB}.`,
    };
  }

  // (b) Negation conflict: one side negates, the other affirms.
  const negA = hasNegation(ta);
  const negB = hasNegation(tb);
  if (sim > 0.35 && negA !== negB) {
    // DIRECT if one of the sides is a COURT_FINDING or EXPERT (authoritative).
    const isDirect =
      a.claimType === "COURT_FINDING" ||
      b.claimType === "COURT_FINDING" ||
      a.claimType === "EXPERT" ||
      b.claimType === "EXPERT";
    const sig: ContradictionSignificance =
      isDirect &&
      (a.materiality === "HIGH" || b.materiality === "HIGH")
        ? "HIGH"
        : isDirect
        ? "MEDIUM"
        : "MEDIUM";
    return {
      type: isDirect ? "DIRECT" : "APPARENT",
      significance: sig,
      reason: `Negation conflict: one side negates what the other affirms.`,
    };
  }

  // (c) Court statement vs lower-court record → PROCEDURAL.
  const isCourtVsLower =
    (a.claimType === "COURT_FINDING" && b.claimType === "LOWER_COURT") ||
    (a.claimType === "LOWER_COURT" && b.claimType === "COURT_FINDING");
  if (isCourtVsLower && sim > 0.3 && dateA !== dateB) {
    return {
      type: "PROCEDURAL",
      significance: "LOW",
      reason: `Court statement disagrees with lower-court record.`,
    };
  }

  // (d) Expert vs expert → DIRECT.
  if (a.claimType === "EXPERT" && b.claimType === "EXPERT" && sim > 0.3) {
    return {
      type: "DIRECT",
      significance: "MEDIUM",
      reason: `Expert conclusions disagree.`,
    };
  }

  // (e) Identity conflict: same object/role referenced with different
  // descriptors (overlapping tokens except for one divergent descriptor).
  // Conservative: only flag when sim is very high (> 0.5) AND the two sides
  // differ on a single token (other than date/negation).
  if (sim > 0.5 && !dateA && !dateB && negA === negB) {
    const diffA: string[] = [];
    for (const t of ta) if (!tb.has(t)) diffA.push(t);
    const diffB: string[] = [];
    for (const t of tb) if (!ta.has(t)) diffB.push(t);
    if (diffA.length === 1 && diffB.length === 1) {
      return {
        type: "IDENTITY",
        significance: "MEDIUM",
        reason: `Same object referenced with different descriptor: "${diffA[0]}" vs "${diffB[0]}".`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function safeParseRef(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * §12 — Detect contradictions between CaseClaims and CaseFacts.
 *
 * Persists CaseContradiction records (status=OPEN). Returns the records
 * for the UI to surface.
 */
export async function detectContradictions(
  caseId: string
): Promise<CaseContradictionRecord[]> {
  if (!caseId) return [];

  // Fetch all claims + facts.
  const claims = await db.caseClaim.findMany({ where: { caseId } });
  const facts = await db.caseFact.findMany({ where: { caseId } });

  const sides: Side[] = [
    ...claims.map<Side>((c) => ({
      id: c.id,
      proposition: c.proposition,
      kind: "claim",
      claimType: c.claimType,
      source: safeParseRef(c.source),
    })),
    ...facts.map<Side>((f) => ({
      id: f.id,
      proposition: f.proposition,
      kind: "fact",
      materiality: f.materiality,
      source: undefined,
    })),
  ];

  const detected: Array<{
    a: Side;
    b: Side;
    det: Detected;
  }> = [];
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      // Skip pairs that are both the same fact/claim type unless they truly
      // could conflict (e.g. two different witness statements, two expert
      // conclusions, two lower-court records).
      const a = sides[i];
      const b = sides[j];
      const sameActor =
        a.kind === b.kind && a.claimType === b.claimType && a.kind === "claim";
      // For two facts, only consider a contradiction if their propositions
      // truly differ (don't compare a fact with itself).
      if (a.kind === "fact" && b.kind === "fact" && a.id === b.id) continue;
      // For same-actor claim pairs (e.g. two DEFENDANT statements), we still
      // scan — internal inconsistency is meaningful.
      void sameActor;
      const det = detect(a, b);
      if (det) detected.push({ a, b, det });
    }
  }

  // Reset OPEN contradictions (preserve EXPLAINED/RESOLVED user decisions).
  await db.caseContradiction.deleteMany({
    where: { caseId, status: "OPEN" },
  });

  const records: CaseContradictionRecord[] = [];
  for (const { a, b, det } of detected) {
    const row = await db.caseContradiction.create({
      data: {
        caseId,
        contradictionType: det.type,
        significance: det.significance,
        status: "OPEN",
        claimA: JSON.stringify({
          claimId: a.id,
          proposition: a.proposition,
          source: a.source,
        }),
        claimB: JSON.stringify({
          claimId: b.id,
          proposition: b.proposition,
          source: b.source,
        }),
        reason: det.reason,
      },
    });
    records.push({
      id: row.id,
      caseId: row.caseId,
      contradictionType: row.contradictionType as ContradictionType,
      significance: row.significance as ContradictionSignificance,
      status: row.status as CaseContradictionRecord["status"],
      claimA: {
        claimId: a.id,
        proposition: a.proposition,
        source: a.source as never,
      },
      claimB: {
        claimId: b.id,
        proposition: b.proposition,
        source: b.source as never,
      },
      reason: row.reason ?? undefined,
    });
  }

  return records;
}
