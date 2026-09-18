// src/lib/legal-research/argument/argument-map.ts
// Argument map construction (master prompt §46-§49).
//
// For every issue with authority coverage, build:
//   SUPPORTS_USER_POSITION arguments  (from DIRECTLY_RELEVANT /
//     RELEVANT_WITH_DISTINCTIONS precedents with verified holdings);
//   COUNTERARGUMENTS                  (from COUNTER_AUTHORITY roles, NOT_
//     MATERIALLY_APPLICABLE near-misses, and DISTINGUISHES/LIMITS relations
//     against the supporting precedent — §48: deep mode MUST NOT hide them);
//   limitations                       (temporal risks, distinguishing
//     factors, metadata-only gaps).
//
// No binary winner language (§24) — the map describes legal applicability.

import type {
  ApplicabilityResult,
  LegalArgument,
  LegalHolding,
  LegalIssue,
  DistinguishingFactor,
  PrecedentRelation,
  DocumentRoleAssessment,
} from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";
import { ANALYSIS } from "@/lib/legal-search/config";
import { computeStrength } from "./evidence-strength";

export function buildArgumentMap(
  issues: LegalIssue[],
  pack: LegalEvidence[],
  roles: DocumentRoleAssessment[],
  holdings: LegalHolding[],
  applicability: ApplicabilityResult[],
  relations: PrecedentRelation[],
): LegalArgument[] {
  const args: LegalArgument[] = [];
  const byId = new Map(pack.map((e) => [e.id, e]));
  const roleBy = new Map(roles.map((r) => [r.evidenceId, r]));
  const holdingsByDoc = new Map<string, LegalHolding[]>();
  for (const h of holdings) {
    const list = holdingsByDoc.get(h.documentId) ?? [];
    list.push(h);
    holdingsByDoc.set(h.documentId, list);
  }

  for (const issue of issues) {
    const apps = applicability.filter((a) => a.issueId === issue.id);
    if (apps.length === 0) continue;

    // ---- Supporting arguments -------------------------------------------
    const supporting = apps
      .filter((a) => a.conclusion === "DIRECTLY_RELEVANT" || a.conclusion === "RELEVANT_WITH_DISTINCTIONS")
      .sort(byStrengthThenAuthority);
    for (const app of supporting) {
      const ev = byId.get(app.precedentId);
      if (!ev) continue;
      const hs = holdingsByDoc.get(app.precedentId) ?? [];
      const counterRel = relations.some(
        (r) => r.toId === app.precedentId && (r.kind === "DISTINGUISHES" || r.kind === "LIMITS"),
      );
      const strength = computeStrength({
        applicability: app,
        evidence: ev,
        holdings: hs,
        hasCounterAuthority: counterRel,
      });
      args.push({
        id: `A${args.length + 1}`,
        issueId: issue.id,
        proposition: supportingProposition(issue, app, hs),
        side: "SUPPORTS_USER_POSITION",
        authorities: authorityRefs(app, hs),
        strength,
        limitations: buildLimitations(app),
      });
    }

    // ---- Counterarguments (§48 — mandatory in deep mode) -----------------
    const counters = apps
      .filter(
        (a) =>
          a.conclusion === "NOT_MATERIALLY_APPLICABLE" ||
          roleBy.get(a.precedentId)?.role === "COUNTER_AUTHORITY",
      )
      .sort(byStrengthThenAuthority)
      .slice(0, ANALYSIS.maxCounterAuthorities);
    for (const app of counters) {
      const ev = byId.get(app.precedentId);
      if (!ev) continue;
      const hs = holdingsByDoc.get(app.precedentId) ?? [];
      args.push({
        id: `A${args.length + 1}`,
        issueId: issue.id,
        proposition: counterProposition(app, hs),
        side: "COUNTERARGUMENT",
        authorities: authorityRefs(app, hs),
        strength: computeStrength({ applicability: app, evidence: ev, holdings: hs, hasCounterAuthority: false }),
        limitations: buildLimitations(app),
      });
    }

    // ---- Distinguishing-relation counterarguments ------------------------
    for (const rel of relations) {
      if (rel.kind !== "DISTINGUISHES" && rel.kind !== "LIMITS") continue;
      // Only when the TARGET is one of our supporting precedents.
      if (!supporting.some((a) => a.precedentId === rel.toId)) continue;
      const ev = byId.get(rel.fromId);
      if (!ev) continue;
      if (args.some((a) => a.issueId === issue.id && a.authorities.some((r) => r.evidenceId === rel.fromId))) {
        continue;
      }
      args.push({
        id: `A${args.length + 1}`,
        issueId: issue.id,
        proposition:
          rel.kind === "LIMITS"
            ? `${rel.fromId}-ը սահմանափակում է աջակցող ${rel.toId}-ի դիրքի կիրառությունը`
            : `${rel.fromId}-ը տարբերակում է աջակցող ${rel.toId}-ի փաստային կողմը`,
        side: "COUNTERARGUMENT",
        authorities: [rel.evidence],
        strength: "MODERATE",
        limitations: ["Հարաբերությունը հաստատված է միայն տեքստային հղմամբ. գնահատեք փաստերի համընկնումը։"],
      });
    }
  }

  // Update issue statuses from the argument map.
  for (const issue of issues) {
    const issueArgs = args.filter((a) => a.issueId === issue.id);
    if (issueArgs.length === 0) {
      issue.status = "UNRESOLVED";
    } else if (issueArgs.some((a) => a.side === "SUPPORTS_USER_POSITION" && a.strength !== "LIMITED")) {
      issue.status = "SUPPORTED";
    } else if (issueArgs.every((a) => a.side === "COUNTERARGUMENT")) {
      issue.status = "CONTRADICTED";
    } else {
      issue.status = "UNRESOLVED";
    }
  }

  return args;
}

function byStrengthThenAuthority(a: ApplicabilityResult, b: ApplicabilityResult): number {
  const rank = (x: ApplicabilityResult) =>
    x.conclusion === "DIRECTLY_RELEVANT" ? 3 : x.conclusion === "RELEVANT_WITH_DISTINCTIONS" ? 2 : 1;
  return rank(b) - rank(a);
}

function supportingProposition(
  issue: LegalIssue,
  app: ApplicabilityResult,
  holdings: LegalHolding[],
): string {
  const h = holdings[0];
  const qualifier =
    app.conclusion === "DIRECTLY_RELEVANT"
      ? "ուղղակիորեն առնչվող"
      : "էական տարբերություններով առնչվող";
  if (h) {
    return `${app.precedentId}-ի դիրքն աջակցում է «${issue.title}» հարցի ${qualifier} լուծմանը. ${h.rule.slice(0, 200)}`;
  }
  return `${app.precedentId}-ը ${qualifier} նախադեպ է «${issue.title}» հարցի համար`;
}

function counterProposition(app: ApplicabilityResult, holdings: LegalHolding[]): string {
  const h = holdings[0];
  if (h) {
    return `${app.precedentId}-ի դիրքը հակադրվում է սպասվող լուծմանը. ${h.rule.slice(0, 200)}`;
  }
  return `${app.precedentId}-ը նյութապես կիրառելի չէ այս իրավիճակին (նման բառապաշար, տարբեր իրավական հարց)`;
}

function authorityRefs(app: ApplicabilityResult, holdings: LegalHolding[]) {
  const refs = holdings.flatMap((h) => h.supportingPassages);
  if (refs.length > 0) return refs.slice(0, 2);
  return app.evidence.slice(0, 1);
}

function buildLimitations(app: ApplicabilityResult): string[] {
  const out: string[] = [];
  if (app.temporalCompatibility === "POTENTIALLY_STALE") {
    out.push("Գոյություն ունի ավելի ուշ պրակտիկա/խմբագրություն. ստուգեք ժամանակային կիրառելիությունը։");
  }
  const major = app.distinguishingFactors.filter((d) => d.significance === "MAJOR");
  for (const d of major.slice(0, 2)) {
    out.push(`Էական տարբերություն (${d.dimension}). ${d.whyItMayMatter}`);
  }
  if (app.factualSimilarity === "UNKNOWN") {
    out.push("Փաստական նմանությունը հնարավոր չեղավ գնահատել. բացակայում են նյութական փաստերի տվյալները։");
  }
  return out;
}
