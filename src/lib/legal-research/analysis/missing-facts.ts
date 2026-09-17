// src/lib/legal-research/analysis/missing-facts.ts
// Missing-material-fact detection (master prompt §97-§99).
//
// When a material fact is unknown, the system says:
//   "Applicability depends on whether X occurred"
// instead of guessing. DETERMINISTIC: derived from applicability results
// whose factualSimilarity is UNKNOWN and from distinguishing factors whose
// userCase side is unknown.

import type {
  ApplicabilityResult,
  MissingMaterialFact,
  DistinguishingFactor,
  LegalIssue,
} from "../types";

/** Unknown-side marker used by the distinguishing engine. */
const USER_UNKNOWN = "օգտատիրոջ իրավիճակում անհայտ է";

export function detectMissingFacts(
  issues: LegalIssue[],
  applicability: ApplicabilityResult[],
): MissingMaterialFact[] {
  const out: MissingMaterialFact[] = [];
  const seen = new Set<string>();
  const issueBy = new Map(issues.map((i) => [i.id, i]));

  const push = (factNeeded: string, whyItMatters: string, issueIds: string[]) => {
    const key = factNeeded.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ factNeeded, whyItMatters, affectedIssueIds: issueIds });
  };

  for (const app of applicability) {
    if (app.metadataOnly) continue;

    // 1. Factual similarity could not be established at all.
    if (app.factualSimilarity === "UNKNOWN") {
      const issue = issueBy.get(app.issueId);
      push(
        `Հաստատեք փաստերը՝ առնչվող ${app.precedentId}-ի հետ համեմատելու համար (վարույթի փուլ, ծանուցում, ժամկետներ)`,
        `Առանց այդ փաստերի ${app.precedentId}-ի կիրառելիությունը գնահատված չէ. պատասխանը պայմանական է (§99)։`,
        [app.issueId],
      );
    }

    // 2. Distinguishing factor with an unknown user side (§97).
    for (const d of app.distinguishingFactors) {
      if (d.userCase.includes(USER_UNKNOWN) || d.userCase.includes("անհայտ")) {
        const issue = issueBy.get(app.issueId);
        push(
          `Պարզեք՝ արդյոք ${d.dimension}-ը Ձեր իրավիճակում նույնն է, ինչ ${app.precedentId}-ում (${d.precedentCase.slice(0, 120)})`,
          d.whyItMayMatter,
          [app.issueId],
        );
      }
    }
  }

  // 3. Issues with no analyzed precedent at all.
  const coveredIssues = new Set(applicability.map((a) => a.issueId));
  for (const issue of issues) {
    if (!coveredIssues.has(issue.id)) {
      push(
        `${issue.title} հարցի վերաբերյալ ապացույցներ չեն գտնվել. ներկայացրեք լրացուցիչ փաստեր կամ ճշտեք հարցը`,
        `Առանց աղբյուրների հարցը մնում է չլուծված (§100)։`,
        [issue.id],
      );
    }
  }

  return out.slice(0, 6);
}
