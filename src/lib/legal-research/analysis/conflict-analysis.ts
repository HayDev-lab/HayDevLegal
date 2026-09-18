// src/lib/legal-research/analysis/conflict-analysis.ts
// Conflict / consistency analysis (master prompt §39-§42).
//
// DETERMINISTIC and deliberately CONSERVATIVE (§40): different wording is
// NOT a conflict. Before reporting anything we require:
//   - both authorities address the SAME issue (shared issue keywords), and
//   - a structural signal:
//       . a DISTINGUISHES/LIMITS relation between them  -> FACT_DEPENDENT /
//         TEMPORAL conflict with the relation's own evidence;
//       . a same-provision polarity clash (one holds X, the other refuses X)
//         -> APPARENT (scope re-check advised), never DIRECT without an
//           explicit textual statement.
//   - different provisions / different issues -> DIFFERENT_SCOPE note only
//     when both sides looked conflicting on the surface.
//
// §41-§42 — ConCourt and ECtHR interactions are surfaced as scope notes,
// keeping domestic rule and Convention standard separate.

import type {
  LegalConflict,
  LegalConflictType,
  LegalHolding,
  PrecedentRelation,
  LegalIssue,
} from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";

/** Conjunction of significant tokens shared by two strings (Armenian-aware). */
function sharedTokens(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\u0561-\u0587a-z0-9§]+/)
        .filter((t) => t.length >= 4),
    );
  const ta = tok(a);
  const tb = tok(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared;
}

/** Polarity markers of a holding's conclusion (exported for role upgrade). */
const AFFIRMATIVE = ["պետք է", "պարտադիր է", "եղել է", "ճանաչել է", "գրանցվել է", "հիմնավոր է", "violation"];
const NEGATIVE = ["պարտադիր չէ", "չի եղել", "մերժել է", "չի ճանաչել", "չի գրանցվել", "հիմնավոր չէ", "no violation"];

export function holdingPolarity(h: LegalHolding): 1 | -1 | 0 {
  const text = `${h.rule} ${h.conclusion ?? ""}`.toLowerCase();
  const aff = AFFIRMATIVE.some((m) => text.includes(m));
  const neg = NEGATIVE.some((m) => text.includes(m));
  if (aff && !neg) return 1;
  if (neg && !aff) return -1;
  return 0;
}

export function analyzeConflicts(
  issues: LegalIssue[],
  pack: LegalEvidence[],
  holdings: LegalHolding[],
  relations: PrecedentRelation[],
): LegalConflict[] {
  const conflicts: LegalConflict[] = [];
  const byId = new Map(pack.map((e) => [e.id, e]));
  const holdingsByDoc = new Map<string, LegalHolding[]>();
  for (const h of holdings) {
    const list = holdingsByDoc.get(h.documentId) ?? [];
    list.push(h);
    holdingsByDoc.set(h.documentId, list);
  }

  // 1. Relation-driven conflicts (§69 — negative treatment is critical).
  for (const rel of relations) {
    if (rel.kind !== "DISTINGUISHES" && rel.kind !== "LIMITS" && rel.kind !== "CONFLICTS_WITH") {
      continue;
    }
    const a = byId.get(rel.fromId);
    const b = byId.get(rel.toId);
    if (!a || !b) continue;

    const issueId = matchingIssue(issues, `${a.title} ${b.title}`);
    const conflictType: LegalConflictType =
      rel.kind === "LIMITS" ? "TEMPORAL" : "FACT_DEPENDENT";

    conflicts.push({
      issueId,
      authorityA: rel.fromId,
      authorityB: rel.toId,
      conflictType,
      explanation:
        rel.kind === "LIMITS"
          ? `${rel.fromId}-ը սահմանափակում է ${rel.toId}-ի կիրառությունը. ստուգեք, արդյոք սահմանափակումը վերաբերում է Ձեր իրավիճակին։`
          : `${rel.fromId}-ը տարբերակում է ${rel.toId}-ը. կիրառելիությունը կախված է փաստերի համընկնումից։`,
      evidence: [rel.evidence],
    });
  }

  // 2. Same-issue polarity clashes between analyzed holdings (§40).
  const docIds = [...holdingsByDoc.keys()];
  for (let i = 0; i < docIds.length; i++) {
    for (let j = i + 1; j < docIds.length; j++) {
      const aId = docIds[i];
      const bId = docIds[j];
      const aH = holdingsByDoc.get(aId) ?? [];
      const bH = holdingsByDoc.get(bId) ?? [];
      if (aH.length === 0 || bH.length === 0) continue;

      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b) continue;
      // ConCourt vs Cassation / ECtHR vs domestic — different systemic roles
      // (§37, §42): a difference there is NOT automatically a conflict.
      const systemicPair =
        (a.sourceType === "echr" && b.sourceType !== "echr") ||
        (a.sourceType !== "echr" && b.sourceType === "echr") ||
        (a.sourceType === "constitutional_court" && b.sourceType !== "constitutional_court") ||
        (a.sourceType !== "constitutional_court" && b.sourceType === "constitutional_court");

      for (const ha of aH) {
        for (const hb of bH) {
          if (sharedTokens(ha.issue, hb.issue) < 2) continue; // not same issue
          const pa = holdingPolarity(ha);
          const pb = holdingPolarity(hb);
          if (pa === 0 || pb === 0 || pa === pb) continue; // no polarity clash

          const issueId = matchingIssue(issues, `${ha.issue} ${hb.issue}`);
          conflicts.push({
            issueId,
            authorityA: aId,
            authorityB: bId,
            conflictType: systemicPair ? "DIFFERENT_SCOPE" : "APPARENT",
            explanation: systemicPair
              ? `${aId}-ի և ${bId}-ի դիրքերը տարբեր համակարգային դերերից են գալիս. համեմատեք կիրառման ոլորտները նախքան եզրակացությունը։`
              : `${aId}-ը և ${bId}-ը նույն հարցի վերաբերյալ հակառակ եզրակացություններ են պարունակում. սա երևութական հակասություն է. ստուգեք փաստերի շրջանակը և ժամկետները։`,
            evidence: [...ha.supportingPassages, ...hb.supportingPassages].slice(0, 2),
          });
        }
      }
    }
  }

  return conflicts.slice(0, 6);
}

function matchingIssue(issues: LegalIssue[], text: string): string {
  let best: LegalIssue | null = null;
  let bestScore = 0;
  for (const iss of issues) {
    const score = sharedTokens(iss.title, text);
    if (score > bestScore) {
      bestScore = score;
      best = iss;
    }
  }
  return best ? best.id : issues[0]?.id ?? "I1";
}
