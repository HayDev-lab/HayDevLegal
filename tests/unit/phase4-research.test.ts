// tests/unit/phase4-research.test.ts
// Phase 4 unit tests: research intelligence layer.
//
//   - issue map construction (§8-§9)
//   - document role classification (§10)
//   - section-aware splitting + party-claim quarantine (§13-§14)
//   - holding verification ACCEPT/WEAK/REJECT (§15)
//   - temporal analysis incl. date parsing (§33-§35)
//   - hierarchy/authority (§36-§38)
//   - applicability dimension matching + conclusions (§20-§24)
//   - distinguishing polarity clash (§25-§28)
//   - conflict conservatism (§39-§42)
//   - argument strength inputs (§47)
//   - proposition verification (§50-§54)
//   - LLM fail-closed + JSON extraction (§75-§76)
//   - analysis cache invalidation (§73-§74)

import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import {
  buildIssueMap,
  inferIssueCategory,
} from "@/lib/legal-research/issue-map/issue-map";
import { classifyDocumentRole, analysisPriority } from "@/lib/legal-research/analysis/document-role";
import {
  splitCourtSections,
  holdingEligibleText,
  partySubmissionTexts,
} from "@/lib/legal-research/analysis/document-sections";
import { verifyQuote, verifyHolding } from "@/lib/legal-research/verification/holding-verifier";
import { analyzeTemporalApplicability, parseDate } from "@/lib/legal-research/analysis/temporal-analysis";
import { assessAuthority, authorityWeight } from "@/lib/legal-research/analysis/hierarchy-analysis";
import {
  matchLegalIssue,
  matchRule,
  matchFactualSimilarity,
  deriveConclusion,
  analyzeApplicability,
} from "@/lib/legal-research/analysis/applicability";
import { findDistinguishingFactors } from "@/lib/legal-research/analysis/distinguishing";
import { analyzeConflicts, holdingPolarity } from "@/lib/legal-research/analysis/conflict-analysis";
import { computeStrength } from "@/lib/legal-research/argument/evidence-strength";
import { verifyPropositions } from "@/lib/legal-research/verification/proposition-verifier";
import { extractJson } from "@/lib/legal-research/llm";
import { cacheGet, cacheSet, cacheClear, cacheStats } from "@/lib/legal-research/analysis-cache";
import { und, ev, baseQuery } from "@/lib/legal-research/evaluation/gold-fixtures";
import type { LegalHolding, MaterialFact, UserCaseFact, LegalIssue } from "@/lib/legal-research/types";

// ---------------------------------------------------------------------------

beforeEach(() => {
  cacheClear();
});

describe("issue map (§8-§9)", () => {
  test("deterministic fallback creates a single issue from concepts", async () => {
    const u = und({ concepts: [{ hy: "պատշաճ ծանուցում", detectedBy: "lexicon" }] });
    const map = await buildIssueMap("պատշաճ ծանուցում", u, null);
    expect(map.issues.length).toBe(1);
    expect(map.issues[0].title).toBe("պատշաճ ծանուցում");
    expect(map.issues[0].status).toBe("OPEN");
  });

  test("subquestions become issues without extra LLM calls", async () => {
    const u = und({ subquestions: ["Ո՞ր օրգանն է իրավունք ստանում", "Ի՞նչ ժամկետ է սահմանված"] });
    const map = await buildIssueMap("հարց", u, null);
    expect(map.issues.length).toBe(2);
    expect(map.builtBy).toBe("deterministic");
  });

  test("exact case numbers get a dedicated issue (§92)", async () => {
    const u = und({ exactReferences: { articles: [], caseNumbers: ["ՎԴ/0008/05/23"], actTitles: [] }, hasExactReference: true });
    const map = await buildIssueMap("ՎԴ/0008/05/23 կիրառելի՞ է", u, null);
    expect(map.issues.some((i) => i.title.includes("ՎԴ/0008/05/23"))).toBe(true);
  });

  test("category inference", () => {
    expect(inferIssueCategory("ՄԻԵՎԴ 5-րդ հոդված")).toBe("ECHR");
    expect(inferIssueCategory("սահմանադրական վերահսկողություն")).toBe("CONSTITUTIONAL");
    expect(inferIssueCategory("ապացույցների դյուրահավատություն")).toBe("EVIDENTIARY");
    expect(inferIssueCategory("ծանուցման ժամկետ")).toBe("PROCEDURAL");
    expect(inferIssueCategory("փոխհատուցում")).toBe("REMEDY");
    expect(inferIssueCategory("սեփականության իրավունք")).toBe("SUBSTANTIVE");
  });
});

describe("document role classification (§10)", () => {
  test("legislation -> GOVERNING_RULE", () => {
    const role = classifyDocumentRole(ev({ id: "E1", passage: "Հոդված 1...", sourceType: "legislation" }));
    expect(role.role).toBe("GOVERNING_RULE");
  });

  test("ConCourt -> CONSTITUTIONAL_STANDARD, ECHR -> ECHR_STANDARD", () => {
    expect(classifyDocumentRole(ev({ id: "E2", passage: "մեկնաբանություն", sourceType: "constitutional_court" })).role).toBe("CONSTITUTIONAL_STANDARD");
    expect(classifyDocumentRole(ev({ id: "E3", passage: "The Court recalls", sourceType: "echr" })).role).toBe("ECHR_STANDARD");
  });

  test("cassation with reasoning markers -> INTERPRETIVE_PRECEDENT", () => {
    const role = classifyDocumentRole(
      ev({ id: "E4", passage: "Դատարանը եզրակացրել է, որ իրավական դիրքն այսպիսին է", sourceType: "cassation" }),
    );
    expect(role.role).toBe("INTERPRETIVE_PRECEDENT");
  });

  test("web -> SECONDARY_CONTEXT; analysis priority favors verified interpretive (§64)", () => {
    expect(classifyDocumentRole(ev({ id: "E5", passage: "blog post", sourceType: "web" })).role).toBe("SECONDARY_CONTEXT");
    const interpretive = { evidenceId: "E4", role: "INTERPRETIVE_PRECEDENT" as const, rationale: "" };
    const factual = { evidenceId: "E6", role: "FACTUALLY_SIMILAR_PRECEDENT" as const, rationale: "" };
    const eA = ev({ id: "E4", passage: "x", relevance: 0.9 });
    const eB = ev({ id: "E6", passage: "y", relevance: 0.9 });
    expect(analysisPriority(interpretive, eA)).toBeGreaterThan(analysisPriority(factual, eB));
  });
});

describe("section splitting + party quarantine (§13-§14)", () => {
  const ARM_TEXT = `ԿՈՂՄԵՐԻ ԴԻՐՔՈՐՈՇՈՒՄ
Մեղադրյալը պնդում է, որ իր իրավունքները խախտված են։
ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ իրավունքները չեն խախտվել։`;

  test("splits Armenian sections", () => {
    const sections = splitCourtSections(ARM_TEXT, false);
    expect(sections.map((s) => s.kind)).toEqual(["PARTY_SUBMISSIONS", "COURT_ANALYSIS"]);
    expect(holdingEligibleText(sections)).toContain("չեն խախտվել");
    expect(holdingEligibleText(sections)).not.toContain("պնդում է");
    expect(partySubmissionTexts(sections).join(" ")).toContain("պնդում է");
  });

  test("ECtHR structure splits into FACTS / LAW / ASSESSMENT", () => {
    const text = `THE FACTS
The applicant complained.
THE LAW
The Court recalls the general principle.
THE COURT'S ASSESSMENT
The Court finds a violation.`;
    const sections = splitCourtSections(text, true);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).toContain("FACTS");
    expect(kinds).toContain("COURT_ANALYSIS");
    expect(holdingEligibleText(sections)).toContain("The Court finds a violation");
  });
});

describe("holding verification (§15, §12)", () => {
  const text = "Դատարանը եզրակացրել է, որ կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում յուրաքանչյուր դեպքում։";

  test("ACCEPT on verbatim quote", () => {
    expect(verifyQuote("կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում", text)).toBe("ACCEPT");
  });

  test("WEAK on partial fragment (head/tail)", () => {
    expect(verifyQuote("Դատարանը եզրակացրել է, որ կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում ամենուր ամեն դեպքում", text)).toBe("WEAK");
  });

  test("REJECT on invented quote", () => {
    expect(verifyQuote("Դատարանը պարտադիր կարգով չեղարկել է բոլոր որոշումները անհրաժեշտ ձևով", text)).toBe("REJECT");
  });

  test("REJECT on quote inside party-submission quarantine (§13)", () => {
    const forbidden = new Set(["Մեղադրյալը պնդում է, որ ծանուցումը ուշացել է երկու շաբաթով"]);
    expect(
      verifyQuote("Մեղադրյալը պնդում է, որ ծանուցումը ուշացել է երկու շաբաթով", "Մեղադրյալը պնդում է, որ ծանուցումը ուշացել է երկու շաբաթով", forbidden),
    ).toBe("REJECT");
  });

  test("verifyHolding drops REJECT and lowers confidence", () => {
    const holding: LegalHolding = {
      id: "H1",
      documentId: "E1",
      issue: "test",
      rule: "invented rule text that appears nowhere",
      kind: "DOMESTIC_RULE",
      supportingPassages: [{ evidenceId: "E1", quote: "invented quote appears nowhere in the evidence" }],
      confidence: "HIGH",
      verification: "ACCEPT",
    };
    const out = verifyHolding(holding, new Map([["E1", text]]));
    expect(out.verification).toBe("REJECT");
    expect(out.confidence).toBe("LOW");
  });
});

describe("temporal analysis (§33-§35)", () => {
  test("date parsing: ISO, dotted, Armenian long form", () => {
    expect(parseDate("2023-03-15")).not.toBeNull();
    expect(parseDate("15.03.2023")).toBe(Date.parse("2023-03-15"));
    expect(parseDate("15 մարտի, 2023 թ.")).toBe(Date.parse("2023-03-15"));
    expect(parseDate("չկա")).toBeNull();
  });

  test("historical act -> POTENTIALLY_STALE (§84)", () => {
    const t = analyzeTemporalApplicability(
      ev({ id: "E1", passage: "տեքստ", sourceType: "legislation", statusLabel: "Պատմական խմբագրություն", temporalStatus: "historical" }),
      [],
      und({}),
    );
    expect(t.compatibility).toBe("POTENTIALLY_STALE");
  });

  test("later same-article authority in pack flags the earlier one (§34 evidence-gated)", () => {
    const earlier = ev({ id: "E1", passage: "a", article: "135", date: "01.01.2020", sourceType: "cassation" });
    const later = ev({ id: "E2", passage: "b", article: "135", date: "01.01.2024", sourceType: "cassation" });
    const t = analyzeTemporalApplicability(earlier, [earlier, later], und({}));
    expect(t.compatibility).toBe("POTENTIALLY_STALE");
    expect(t.laterAuthorities).toContain("E2");
  });

  test("unrelated dates do NOT flag (no newer=stronger without evidence)", () => {
    const a = ev({ id: "E1", passage: "a", article: "135", date: "01.01.2020", sourceType: "cassation" });
    const b = ev({ id: "E2", passage: "b", article: "200", date: "01.01.2024", sourceType: "cassation" });
    const t = analyzeTemporalApplicability(a, [a, b], und({}));
    expect(t.compatibility).toBe("COMPATIBLE");
  });
});

describe("hierarchy analysis (§36-§38)", () => {
  test("authority weights are contextual, not numeric-only", () => {
    expect(authorityWeight(ev({ id: "E1", passage: "x", sourceType: "constitutional_court" }))).toBe("BINDING");
    expect(authorityWeight(ev({ id: "E2", passage: "x", sourceType: "legislation" }))).toBe("BINDING");
    expect(authorityWeight(ev({ id: "E3", passage: "x", sourceType: "echr" }))).toBe("HIGHLY_PERSUASIVE");
    expect(authorityWeight(ev({ id: "E4", passage: "x", sourceType: "case_law" }))).toBe("PERSUASIVE");
    expect(authorityWeight(ev({ id: "E5", passage: "x", sourceType: "web" }))).toBe("CONTEXTUAL");
  });

  test("ConCourt assessment carries binding effect wording", () => {
    const a = assessAuthority(ev({ id: "E1", passage: "x", sourceType: "constitutional_court" }));
    expect(a.institution).toContain("Սահմանադրական");
    expect(a.bindingEffect).toBeTruthy();
  });

  test("ECtHR keeps Convention standard separate from domestic rule (§42)", () => {
    const a = assessAuthority(ev({ id: "E1", passage: "x", sourceType: "echr" }));
    expect(a.jurisdiction).toContain("ՄԻԵՎԴ");
    expect(a.legalRole).toContain("Կոնվենցիա");
  });
});

describe("applicability engine (§20-§24)", () => {
  const issue: LegalIssue = {
    id: "I1",
    title: "Կալանքի երկարաձգման կարգը",
    description: "",
    category: "PROCEDURAL",
    relevantFacts: [],
    possibleLegalSources: [],
    status: "OPEN",
  };
  const understanding = und({
    concepts: [],
    exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
  });
  const precedent = ev({
    id: "E1",
    passage: "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս պարտավոր է գնահատել ռիսկը",
    article: "135",
    sourceType: "cassation",
  });

  test("dimension matchers", () => {
    expect(matchLegalIssue(issue, precedent, [])).toBe("STRONG");
    expect(matchRule(understanding, precedent)).toBe("SAME_RULE");
    const userFacts: UserCaseFact[] = [{ id: "UF1", fact: "կալանքը երկարաձգվել է", source: "USER", verified: false, status: "USER_ALLEGED" }];
    const facts: MaterialFact[] = [
      { id: "F1", category: "DETENTION_STATUS", fact: "կալանքը երկարաձգվել է", evidence: [], relevanceToIssue: 0.8 },
    ];
    expect(matchFactualSimilarity(userFacts, facts).similarity).toBe("HIGH");
  });

  test("metadata-only short-circuits (§63)", () => {
    const app = analyzeApplicability(
      issue,
      [],
      ev({ id: "E9", passage: "", fullTextVerified: false }),
      understanding,
      [],
      [],
      "UNKNOWN",
      [],
    );
    expect(app.conclusion).toBe("ANALYSIS_UNAVAILABLE");
    expect(app.metadataOnly).toBe(true);
  });

  test("derivation table (no magic score, §22-§23)", () => {
    const base = {
      proceduralPostureMatch: "UNKNOWN" as const,
      temporalCompatibility: "COMPATIBLE" as const,
      authority: "HIGHLY_PERSUASIVE" as const,
      laterAuthorities: 0,
    };
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "STRONG", ruleMatch: "SAME_RULE", factualSimilarity: "HIGH", majorDistinguishers: 0 }),
    ).toBe("DIRECTLY_RELEVANT");
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "STRONG", ruleMatch: "SAME_RULE", factualSimilarity: "MEDIUM", majorDistinguishers: 0 }),
    ).toBe("RELEVANT_WITH_DISTINCTIONS");
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "STRONG", ruleMatch: "SAME_RULE", factualSimilarity: "HIGH", majorDistinguishers: 1 }),
    ).toBe("RELEVANT_WITH_DISTINCTIONS");
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "PARTIAL", ruleMatch: "RELATED_RULE", factualSimilarity: "LOW", majorDistinguishers: 0 }),
    ).toBe("ANALOGICAL_ONLY");
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "WEAK", ruleMatch: "SAME_RULE", factualSimilarity: "HIGH", majorDistinguishers: 0 }),
    ).toBe("NOT_MATERIALLY_APPLICABLE");
    expect(
      deriveConclusion({ ...base, legalIssueMatch: "PARTIAL", ruleMatch: "DIFFERENT_RULE", factualSimilarity: "UNKNOWN", majorDistinguishers: 0 }),
    ).toBe("NOT_MATERIALLY_APPLICABLE");
  });
});

describe("distinguishing engine (§25-§28)", () => {
  test("polarity clash on NOTICE is MAJOR (§27)", () => {
    const userFacts: UserCaseFact[] = [
      { id: "UF1", fact: "ծանուցումը չի ուղարկվել", source: "USER", verified: false, status: "USER_ALLEGED" },
    ];
    const precedentFacts: MaterialFact[] = [
      {
        id: "F1",
        category: "NOTICE",
        fact: "ծանուցումն ուղարկվել է և հասցեատիրոջը ստացվել է ժամանակին",
        evidence: [{ evidenceId: "E1", quote: "ծանուցումն ուղարկվել է" }],
        relevanceToIssue: 0.9,
      },
    ];
    const { distinguishing, supporting } = findDistinguishingFactors(userFacts, precedentFacts);
    expect(distinguishing.length).toBe(1);
    expect(distinguishing[0].significance).toBe("MAJOR");
    expect(distinguishing[0].dimension.toLowerCase()).toContain("ծանուցում");
    expect(supporting.length).toBe(0);
  });

  test("same polarity becomes a supporting factor (§28)", () => {
    const userFacts: UserCaseFact[] = [
      { id: "UF1", fact: "կալանքը երկարաձգվել է", source: "USER", verified: false, status: "USER_ALLEGED" },
    ];
    const precedentFacts: MaterialFact[] = [
      { id: "F1", category: "DETENTION_STATUS", fact: "կալանքը երկարաձգվել է", evidence: [], relevanceToIssue: 0.9 },
    ];
    const { distinguishing, supporting } = findDistinguishingFactors(userFacts, precedentFacts);
    expect(supporting.length).toBe(1);
    expect(distinguishing.length).toBe(0);
  });
});

describe("conflict analysis (§39-§42)", () => {
  test("holding polarity detection", () => {
    const mk = (rule: string, conclusion?: string): LegalHolding => ({
      id: "H", documentId: "E1", issue: "x", rule, conclusion,
      kind: "DOMESTIC_RULE", supportingPassages: [], confidence: "HIGH", verification: "ACCEPT",
    });
    expect(holdingPolarity(mk("գնահատումը պարտադիր է"))).toBe(1);
    expect(holdingPolarity(mk("գնահատումը պարտադիր չէ"))).toBe(-1);
    expect(holdingPolarity(mk("չեզոք ձևակերպում"))).toBe(0);
  });

  test("different scope (ConCourt vs Cassation) is never DIRECT (§87)", () => {
    const issue: LegalIssue = {
      id: "I1", title: "ծանուցման կարգ", description: "", category: "PROCEDURAL",
      relevantFacts: [], possibleLegalSources: [], status: "OPEN",
    };
    const hA: LegalHolding = {
      id: "HA", documentId: "EA", issue: "ծանուցման կարգ սահմանադրական", rule: "ծանուցումը պարտադիր է",
      kind: "DOMESTIC_RULE", supportingPassages: [], confidence: "HIGH", verification: "ACCEPT",
    };
    const hB: LegalHolding = {
      id: "HB", documentId: "EB", issue: "ծանուցման կարգ դատական", rule: "ծանուցումը պարտադիր չէ",
      conclusion: "մերժված է", kind: "DOMESTIC_RULE", supportingPassages: [], confidence: "HIGH", verification: "ACCEPT",
    };
    const pack = [
      ev({ id: "EA", passage: "x", sourceType: "constitutional_court" }),
      ev({ id: "EB", passage: "y", sourceType: "cassation" }),
    ];
    const conflicts = analyzeConflicts([issue], pack, [hA, hB], []);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].conflictType).toBe("DIFFERENT_SCOPE");
    expect(conflicts[0].conflictType).not.toBe("DIRECT");
  });

  test("no invented conflicts without signals (§40)", () => {
    const issue: LegalIssue = {
      id: "I1", title: "այլ հարց", description: "", category: "SUBSTANTIVE",
      relevantFacts: [], possibleLegalSources: [], status: "OPEN",
    };
    const conflicts = analyzeConflicts([issue], [ev({ id: "E1", passage: "x" })], [], []);
    expect(conflicts.length).toBe(0);
  });
});

describe("argument strength (§47)", () => {
  test("verified primary + direct holding + high similarity -> STRONG", () => {
    const strength = computeStrength({
      applicability: {
        precedentId: "E1", issueId: "I1",
        legalIssueMatch: "STRONG", ruleMatch: "SAME_RULE", factualSimilarity: "HIGH",
        proceduralPostureMatch: "SAME", temporalCompatibility: "COMPATIBLE", authority: "BINDING",
        distinguishingFactors: [], supportingFactors: [], conclusion: "DIRECTLY_RELEVANT",
        evidence: [], metadataOnly: false,
      },
      evidence: ev({ id: "E1", passage: "x", grade: "PRIMARY_VERIFIED", identityVerified: true }),
      holdings: [{
        id: "H1", documentId: "E1", issue: "i", rule: "r",
        kind: "DOMESTIC_RULE", supportingPassages: [{ evidenceId: "E1", quote: "q" }],
        confidence: "HIGH", verification: "ACCEPT",
      }],
      hasCounterAuthority: false,
    });
    expect(strength).toBe("STRONG");
  });

  test("counter-authority and staleness weaken (§47)", () => {
    const strength = computeStrength({
      applicability: {
        precedentId: "E1", issueId: "I1",
        legalIssueMatch: "PARTIAL", ruleMatch: "RELATED_RULE", factualSimilarity: "LOW",
        proceduralPostureMatch: "UNKNOWN", temporalCompatibility: "POTENTIALLY_STALE", authority: "PERSUASIVE",
        distinguishingFactors: [], supportingFactors: [], conclusion: "ANALOGICAL_ONLY",
        evidence: [], metadataOnly: false,
      },
      evidence: ev({ id: "E1", passage: "x", grade: "PRIMARY_METADATA" }),
      holdings: [],
      hasCounterAuthority: true,
    });
    expect(strength).toBe("LIMITED");
  });
});

describe("proposition verification (§50-§54)", () => {
  const evidence = [
    ev({ id: "E1", passage: "Սահմանվում է, որ ծանուցումը ուղարկվում է օրենքով նախատեսված կարգով § 79-ում նկարագրված դեպքերում։" }),
    ev({ id: "E2", passage: "Կալանքի երկարաձգման կարգը սահմանված է հոդված 135-ում։", fullTextVerified: false }),
  ];

  test("fabricated § numbers near citations are removed (§54)", () => {
    const res = verifyPropositions("Դատարանը § 37-ում նշում է կարևոր դրույթ [E1]։", {
      evidence,
      applicability: [],
      holdings: [],
    });
    expect(res.text).not.toContain("§ 37");
    expect(res.paragraphsRemoved).toBe(1);
  });

  test("direct-applicability phrasing softened when research says otherwise (§53)", () => {
    const res = verifyPropositions("Այս նախադեպը անմիջապես կիրառել է պետք այստեղ [E1]։", {
      evidence,
      applicability: [{
        precedentId: "E1", issueId: "I1",
        legalIssueMatch: "PARTIAL", ruleMatch: "RELATED_RULE", factualSimilarity: "LOW",
        proceduralPostureMatch: "UNKNOWN", temporalCompatibility: "UNKNOWN", authority: "PERSUASIVE",
        distinguishingFactors: [], supportingFactors: [], conclusion: "ANALOGICAL_ONLY",
        evidence: [], metadataOnly: false,
      }],
      holdings: [],
    });
    expect(res.softened).toBe(1);
    expect(res.text).toContain("սահմանափակումներով");
  });

  test("holding claims on metadata-only evidence are neutralized (§63)", () => {
    const res = verifyPropositions("Դատարանը եզրակացրել է, որ կալանքը երկարաձգվել է ճիշտ [E2]։", {
      evidence,
      applicability: [],
      holdings: [],
    });
    expect(res.holdingClaimsNeutralized).toBe(1);
    expect(res.text).toContain("չստուգված");
  });
});

describe("structured LLM plumbing (§75-§76)", () => {
  test("extractJson handles fences, prose, nested strings", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Prefix text {"a":"with } brace"} suffix')).toEqual({ a: "with } brace" });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"unterminated": true')).toBeNull();
  });
});

describe("analysis cache (§73-§74)", () => {
  test("set/get roundtrip and version isolation", () => {
    cacheSet("hash-1", "holdings", [{ id: "H1" }]);
    const cached = cacheGet<Array<{ id: string }>>("hash-1", "holdings");
    expect(cached).toEqual([{ id: "H1" }]);
    const wrongKind = cacheGet<Array<{ id: string }>>("hash-1", "facts");
    expect(wrongKind).toBeUndefined();
    const noHash = cacheGet<Array<{ id: string }>>(undefined, "holdings");
    expect(noHash).toBeUndefined();
    expect(cacheStats().version).toBe("4.0.0");
  });
});

describe("fail-closed pipeline (§76, §105)", () => {
  test("null LLM produces deterministic report with ANALYSIS_UNAVAILABLE note", async () => {
    const { runResearchPipeline } = await import("@/lib/legal-research/pipeline");
    const report = await runResearchPipeline(
      {
        query: "Կալանքի երկարաձգում",
        understanding: und({ concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }] }),
        evidence: [
          ev({
            id: "E1",
            passage:
              "ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ\nԴատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս դատարանը պարտավոր է գնահատել փախուստի ռիսկի իրական հիմքերը և կալանքի ժամկետների համաչափությունը յուրաքանչյուր կոնկրետ դեպքում։",
          }),
        ],
        deadline: Date.now() + 2_000,
      },
      { llm: null },
    );
    expect(report.holdings.length).toBe(0);
    expect(report.partial).toBe(true);
    expect(report.notes.some((n) => n.includes("ANALYSIS_UNAVAILABLE"))).toBe(true);
    expect(report.issueMap.issues.length).toBeGreaterThan(0);
    expect(report.stages.length).toBeGreaterThan(0);
  });

  test("invalid LLM JSON fails closed to empty holdings", async () => {
    const { runResearchPipeline } = await import("@/lib/legal-research/pipeline");
    const { mockLlm } = await import("@/lib/legal-research/evaluation/gold-fixtures");
    const bad = mockLlm({ "holding-E1": { wrong: "shape" } });
    const report = await runResearchPipeline(
      {
        query: "Կալանքի երկարաձգում և ռիսկի գնահատում",
        understanding: und({ subquestions: ["Կալանքի երկարաձգման կարգը"] }),
        evidence: [
          ev({
            id: "E1",
            passage:
              "ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ\nԴատարանը եզրակացրել է, որ ռիսկը գնահատվում է ամեն դեպքում և փաստերը հիմնավոր են համարվում բոլոր քննվող գործերի համար առանց բացառության։",
          }),
        ],
        deadline: Date.now() + 2_000,
      },
      { llm: bad },
    );
    expect(report.holdings.length).toBe(0); // schema-invalid -> dropped
  });
});
