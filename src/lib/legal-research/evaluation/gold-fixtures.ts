// src/lib/legal-research/evaluation/gold-fixtures.ts
// Applicability Gold Set fixtures (master prompt §78-§87).
//
// 15 carefully selected scenarios covering all §79 test types. Documents are
// SYNTHETIC but realistic (Armenian court / ECtHR structure). The mock LLM
// scripts structured responses; everything else is deterministic — the gold
// set runs with NO network and NO live model.

import type { LegalEvidence, QueryUnderstanding } from "@/lib/legal-search/types";
import type { LegalQuery } from "@/lib/legal/types";
import type { ResearchReport } from "../types";
import type { StructuredLlm } from "../llm";

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

export function baseQuery(raw = ""): LegalQuery {
  return {
    raw,
    normalized: raw.toLowerCase(),
    keywords: [],
    wantsCurrentLaw: false,
    wantsHistoricalLaw: false,
    questionType: "unknown",
  };
}

export function und(partial: Partial<QueryUnderstanding>): QueryUnderstanding {
  return {
    parsed: baseQuery(),
    concepts: [],
    variants: [],
    hasExactReference: false,
    exactReferences: { articles: [], caseNumbers: [], actTitles: [] },
    ...partial,
  };
}

export function ev(partial: Partial<LegalEvidence> & { id: string; passage: string }): LegalEvidence {
  return {
    source: "test-source",
    sourceName: "Test Source",
    sourceType: "case_law",
    title: "",
    url: "https://example.test/document",
    relevance: 0.8,
    authority: 90,
    temporalStatus: "unknown",
    fullTextVerified: true,
    metadataVerified: true,
    ...partial,
  };
}

/** Mock structured LLM: scripted responses per label, schema-validated. */
export function mockLlm(responses: Record<string, unknown>): StructuredLlm {
  return {
    async analyze(req) {
      const data = responses[req.label];
      if (data === undefined) return null;
      const validated = req.schema.safeParse(data);
      return validated.success ? validated.data : null;
    },
  };
}

export interface GoldFixture {
  id: string;
  /** §79 test type this fixture covers. */
  testType: string;
  query: string;
  understanding: QueryUnderstanding;
  evidence: LegalEvidence[];
  llmResponses: Record<string, unknown>;
  /** Structured-field expectations (§80 — never prose). */
  check: (report: ResearchReport) => void;
  /** Evaluator metadata (§81-§82). */
  targetEvidenceId?: string;
  expectedConclusion?: "DIRECTLY_RELEVANT" | "RELEVANT_WITH_DISTINCTIONS" | "ANALOGICAL_ONLY" | "NOT_MATERIALLY_APPLICABLE" | "ANALYSIS_UNAVAILABLE";
}

// ---------------------------------------------------------------------------
// Shared document fragments
// ---------------------------------------------------------------------------

const CASSATION_ANALYSIS = `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս դատարանը պարտավոր է գնահատել փախուստի ռիսկի իրական հիմքերը և կալանքի ժամկետների համաչափությունը։ Ծանուցումն ուղարկվել է կողմերին օրենքով սահմանված կարգով։`;

const G1_QUERY = "Խուզարկության ընթացքում կալանքի երկարաձգում է տեղի ունեցել և փախուստի ռիսկը գնահատվել է դատարանի կողմից երկարաձգման ժամանակ քննության ընթացքում";

const G1_DECOMP = {
  issues: [
    {
      title: "Կալանքի երկարաձգման կարգը",
      description: "Կալանքի երկարաձգման իրավական կարգի հետազոտություն",
      category: "PROCEDURAL",
      relevantFacts: [],
      possibleLegalSources: ["Քրեական դատավարության օրենսգիրք"],
    },
  ],
  userFacts: [{ fact: "կալանքը երկարաձգվել է դատարանի կողմից" }],
};

// ---------------------------------------------------------------------------
// Fixtures (§79 types 1-10 + §83, §86, §87, §54, §97)
// ---------------------------------------------------------------------------

export const GOLD_FIXTURES: GoldFixture[] = [
  // ---- 1. Direct factual match (§79.1) -------------------------------------
  {
    id: "G1-direct-match",
    testType: "§79.1 direct factual match",
    query: G1_QUERY,
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E1",
        passage: CASSATION_ANALYSIS,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0008/05/23",
        article: "135",
        date: "15.03.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "issue-decomposition": G1_DECOMP,
      "facts-E1": {
        facts: [
          {
            category: "DETENTION_STATUS",
            fact: "կալանքը երկարաձգվել է դատարանի կողմից",
            quoteSpan: "կալանքի երկարաձգման հարցը քննելիս դատարանը պարտավոր է",
          },
        ],
      },
      "holding-E1": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման կարգ",
            rule: "կալանքի երկարաձգումը պահանջում է փախուստի ռիսկի գնահատում",
            conclusion: "ռիսկի գնահատումը պարտադիր է",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս դատարանը պարտավոր է գնահատել փախուստի ռիսկի իրական հիմքերը",
          },
        ],
      },
    },
    targetEvidenceId: "E1",
    expectedConclusion: "DIRECTLY_RELEVANT",
    check: (r) => {
      const app = r.applicability.find((a) => a.precedentId === "E1");
      if (!app) throw new Error("G1: no applicability for E1");
      if (app.conclusion !== "DIRECTLY_RELEVANT") throw new Error(`G1: expected DIRECTLY_RELEVANT, got ${app.conclusion}`);
      if (app.ruleMatch !== "SAME_RULE") throw new Error(`G1: expected SAME_RULE, got ${app.ruleMatch}`);
      if (app.factualSimilarity !== "HIGH") throw new Error(`G1: expected HIGH similarity, got ${app.factualSimilarity}`);
      if (app.legalIssueMatch !== "STRONG") throw new Error(`G1: expected STRONG issue match, got ${app.legalIssueMatch}`);
      if (r.holdings.length !== 1 || r.holdings[0].verification !== "ACCEPT") {
        throw new Error("G1: holding not verified ACCEPT");
      }
    },
  },

  // ---- 2. Same legal issue, different facts (§79.2, §27) --------------------
  {
    id: "G2-same-issue-different-facts",
    testType: "§79.2 same legal issue, different facts",
    query: G1_QUERY,
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E1",
        passage: CASSATION_ANALYSIS,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0008/05/23",
        article: "135",
        date: "15.03.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "issue-decomposition": {
        issues: G1_DECOMP.issues,
        userFacts: [{ fact: "ծանուցումը չի ուղարկվել կալանքի երկարաձգման ժամանակ" }],
      },
      "facts-E1": {
        facts: [
          {
            category: "NOTICE",
            fact: "ծանուցումն ուղարկվել է կողմերին",
            quoteSpan: "Ծանուցումն ուղարկվել է կողմերին օրենքով սահմանված կարգով",
          },
        ],
      },
      "holding-E1": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման կարգ",
            rule: "կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս",
          },
        ],
      },
    },
    targetEvidenceId: "E1",
    expectedConclusion: "RELEVANT_WITH_DISTINCTIONS",
    check: (r) => {
      const app = r.applicability.find((a) => a.precedentId === "E1");
      if (!app) throw new Error("G2: no applicability");
      if (app.conclusion !== "RELEVANT_WITH_DISTINCTIONS") throw new Error(`G2: expected RELEVANT_WITH_DISTINCTIONS, got ${app.conclusion}`);
      const major = app.distinguishingFactors.find((d) => d.significance === "MAJOR");
      if (!major) throw new Error("G2: expected a MAJOR distinguishing factor");
      if (!major.dimension.includes("ծանուցում")) throw new Error(`G2: expected NOTICE dimension, got ${major.dimension}`);
    },
  },

  // ---- 3. Same words, different legal issue (§79.3, §93) -------------------
  {
    id: "G3-same-words-different-issue",
    testType: "§79.3 same words but different legal issue",
    query: G1_QUERY,
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E3",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Քննելով կալանքի տեւողության հետ կապված վեճը՝ դատարանը նշում է, որ բողոքի քննության հերթականությունը կախված է դատարանի աշխատանքի բեռից, և մերժում է վերադաս կարգով բողոքարկումը։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0300/04/22",
        article: "140",
        date: "20.06.2022",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "issue-decomposition": {
        issues: G1_DECOMP.issues,
        userFacts: [{ fact: "մեղադրանքը ներկայացվել է երկու օր անց" }],
      },
      "facts-E3": {
        facts: [
          {
            category: "STAGE",
            fact: "բողոքի քննություն վերադաս կարգով",
            quoteSpan: "մերժում է վերադաս կարգով բողոքարկումը",
          },
        ],
      },
      "holding-E3": {
        holdings: [
          {
            issue: "բողոքի քննության հերթականություն",
            rule: "բողոքի քննության հերթականությունը կախված է դատարանի աշխատանքի բեռից",
            kind: "DOMESTIC_RULE",
            quoteSpan: "բողոքի քննության հերթականությունը կախված է դատարանի աշխատանքի բեռից",
          },
        ],
      },
    },
    targetEvidenceId: "E3",
    expectedConclusion: "NOT_MATERIALLY_APPLICABLE",
    check: (r) => {
      const app = r.applicability.find((a) => a.precedentId === "E3");
      if (!app) throw new Error("G3: no applicability");
      if (app.conclusion !== "NOT_MATERIALLY_APPLICABLE") throw new Error(`G3: expected NOT_MATERIALLY_APPLICABLE, got ${app.conclusion}`);
      if (app.ruleMatch !== "DIFFERENT_RULE") throw new Error(`G3: expected DIFFERENT_RULE, got ${app.ruleMatch}`);
    },
  },

  // ---- 4. Older precedent under amended law (§79.4, §84) --------------------
  {
    id: "G4-temporal-stale",
    testType: "§79.4 older precedent under amended law",
    query: "Քրեական դատավարության օրենսգրքի հոդված 135 կալանքի երկարաձգում",
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: ["Քրեական դատավարության օրենսգիրք"] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E4",
        passage: `Հոդված 135. Կալանքի երկարաձգում։ Կալանքը երկարաձգվում է դատարանի որոշմամբ՝ քրեական դատավարության օրենսգրքի սահմանված կարգով, եթե պաշտպանության նպատակները չեն կարող ապահովվել այլ միջոցներով։`,
        sourceType: "legislation",
        sourceName: "ARLIS",
        article: "135",
        statusLabel: "Պատմական խմբագրություն (ուժը կորցրել է)",
        temporalStatus: "historical",
        date: "01.01.2015",
      }),
    ],
    llmResponses: {},
    targetEvidenceId: "E4",
    check: (r) => {
      const t = r.temporal.find((x) => x.evidenceId === "E4");
      if (!t) throw new Error("G4: no temporal analysis");
      if (t.compatibility !== "POTENTIALLY_STALE") throw new Error(`G4: expected POTENTIALLY_STALE, got ${t.compatibility}`);
    },
  },

  // ---- 5. Later case distinguishing earlier (§79.5, §85) --------------------
  {
    id: "G5-distinguishing-relation",
    testType: "§79.5 later case distinguishing earlier case",
    query: "Կալանքի երկարաձգման ռիսկի գնահատման պրակտիկա",
    understanding: und({ concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E5a",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը, տարբերակելով ՎԴ/0002/02/21 գործով ընդունված մոտեցումը, եզրակացրել է, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր է նաև նոր հանգամանքների դեպքում։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0001/02/24",
        date: "10.01.2024",
        sourceType: "cassation",
      }),
      ev({
        id: "E5b",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր չէ, եթե կալանքը երկարաձգվել է նույն մեղադրանքով։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0002/02/21",
        date: "05.05.2021",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "holding-E5a": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման ռիսկի գնահատում",
            rule: "ռիսկի գնահատումը պարտադիր է նաև նոր հանգամանքների դեպքում",
            kind: "DOMESTIC_RULE",
            quoteSpan: "եզրակացրել է, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր է նաև նոր հանգամանքների դեպքում",
          },
        ],
      },
      "facts-E5a": { facts: [] },
      "facts-E5b": { facts: [] },
      "holding-E5b": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման ռիսկի գնահատում",
            rule: "ռիսկի գնահատումը պարտադիր չէ նույն մեղադրանքի դեպքում",
            conclusion: "պարտադիր չէ",
            kind: "DOMESTIC_RULE",
            quoteSpan: "կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր չէ, եթե կալանքը երկարաձգվել է նույն մեղադրանքով",
          },
        ],
      },
    },
    check: (r) => {
      const rel = r.relations.find((x) => x.fromId === "E5a" && x.toId === "E5b");
      if (!rel) throw new Error("G5: no relation E5a->E5b");
      if (rel.kind !== "DISTINGUISHES") throw new Error(`G5: expected DISTINGUISHES, got ${rel.kind}`);
      const conflict = r.conflicts.find(
        (c) => (c.authorityA === "E5a" && c.authorityB === "E5b") || (c.authorityA === "E5b" && c.authorityB === "E5a"),
      );
      if (!conflict) throw new Error("G5: expected a conflict entry");
      if (conflict.conflictType !== "FACT_DEPENDENT" && conflict.conflictType !== "APPARENT") {
        throw new Error(`G5: expected FACT_DEPENDENT/APPARENT, got ${conflict.conflictType}`);
      }
    },
  },

  // ---- 6. Cassation + ConCourt interaction (§79.6) --------------------------
  {
    id: "G6-cassation-concourt",
    testType: "§79.6 Cassation + Constitutional Court interaction",
    query: "Կալանքի երկարաձգման սահմանադրական չափանիշը",
    understanding: und({ concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E6a",
        passage: `Սահմանադրական դատարանը մեկնաբանել է կալանքի երկարաձգման սահմանադրական չափանիշը՝ նշելով, որ ազատությունից զրկման յուրաքանչյուր երկարաձգում պետք է ունենա օրինական հիմք և դատական վերահսկողություն։`,
        sourceType: "constitutional_court",
        sourceName: "Սահմանադրական դատարան",
        caseNumber: "ՍԴՈ-1842",
        date: "12.12.2022",
      }),
      ev({
        id: "E6b",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը կիրառելով իրավական դիրքը՝ եզրակացրել է, որ կալանքի երկարաձգումը պահանջում է օրինական հիմքի առկայություն։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0011/03/23",
        date: "20.09.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {},
    check: (r) => {
      const roleA = r.roles.find((x) => x.evidenceId === "E6a");
      const roleB = r.roles.find((x) => x.evidenceId === "E6b");
      if (roleA?.role !== "CONSTITUTIONAL_STANDARD") throw new Error(`G6: expected CONSTITUTIONAL_STANDARD, got ${roleA?.role}`);
      if (roleB?.role !== "INTERPRETIVE_PRECEDENT") throw new Error(`G6: expected INTERPRETIVE_PRECEDENT, got ${roleB?.role}`);
      const hA = r.hierarchy.find((h) => h.documentId === "E6a");
      if (!hA?.bindingEffect) throw new Error("G6: ConCourt must carry binding effect");
      if (!hA.institution.includes("Սահմանադրական")) throw new Error("G6: wrong institution");
    },
  },

  // ---- 7. Domestic + ECtHR; principle vs outcome (§79.7, §86) ---------------
  {
    id: "G7-echr-principle-vs-outcome",
    testType: "§79.7 + §86 domestic + ECtHR standard; general principle vs case outcome",
    query: "Article 5 §3 continued detention reasonable time Armenia",
    understanding: und({ concepts: [{ hy: "կալանքի ժամկետ", en: "detention reasonable time", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E7",
        passage: `THE FACTS
The applicant was kept in detention for over three years pending trial.
THE LAW
The Court recalls that the reasonable time requirement under Article 5 § 3 entails a special diligence on the part of the judicial authorities.
THE COURT'S ASSESSMENT
Having examined the charges and the passage of time, the Court finds a violation of Article 5 § 3.`,
        sourceType: "echr",
        sourceName: "HUDOC",
        caseNumber: "11275/07",
        date: "2018-04-10",
      }),
    ],
    llmResponses: {
      "facts-E7": {
        facts: [
          {
            category: "TIMING",
            fact: "detention lasted over three years pending trial",
            quoteSpan: "The applicant was kept in detention for over three years pending trial",
          },
        ],
      },
      "holding-E7": {
        holdings: [
          {
            issue: "reasonable time standard",
            rule: "Article 5 § 3 entails a special diligence on the part of the judicial authorities",
            kind: "GENERAL_PRINCIPLE",
            quoteSpan: "The Court recalls that the reasonable time requirement under Article 5 § 3 entails a special diligence on the part of the judicial authorities",
          },
          {
            issue: "case-specific finding",
            rule: "violation found due to charges and passage of time in this case",
            conclusion: "violation of Article 5 § 3",
            kind: "CASE_SPECIFIC_FINDING",
            quoteSpan: "Having examined the charges and the passage of time, the Court finds a violation of Article 5 § 3",
          },
        ],
      },
    },
    check: (r) => {
      const role = r.roles.find((x) => x.evidenceId === "E7");
      if (role?.role !== "ECHR_STANDARD") throw new Error(`G7: expected ECHR_STANDARD, got ${role?.role}`);
      const kinds = new Set(r.holdings.map((h) => h.kind));
      if (!kinds.has("GENERAL_PRINCIPLE") || !kinds.has("CASE_SPECIFIC_FINDING")) {
        throw new Error("G7: expected both GENERAL_PRINCIPLE and CASE_SPECIFIC_FINDING holdings");
      }
      for (const h of r.holdings) {
        if (h.verification !== "ACCEPT") throw new Error(`G7: holding ${h.id} not verified`);
      }
    },
  },

  // ---- 8. Metadata-only case (§79.8, §63) -----------------------------------
  {
    id: "G8-metadata-only",
    testType: "§79.8 metadata-only case",
    query: "Կալանքի երկարաձգում ՎԴ/0009/05/23 գործով",
    understanding: und({
      exactReferences: { articles: [], caseNumbers: ["ՎԴ/0009/05/23"], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E8",
        passage: "",
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0009/05/23",
        date: "02.02.2023",
        sourceType: "cassation",
        fullTextVerified: false,
        accessState: "CAPTCHA_REQUIRED",
        metadataVerified: true,
      }),
    ],
    llmResponses: {},
    targetEvidenceId: "E8",
    expectedConclusion: "ANALYSIS_UNAVAILABLE",
    check: (r) => {
      const app = r.applicability.find((a) => a.precedentId === "E8");
      if (!app) throw new Error("G8: no applicability");
      if (app.conclusion !== "ANALYSIS_UNAVAILABLE") throw new Error(`G8: expected ANALYSIS_UNAVAILABLE, got ${app.conclusion}`);
      if (!app.metadataOnly) throw new Error("G8: metadataOnly flag missing");
      if (r.holdings.some((h) => h.documentId === "E8")) throw new Error("G8: metadata-only doc produced a holding (§63 violation)");
    },
  },

  // ---- 9. Counter-authority (§79.9, §48) ------------------------------------
  {
    id: "G9-counter-authority",
    testType: "§79.9 counter-authority",
    query: G1_QUERY,
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E9",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը մերժել է կողմի դիմումը՝ նշելով, որ կալանքի երկարաձգումը հիմնավոր չէ միայն նոր փաստերի առկայության դեպքում, իսե նման փաստեր գործում չկան։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0044/01/23",
        article: "135",
        date: "11.11.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "issue-decomposition": G1_DECOMP,
      "facts-E9": { facts: [] },
      "holding-E9": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման հիմքեր",
            rule: "կալանքի երկարաձգումը հիմնավոր չէ առանց նոր փաստերի",
            conclusion: "դիմությունը մերժված է",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը մերժել է կողմի դիմումը՝ նշելով, որ կալանքի երկարաձգումը հիմնավոր չէ միայն նոր փաստերի առկայության դեպքում",
          },
        ],
      },
    },
    check: (r) => {
      const role = r.roles.find((x) => x.evidenceId === "E9");
      if (role?.role !== "COUNTER_AUTHORITY") throw new Error(`G9: expected COUNTER_AUTHORITY, got ${role?.role}`);
      const counter = r.arguments.find((a) => a.side === "COUNTERARGUMENT" && a.authorities.some((au) => au.evidenceId === "E9"));
      if (!counter) throw new Error("G9: expected a COUNTERARGUMENT with E9 authority");
      if (r.completeness.counterAuthoritiesFound < 1) throw new Error("G9: counterAuthoritiesFound must be >= 1");
    },
  },

  // ---- 10. Exact precedent requested by number (§79.10, §92) ----------------
  {
    id: "G10-exact-precedent",
    testType: "§79.10 exact precedent requested by number",
    query: "Արդյոք ՎԴ/0008/05/23 նախադեպը կիրառելի է այս իրավիճակին",
    understanding: und({
      exactReferences: { articles: [], caseNumbers: ["ՎԴ/0008/05/23"], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E10",
        passage: CASSATION_ANALYSIS,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0008/05/23",
        article: "135",
        date: "15.03.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {},
    check: (r) => {
      const issue = r.issueMap.issues.find((i) => i.title.includes("ՎԴ/0008/05/23"));
      if (!issue) throw new Error("G10: expected an issue dedicated to the exact precedent");
    },
  },

  // ---- 11. Party-claim confusion (§83) --------------------------------------
  {
    id: "G11-party-claim",
    testType: "§83 party claim must never become a holding",
    query: "Ծանուցման պատշաճ կարգը դատական պրակտիկայում երկար հետազոտություն ծանուցման վերաբերյալ",
    understanding: und({ concepts: [{ hy: "պատշաճ ծանուցում", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E11",
        passage: `ԿՈՂՄԵՐԻ ԴԻՐՔՈՐՈՇՈՒՄ
Մեղադրյալը պնդում է, որ ծանուցումը ուղարկվել է ուշացումով և խախտել է իր իրավունքները։
ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ ծանուցումը ճիշտ է ձևակերպվել և ուղարկվել է օրենքով սահմանված կարգով։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0077/02/23",
        date: "07.07.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "facts-E11": { facts: [] },
      "holding-E11": {
        holdings: [
          {
            issue: "ծանուցման խախտում",
            rule: "ծանուցումը ուշացումով ուղարկվելը խախտել է մեղադրյալի իրավունքները",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Մեղադրյալը պնդում է, որ ծանուցումը ուղարկվել է ուշացումով և խախտել է իր իրավունքները",
          },
          {
            issue: "ծանուցման պատշաճ կարգ",
            rule: "ծանուցումը ճիշտ է ձևակերպվել և ուղարկվել է օրենքով սահմանված կարգով",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը եզրակացրել է, որ ծանուցումը ճիշտ է ձևակերպվել և ուղարկվել է օրենքով սահմանված կարգով",
          },
        ],
      },
    },
    check: (r) => {
      const hs = r.holdings.filter((h) => h.documentId === "E11");
      if (hs.length !== 1) throw new Error(`G11: expected exactly 1 surviving holding, got ${hs.length}`);
      if (!hs[0].rule.includes("ճիշտ է ձևակերպվել")) throw new Error("G11: the surviving holding must be the court's, not the party's");
      if (hs.some((h) => h.rule.includes("խախտել է իր իրավունքները"))) {
        throw new Error("G11: PARTY CLAIM RECORDED AS HOLDING (§83 violation)");
      }
    },
  },

  // ---- 13. Apparent conflict, never DIRECT (§87) ----------------------------
  {
    id: "G13-apparent-conflict",
    testType: "§87 apparently conflicting authorities",
    query: "Կալանքի երկարաձգման հիմքերի պրակտիկա",
    understanding: und({ concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E13a",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր է ամեն դեպքում՝ անկախ մեղադրանքի ձևակերպումից և վարույթի փուլից։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0201/01/23",
        date: "01.03.2023",
        sourceType: "cassation",
      }),
      ev({
        id: "E13b",
        passage: `ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը մերժել է դիմությունը՝ եզրակացնելով, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր չէ նույն մեղադրանքի դեպքում։`,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0202/01/23",
        date: "01.04.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "facts-E13a": { facts: [] },
      "facts-E13b": { facts: [] },
      "holding-E13a": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման ռիսկի գնահատում",
            rule: "ռիսկի գնահատումը պարտադիր է",
            conclusion: "պարտադիր է",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր է ամեն դեպքում",
          },
        ],
      },
      "holding-E13b": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման ռիսկի գնահատում",
            rule: "ռիսկի գնահատումը պարտադիր չէ",
            conclusion: "պարտադիր չէ",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը մերժել է դիմությունը՝ եզրակացնելով, որ կալանքի երկարաձգման ռիսկի գնահատումը պարտադիր չէ",
          },
        ],
      },
    },
    check: (r) => {
      const conflict = r.conflicts.find(
        (c) => (c.authorityA === "E13a" && c.authorityB === "E13b") || (c.authorityA === "E13b" && c.authorityB === "E13a"),
      );
      if (!conflict) throw new Error("G13: expected an APPARENT conflict");
      if (conflict.conflictType === "DIRECT") throw new Error("G13: DIRECT conflict claimed without explicit statement (§87 violation)");
      if (conflict.conflictType !== "APPARENT") throw new Error(`G13: expected APPARENT, got ${conflict.conflictType}`);
    },
  },

  // ---- 12. ECtHR Article 5 §3 factors (§45) ----------------------------------
  {
    id: "G12-echr-factors",
    testType: "§45 ECtHR factors extracted only when present in evidence",
    query: "Continued detention Article 5 §3 reasonable time risk of absconding special diligence",
    understanding: und({ concepts: [{ hy: "կալանքի ժամկետ", en: "detention reasonable time", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E7b",
        passage: `THE FACTS
The applicant was accused of serious offences and was kept in detention. There existed a risk of absconding given his previous failure to appear. Considerable passage of time elapsed.
THE LAW
The Court recalls that the continued detention cannot be justified without relevant and sufficient reasons.
THE COURT'S ASSESSMENT
Having regard to the gravity of charges and the passage of time, the Court finds no violation of Article 5 § 3.`,
        sourceType: "echr",
        sourceName: "HUDOC",
        caseNumber: "23456/18",
        date: "2020-06-15",
      }),
    ],
    llmResponses: {
      "facts-E7b": {
        facts: [
          {
            category: "RISK_ASSESSMENT",
            fact: "risk of absconding given previous failure to appear",
            quoteSpan: "There existed a risk of absconding given his previous failure to appear",
          },
          {
            category: "TIMING",
            fact: "considerable passage of time elapsed",
            quoteSpan: "Considerable passage of time elapsed",
          },
          {
            category: "CHARGE",
            fact: "accused of serious offences",
            quoteSpan: "The applicant was accused of serious offences",
          },
        ],
      },
      "holding-E7b": {
        holdings: [
          {
            issue: "continued detention justification",
            rule: "continued detention requires relevant and sufficient reasons",
            kind: "GENERAL_PRINCIPLE",
            quoteSpan: "The Court recalls that the continued detention cannot be justified without relevant and sufficient reasons",
          },
        ],
      },
    },
    check: (r) => {
      const facts = r.materialFacts.filter((f) => f.id.startsWith("E7b"));
      const cats = new Set(facts.map((f) => f.category));
      if (!cats.has("RISK_ASSESSMENT") || !cats.has("TIMING") || !cats.has("CHARGE")) {
        throw new Error(`G12: expected §45 factors, got [${[...cats].join(", ")}]`);
      }
      // Every fact must carry a grounded evidence ref (§16).
      for (const f of facts) {
        if (f.evidence.length === 0 || !f.evidence[0].quote) throw new Error("G12: ungrounded material fact");
      }
    },
  },

  // ---- 14. Statute branch: the provision itself governs (§21.2) -------------
  {
    id: "G14-statute-direct",
    testType: "§21.2 same provision — governing rule is directly relevant",
    query: "Քրեական դատավարության օրենսգրքի 135-րդ հոդվածով կալանքի երկարաձգման հարցը",
    understanding: und({
      concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }],
      exactReferences: { articles: ["135"], caseNumbers: [], actTitles: [] },
      hasExactReference: true,
    }),
    evidence: [
      ev({
        id: "E14",
        passage: `Հոդված 135. Կալանքի երկարաձգում։ Կալանքի տևողությունը երկարաձգելիս դատարանը գնահատում է փախուստի, կատարված հանցագործության ծանրության և քննության պայմանների հիմքերը՝ քրեական դատավարության օրենսգրքով սահմանված կարգով։`,
        sourceType: "legislation",
        sourceName: "ARLIS",
        article: "135",
        date: "01.07.2022",
      }),
    ],
    llmResponses: {},
    targetEvidenceId: "E14",
    expectedConclusion: "DIRECTLY_RELEVANT",
    check: (r) => {
      const app = r.applicability.find((a) => a.precedentId === "E14");
      if (!app) throw new Error("G14: no applicability");
      if (app.conclusion !== "DIRECTLY_RELEVANT") throw new Error(`G14: expected DIRECTLY_RELEVANT, got ${app.conclusion}`);
      if (app.ruleMatch !== "SAME_RULE") throw new Error(`G14: expected SAME_RULE, got ${app.ruleMatch}`);
    },
  },

  // ---- 15. Missing material fact (§97-§99) ----------------------------------
  {
    id: "G15-missing-fact",
    testType: "§97-§99 missing material fact -> conditional analysis",
    query: "Կալանքի երկարաձգման հարցում ծանուցման դերը և ռիսկի գնահատման կարգը դատական պրակտիկայում",
    understanding: und({ concepts: [{ hy: "կալանքի երկարաձգում", detectedBy: "lexicon" }] }),
    evidence: [
      ev({
        id: "E15",
        passage: CASSATION_ANALYSIS,
        court: "Վճռաբեկ դատարան",
        caseNumber: "ՎԴ/0008/05/23",
        article: "135",
        date: "15.03.2023",
        sourceType: "cassation",
      }),
    ],
    llmResponses: {
      "issue-decomposition": { issues: G1_DECOMP.issues, userFacts: [] },
      "facts-E15": {
        facts: [
          {
            category: "NOTICE",
            fact: "ծանուցումն ուղարկվել է կողմերին",
            quoteSpan: "Ծանուցումն ուղարկվել է կողմերին օրենքով սահմանված կարգով",
          },
        ],
      },
      "holding-E15": {
        holdings: [
          {
            issue: "կալանքի երկարաձգման կարգ",
            rule: "կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում",
            kind: "DOMESTIC_RULE",
            quoteSpan: "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս",
          },
        ],
      },
    },
    check: (r) => {
      if (r.missingFacts.length === 0) throw new Error("G15: expected missing-fact detection");
      const app = r.applicability.find((a) => a.precedentId === "E15");
      if (!app || app.factualSimilarity !== "UNKNOWN") throw new Error("G15: expected UNKNOWN similarity without user facts");
      const issue = r.issueMap.issues[0];
      if (issue && issue.status !== "UNRESOLVED" && issue.status !== "OPEN") {
        throw new Error(`G15: unresolved issue expected, got ${issue.status}`);
      }
    },
  },
];

// G12 is merged into G7 (both ECtHR holding kinds); G14 (proposition
// verification, §53-§54) is exercised directly in the test file against
// verifyPropositions — it tests the ANSWER layer, not the pipeline.
