// src/lib/legal-research/synthesis/legal-synthesis.ts
// Research synthesis for the answer engine (master prompt §55-§56).
//
// The answer AI no longer receives "just passages". It receives a
// structured research dossier:
//   Issue Map + Holdings + Material Facts + Applicability Results +
//   Conflicts + Argument Map + Evidence
//
// renderResearchDossier() produces the Armenian prompt block; the DEEP
// answer structure follows §56. Evidence-quality language rules follow
// §53 (establishes / indicates / supports / may support / distinguishable).

import type {
  ResearchReport,
  LegalHolding,
  ApplicabilityResult,
  LegalArgument,
} from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";

const CONCLUSION_LABELS: Record<ApplicabilityResult["conclusion"], string> = {
  DIRECTLY_RELEVANT: "ուղղակիորեն առնչվող",
  RELEVANT_WITH_DISTINCTIONS: "առնչվող՝ էական տարբերություններով",
  ANALOGICAL_ONLY: "միայն անալոգիայի մակարդակով",
  NOT_MATERIALLY_APPLICABLE: "նյութապես ոչ կիրառելի",
  ANALYSIS_UNAVAILABLE: "վերլուծությունն անհասանելի է",
};

const STRENGTH_LABELS: Record<LegalArgument["strength"], string> = {
  STRONG: "ուժեղ",
  MODERATE: "միջին",
  LIMITED: "սահմանափակ",
};

/** Render the dossier block injected into the deep answer prompt. */
export function renderResearchDossier(report: ResearchReport, evidence: LegalEvidence[]): string {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const blocks: string[] = [];

  // ---- 1. Legal issues ---------------------------------------------------
  blocks.push(`## ԻՐԱՎԱԿԱՆ ՀԱՐՑԵՐԻ ՔԱՐՏԵԶ`);
  for (const issue of report.issueMap.issues) {
    const status =
      issue.status === "SUPPORTED"
        ? "աջակցված աղբյուրներով"
        : issue.status === "CONTRADICTED"
          ? "հակասված"
          : issue.status === "UNRESOLVED"
            ? "չլուծված"
            : "բաց";
    blocks.push(`- [${issue.id}] ${issue.title} — կարգավիճակ՝ ${status} (${issue.category})`);
  }
  if (report.issueMap.userFacts.length > 0) {
    blocks.push(
      `\nՕԳՏԱՏԻՐՈՋ ՀԱՅՏՆԱԾ ՓԱՍՏԵՐ (երբեք ապացուցված չեն համարվում). ${report.issueMap.userFacts
        .map((f) => f.fact)
        .join("; ")}`,
    );
  }

  // ---- 2. Verified holdings ----------------------------------------------
  const holdings = report.holdings;
  if (holdings.length > 0) {
    blocks.push(`\n## ՍՏՈՒԳՎԱԾ ԻՐԱՎԱԿԱՆ ԴԻՐՔԵՐ (holdings)`);
    for (const h of holdings) {
      const kind =
        h.kind === "GENERAL_PRINCIPLE"
          ? "ԸՆԴՀԱՆՈՒՐ ՍԿԶԲՈՒՆՔ"
          : h.kind === "CASE_SPECIFIC_FINDING"
            ? "ԿՈՆԿՐԵՏ ԳՈՐԾԻ ԵԶՐԱԿԱՑՈՒԹՅՈՒՆ"
            : "ԱԶԳԱՅԻՆ ԴԻՐՔ";
      const quote = h.supportingPassages[0]?.quote?.slice(0, 260) ?? "";
      blocks.push(
        `- ${h.documentId} [${kind}, վստահություն՝ ${h.confidence}] Հարց՝ ${h.issue}\n  ԴԻՐՔ՝ ${h.rule}${h.conclusion ? `\n  ԵԶՐԱԿԱՑՈՒԹՅՈՒՆ՝ ${h.conclusion}` : ""}${quote ? `\n  ԱՂԲՅՈՒՐ-ՀԱՏՎԱԾ՝ «${quote}»` : ""}`,
      );
    }
  }

  // ---- 3. Applicability table --------------------------------------------
  if (report.applicability.length > 0) {
    blocks.push(`\n## ՆԱԽԱԴԵՊԵՐԻ ԿԻՐԱՌԵԼԻՈՒԹՅՈՒՆ`);
    for (const a of report.applicability) {
      const ev = byId.get(a.precedentId);
      blocks.push(
        `- ${a.precedentId} (${ev?.court ?? ev?.sourceName ?? ""}): ${CONCLUSION_LABELS[a.conclusion]} | հարցի համընկնում՝ ${a.legalIssueMatch} | նորմ՝ ${a.ruleMatch} | փաստական նմանություն՝ ${a.factualSimilarity} | ժամանակային՝ ${a.temporalCompatibility}${a.distinguishingFactors.length > 0 ? ` | ՏԱՐԲԵՐԱԿԻՉՆԵՐ՝ ${a.distinguishingFactors.map((d) => `${d.dimension} (${d.significance})`).join(", ")}` : ""}`,
      );
    }
  }

  // ---- 4. Conflicts -------------------------------------------------------
  if (report.conflicts.length > 0) {
    blocks.push(`\n## ՀԱԿԱՍՈՒԹՅՈՒՆՆԵՐ / ԼԱՐՎԱԾՈՒԹՅՈՒՆՆԵՐ (չթաքցնել)`);
    for (const c of report.conflicts) {
      blocks.push(`- [${c.issueId}] ${c.authorityA} vs ${c.authorityB} (${c.conflictType}). ${c.explanation}`);
    }
  }

  // ---- 5. Argument map ----------------------------------------------------
  if (report.arguments.length > 0) {
    blocks.push(`\n## ՓԱՍՏԱՐԿՆԵՐԻ ՔԱՐՏԵԶ`);
    for (const a of report.arguments) {
      const side =
        a.side === "SUPPORTS_USER_POSITION"
          ? "ԱՋԱԿՑՈՒԹՅՈՒՆ"
          : a.side === "COUNTERARGUMENT"
            ? "ՀԱԿԱՓԱՍՏԱՐԿ"
            : "ՉԵԶՈՔ";
      blocks.push(
        `- [${a.issueId}] ${side} (${STRENGTH_LABELS[a.strength]}). ${a.proposition}${a.limitations.length > 0 ? `\n  ՍԱՀՄԱՆԱՓԱԿՈՒՄՆԵՐ՝ ${a.limitations.join("; ")}` : ""}`,
      );
    }
  }

  // ---- 6. Missing facts ----------------------------------------------------
  if (report.missingFacts.length > 0) {
    blocks.push(`\n## ԲԱՑԱԿԱՅՈՂ ՓԱՍՏԵՐ (պայմանական վերլուծություն տալ)`);
    for (const mf of report.missingFacts) {
      blocks.push(`- ${mf.factNeeded}. ${mf.whyItMatters}`);
    }
  }

  // ---- 7. Completeness -----------------------------------------------------
  const c = report.completeness;
  blocks.push(
    `\n## ՀԵՏԱԶՈՏՈՒԹՅԱՆ ԼՐԱՑՎԱԾՈՒԹՅՈՒՆ\n${c.issuesIdentified} իրավական հարց · ${c.precedentsAnalyzed} վերլուծված նախադեպ · ${c.counterAuthoritiesFound} հակափաստարկ · ${c.temporalRisks} ժամանակային ռիսկ · ${c.unresolvedIssues} չլուծված հարց`,
  );

  if (report.partial) {
    blocks.push(`\n⚠️ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆԸ ՄԱՍՆԱԿԻ Է. ${report.notes.join(" ")}`);
  }

  return blocks.join("\n");
}

/** §110 — research summary line for the trace panel. */
export function researchSummaryLine(report: ResearchReport): string {
  const directly = report.applicability.filter((a) => a.conclusion === "DIRECTLY_RELEVANT").length;
  const withDist = report.applicability.filter((a) => a.conclusion === "RELEVANT_WITH_DISTINCTIONS").length;
  const notApplicable = report.applicability.filter((a) => a.conclusion === "NOT_MATERIALLY_APPLICABLE").length;
  const parts = [
    `${report.completeness.issuesIdentified} իրավական հարց`,
    `${report.completeness.precedentsAnalyzed} վերլուծված նախադեպ`,
  ];
  if (directly > 0) parts.push(`${directly} ուղղակիորեն առնչվող`);
  if (withDist > 0) parts.push(`${withDist} առնչվող՝ տարբերություններով`);
  if (notApplicable > 0) parts.push(`${notApplicable} ոչ կիրառելի`);
  if (report.completeness.counterAuthoritiesFound > 0) {
    parts.push(`${report.completeness.counterAuthoritiesFound} հակափաստարկ`);
  }
  if (report.completeness.unresolvedIssues > 0) {
    parts.push(`${report.completeness.unresolvedIssues} չլուծված հարց`);
  }
  return parts.join(" · ");
}
