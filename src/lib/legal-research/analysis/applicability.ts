// src/lib/legal-research/analysis/applicability.ts
// APPLICABILITY ENGINE (master prompt §20-§24).
//
// analyzeApplicability(userIssue, userFacts, precedent) — structured and
// evidence-based, NEVER a magic percentage (§22). Ten dimensions are scored
// separately (§21) and the conclusion is derived deterministically:
//
//   DIRECTLY_RELEVANT        same issue + same/related rule + high factual
//                            similarity + compatible in time + no MAJOR
//                            distinguisher + binding/highly persuasive;
//   RELEVANT_WITH_DISTINCTIONS strong/partial issue match with moderate
//                            similarity or material distinguishing factors;
//   ANALOGICAL_ONLY          partial/weak issue match or low similarity with
//                            no rule identity;
//   NOT_MATERIALLY_APPLICABLE weak issue match / different rule + low
//                            similarity / irrelevant role (§93);
//   ANALYSIS_UNAVAILABLE     metadata-only document (§63) or failed analysis
//                            (§76) — no fake applicability.

import type {
  ApplicabilityResult,
  DistinguishingFactor,
  LegalIssue,
  MaterialFact,
  SupportingFactor,
  UserCaseFact,
  LegalHolding,
  IssueMatch,
  RuleMatch,
  FactualSimilarity,
  PostureMatch,
} from "../types";
import type { LegalEvidence, QueryUnderstanding } from "@/lib/legal-search/types";
import { authorityWeight } from "./hierarchy-analysis";
import { findDistinguishingFactors } from "./distinguishing";

/** Statute-type sources — the norm text itself, not a precedent. */
function isStatute(e: LegalEvidence): boolean {
  return e.sourceType === "legislation" || e.sourceType === "local_laws";
}

/** Token overlap: fraction of `a`'s significant tokens present in `b`. */
export function tokenOverlap(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\u0561-\u0587a-z0-9§]+/)
        .filter((t) => t.length >= 4),
    );
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / ta.size;
}

/** §21.1 — same legal issue? */
export function matchLegalIssue(issue: LegalIssue, precedent: LegalEvidence, holdings: LegalHolding[]): IssueMatch {
  const holdingIssue = holdings.map((h) => h.issue).join(" ");
  const s1 = tokenOverlap(issue.title, `${precedent.title} ${precedent.passage.slice(0, 800)}`);
  const s2 = holdingIssue ? tokenOverlap(issue.title, holdingIssue) : 0;
  const best = Math.max(s1, s2);
  if (best >= 0.34) return "STRONG";
  if (best >= 0.15) return "PARTIAL";
  return "WEAK";
}

/** §21.2 — same / comparable legal provision? */
export function matchRule(
  understanding: QueryUnderstanding,
  precedent: LegalEvidence,
): RuleMatch {
  const wanted = new Set(
    understanding.exactReferences.articles.map((a) => a.replace(/\s+/g, "")).filter(Boolean),
  );
  const precedentArticle = precedent.article?.replace(/\s+/g, "");
  const precedentAct = precedent.actNumber;

  if (wanted.size > 0 && precedentArticle && wanted.has(precedentArticle)) {
    return "SAME_RULE";
  }
  // Same act family without a pinned article.
  const wantedActs = understanding.exactReferences.actTitles;
  const titleText = `${precedent.title} ${precedentAct ?? ""}`.toLowerCase();
  if (wantedActs.length > 0 && wantedActs.some((a) => titleText.includes(a.toLowerCase().slice(0, 24)))) {
    return "RELATED_RULE";
  }
  // Concept-level relatedness: same concept phrase in title/passage.
  const conceptHit = understanding.concepts.some((c) =>
    `${precedent.title} ${precedent.passage.slice(0, 600)}`.toLowerCase().includes(c.hy.toLowerCase()),
  );
  if (conceptHit) return "RELATED_RULE";

  if (wanted.size > 0 && precedentArticle && !wanted.has(precedentArticle)) {
    return "DIFFERENT_RULE";
  }
  return "UNKNOWN";
}

/** §21.3+§21.4 — factual similarity from material facts (deterministic). */
export function matchFactualSimilarity(
  userFacts: UserCaseFact[],
  precedentFacts: MaterialFact[],
): { similarity: FactualSimilarity; matched: number; total: number } {
  if (userFacts.length === 0 || precedentFacts.length === 0) {
    return { similarity: "UNKNOWN", matched: 0, total: Math.max(userFacts.length, precedentFacts.length) };
  }
  const { distinguishing, supporting } = findDistinguishingFactors(userFacts, precedentFacts);
  const denom = supporting.length + distinguishing.filter((d) => d.userCase !== "օգտատիրոջ իրավիճակում անհայտ է" && d.precedentCase !== "նախադեպում չի հանդիպում").length;
  if (denom === 0) return { similarity: "UNKNOWN", matched: 0, total: 0 };
  const ratio = supporting.length / denom;
  if (ratio >= 0.6) return { similarity: "HIGH", matched: supporting.length, total: denom };
  if (ratio >= 0.3) return { similarity: "MEDIUM", matched: supporting.length, total: denom };
  return { similarity: "LOW", matched: supporting.length, total: denom };
}

/** §21.5 — procedural posture from STAGE facts. */
export function matchPosture(
  userFacts: UserCaseFact[],
  precedentFacts: MaterialFact[],
): PostureMatch {
  const stageFacts = precedentFacts.filter((f) => f.category === "STAGE");
  if (stageFacts.length === 0 || userFacts.length === 0) return "UNKNOWN";
  const userStage = userFacts.find((f) => /վարույթ|փուլ|proceed|stage|քննություն/i.test(f.fact));
  if (!userStage) return "UNKNOWN";
  const overlap = tokenOverlap(userStage.fact, stageFacts.map((f) => f.fact).join(" "));
  if (overlap >= 0.34) return "SAME";
  if (overlap >= 0.12) return "COMPARABLE";
  return "DIFFERENT";
}

/**
 * Derive the conclusion from the structured dimensions (§23).
 * Pure function — fully deterministic.
 */
export function deriveConclusion(dim: {
  legalIssueMatch: IssueMatch;
  ruleMatch: RuleMatch;
  factualSimilarity: FactualSimilarity;
  proceduralPostureMatch: PostureMatch;
  temporalCompatibility: ApplicabilityResult["temporalCompatibility"];
  authority: ApplicabilityResult["authority"];
  majorDistinguishers: number;
  laterAuthorities: number;
}): ApplicabilityResult["conclusion"] {
  const { legalIssueMatch, ruleMatch, factualSimilarity, temporalCompatibility, majorDistinguishers } = dim;

  // NOT_MATERIALLY_APPLICABLE (§93): weak issue match, or different rule
  // with low factual similarity — regardless of lexical resemblance.
  if (legalIssueMatch === "WEAK") return "NOT_MATERIALLY_APPLICABLE";
  if (ruleMatch === "DIFFERENT_RULE" && (factualSimilarity === "LOW" || factualSimilarity === "UNKNOWN")) {
    return "NOT_MATERIALLY_APPLICABLE";
  }

  // DIRECTLY_RELEVANT: everything lines up.
  if (
    legalIssueMatch === "STRONG" &&
    (ruleMatch === "SAME_RULE" || ruleMatch === "RELATED_RULE") &&
    factualSimilarity === "HIGH" &&
    majorDistinguishers === 0 &&
    (temporalCompatibility === "COMPATIBLE" || temporalCompatibility === "UNKNOWN")
  ) {
    return "DIRECTLY_RELEVANT";
  }

  // RELEVANT_WITH_DISTINCTIONS: strong issue alignment but material
  // differences or moderate similarity.
  if (
    (legalIssueMatch === "STRONG" || legalIssueMatch === "PARTIAL") &&
    (factualSimilarity === "MEDIUM" || factualSimilarity === "HIGH" || majorDistinguishers > 0)
  ) {
    return "RELEVANT_WITH_DISTINCTIONS";
  }

  return "ANALOGICAL_ONLY";
}

/**
 * Statute conclusion derivation: the governing text applies when it covers
 * the issue; factual comparison is meaningless for the norm itself.
 */
export function deriveStatuteConclusion(dim: {
  legalIssueMatch: IssueMatch;
  ruleMatch: RuleMatch;
}): ApplicabilityResult["conclusion"] {
  if (
    dim.legalIssueMatch === "STRONG" &&
    (dim.ruleMatch === "SAME_RULE" || dim.ruleMatch === "RELATED_RULE" || dim.ruleMatch === "UNKNOWN")
  ) {
    return "DIRECTLY_RELEVANT";
  }
  if (dim.legalIssueMatch === "PARTIAL") return "RELEVANT_WITH_DISTINCTIONS";
  return "ANALOGICAL_ONLY";
}

/**
 * The full applicability analysis for one (precedent, issue) pair.
 * `temporal` comes from the temporal engine; `relations` for later
 * authorities; metadataOnly documents short-circuit (§63).
 */
export function analyzeApplicability(
  issue: LegalIssue,
  userFacts: UserCaseFact[],
  precedent: LegalEvidence,
  understanding: QueryUnderstanding,
  holdings: LegalHolding[],
  precedentFacts: MaterialFact[],
  temporal: ApplicabilityResult["temporalCompatibility"],
  laterAuthorities: string[],
): ApplicabilityResult {
  // §63 — metadata-only: existence/court/date/case number only, never a
  // holding, never an applicability verdict.
  if (!precedent.fullTextVerified) {
    return {
      precedentId: precedent.id,
      issueId: issue.id,
      legalIssueMatch: "WEAK",
      ruleMatch: "UNKNOWN",
      factualSimilarity: "UNKNOWN",
      proceduralPostureMatch: "UNKNOWN",
      temporalCompatibility: temporal,
      authority: authorityWeight(precedent),
      distinguishingFactors: [],
      supportingFactors: [],
      conclusion: "ANALYSIS_UNAVAILABLE",
      evidence: [],
      metadataOnly: true,
    };
  }

  const legalIssueMatch = matchLegalIssue(issue, precedent, holdings);
  const ruleMatch = matchRule(understanding, precedent);
  const { similarity: factualSimilarity } = matchFactualSimilarity(userFacts, precedentFacts);
  const proceduralPostureMatch = matchPosture(userFacts, precedentFacts);

  const { distinguishing, supporting } = findDistinguishingFactors(userFacts, precedentFacts, holdings[0]);
  const majorDistinguishers = distinguishing.filter((d) => d.significance === "MAJOR").length;

  // Statutes: the provision itself governs the issue — factual similarity
  // is a precedent dimension, not a statute dimension (§21.4 applies to
  // precedent analysis).
  const conclusion = isStatute(precedent)
    ? deriveStatuteConclusion({ legalIssueMatch, ruleMatch })
    : deriveConclusion({
        legalIssueMatch,
        ruleMatch,
        factualSimilarity,
        proceduralPostureMatch,
        temporalCompatibility: temporal,
        authority: authorityWeight(precedent),
        majorDistinguishers,
        laterAuthorities: laterAuthorities.length,
      });

  const evidence: Array<{ evidenceId: string; quote: string }> = holdings
    .flatMap((h) => h.supportingPassages)
    .slice(0, 2);

  return {
    precedentId: precedent.id,
    issueId: issue.id,
    legalIssueMatch,
    ruleMatch,
    factualSimilarity,
    proceduralPostureMatch,
    temporalCompatibility: temporal,
    authority: authorityWeight(precedent),
    distinguishingFactors: distinguishing,
    supportingFactors: supporting,
    conclusion,
    evidence,
    metadataOnly: false,
  };
}
