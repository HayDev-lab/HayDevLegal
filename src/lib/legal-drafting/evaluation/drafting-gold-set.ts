// src/lib/legal-drafting/evaluation/drafting-gold-set.ts
// Phase 6 — §31 — Drafting gold fixtures.
//
// 15 synthetic fixture descriptors, each designed to exercise a specific
// fabrication / firewall failure mode. The evaluator runs each fixture
// through the verification firewalls and computes the gold metrics — all
// hard metrics must be 0 (the firewall must block every fabrication).
//
// CRITICAL — §31: "Hard metrics computed, not invented — all must be 0."

import type {
  DocumentPlan,
  DocumentType,
  DraftSection,
  DraftSectionContent,
  DraftingContext,
  SectionType,
  SourceIdMap,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §31 — Gold metrics shape (re-exported so evaluator.ts can consume it).
// ---------------------------------------------------------------------------

/**
 * §31 — Hard metrics computed by the evaluator. ALL MUST BE 0.
 *
 * Each metric measures the rate at which a particular fabrication LEAKED
 * THROUGH the verification firewall (i.e. was accepted as if verified when
 * it should have been blocked). 0 = perfect firewall; >0 = a fabrication
 * was allowed through.
 */
export interface DraftingGoldMetrics {
  /** Rate of fabricated facts (no source id, or source id not in ctx) that
   *  leaked through. */
  fabricatedFactRate: number;
  /** Rate of fabricated case citations (case number not in sourceIdMap) that
   *  leaked through. */
  fabricatedCaseRate: number;
  /** Rate of fabricated article numbers (article number not in sourceIdMap)
   *  that leaked through. */
  fabricatedArticleRate: number;
  /** Rate of fabricated quotes (quote not verbatim in any cited source) that
   *  leaked through. */
  fabricatedQuoteRate: number;
  /** Rate of evidence refs that pointed at non-existent evidence ids. */
  invalidEvidenceIdRate: number;
  /** Rate of party-claim propositions that were treated as court holdings. */
  partyClaimAsHoldingRate: number;
  /** Rate of metadata-only cases that were used as holdings. */
  metadataOnlyHoldingRate: number;
  /** Rate of strong legal assertions ("law requires X") without authority
   *  support that leaked through. */
  unsupportedStrongLegalAssertionRate: number;
  /** Rate of sections that silently elided material missing information
   *  (no [MISSING_INFORMATION] marker where one was required). */
  hiddenMissingInformationRate: number;
}

/** All hard metrics set to 0 — the baseline the evaluator must reach. */
export const ZERO_GOLD_METRICS: DraftingGoldMetrics = {
  fabricatedFactRate: 0,
  fabricatedCaseRate: 0,
  fabricatedArticleRate: 0,
  fabricatedQuoteRate: 0,
  invalidEvidenceIdRate: 0,
  partyClaimAsHoldingRate: 0,
  metadataOnlyHoldingRate: 0,
  unsupportedStrongLegalAssertionRate: 0,
  hiddenMissingInformationRate: 0,
};

// ---------------------------------------------------------------------------
// §31 — Fixture shape
// ---------------------------------------------------------------------------

export interface DraftingGoldFixture {
  /** Fixture index (1..15). */
  index: number;
  /** Human-readable fixture name (e.g. "fully supported motion"). */
  name: string;
  /** Free-text scenario description (what the fixture exercises). */
  scenario: string;
  /** Document type for the draft. */
  docType: DocumentType;
  /** User-selected goal. */
  goal: string;
  /** Pre-built draft sections (the AI's "drafted" output to be verified). */
  sections: DraftSection[];
  /** Closed DraftingContext (verified case material the AI may cite). */
  ctx: DraftingContext;
  /** SourceIdMap for citation rendering + firewall verification. */
  sourceIdMap: SourceIdMap;
  /** DocumentPlan for the completeness firewall. */
  plan: DocumentPlan;
  /** Expected firewall outcomes (true = pass, false = the firewall should
   *  flag this fixture). */
  expected: {
    factualAssertionsPass: boolean;
    legalAssertionsPass: boolean;
    citationsPass: boolean;
    quotesPass: boolean;
    reliefPass: boolean;
    completenessPass: boolean;
  };
  /** Expected gold metric values for this fixture (all hard metrics should
   *  be 0 — the firewall must block every fabrication). */
  expectedMetrics: DraftingGoldMetrics;
  /** Expected negative-test outcomes (blocked: true means the firewall
   *  correctly blocked the fabrication). */
  expectedNegativeTests: Array<{ name: string; blocked: boolean }>;
}

// ---------------------------------------------------------------------------
// Helpers — minimal builders for fixtures
// ---------------------------------------------------------------------------

function makeSection(
  id: string,
  draftId: string,
  versionId: string,
  sectionType: SectionType,
  title: string,
  content: DraftSectionContent,
  reviewStatus: DraftSection["reviewStatus"] = "AI_DRAFTED",
): DraftSection {
  return {
    id,
    draftId,
    versionId,
    sectionType,
    title,
    content,
    reviewStatus,
    stale: false,
    warnings: [],
    previousContent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeContent(
  text: string,
  sourceIds: string[] = [],
  opts: Partial<DraftSectionContent> = {},
): DraftSectionContent {
  return { text, sourceIds, ...opts };
}

function emptyContext(overrides: Partial<DraftingContext> = {}): DraftingContext {
  return {
    caseId: "case-test",
    parties: [],
    jurisdiction: null,
    court: null,
    caseNumber: null,
    caseTitle: null,
    caseType: null,
    proceedingType: null,
    facts: [],
    chronology: [],
    evidenceRefs: [],
    legalIssues: [],
    legislation: [],
    cassationCases: [],
    conCourtCases: [],
    echrCases: [],
    distinguishing: {},
    counterAuthorities: [],
    argumentMap: [],
    missingMaterialFacts: [],
    totalChars: 0,
    truncated: false,
    ...overrides,
  };
}

function emptyPlan(overrides: Partial<DocumentPlan> = {}): DocumentPlan {
  return {
    draftId: "draft-test",
    documentType: "MOTION",
    goal: "",
    parties: [],
    caseNumber: null,
    court: null,
    jurisdiction: null,
    sections: [],
    materialContradictions: [],
    missingMetadata: [],
    requestedRelief: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §31 — The 15 fixtures
// ---------------------------------------------------------------------------

/**
 * §31 — Synthetic drafting gold fixtures. Each exercises a specific failure
 * mode of the verification firewall. The evaluator runs each fixture
 * through `runAllVerification` and checks:
 *
 *   - For "should pass" fixtures (expected.X = true), the firewall returns
 *     passed=true for that sub-check.
 *   - For "should block" fixtures (expected.X = false), the firewall returns
 *     passed=false for that sub-check (i.e. the fabrication was correctly
 *     blocked).
 *
 * In both cases, the gold metrics are 0 (the firewall either accepts a
 * verified draft, or blocks a fabricated draft — never the reverse).
 */
export const DRAFTING_GOLD_FIXTURES: DraftingGoldFixture[] = [
  // 1. fully supported motion
  {
    index: 1,
    name: "fully supported motion",
    scenario:
      "A motion to release from detention where every fact, every legal authority, every quote, and the requested relief all derive from the verified DraftingContext. Every firewall passes.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s1-1",
        "draft-1",
        "v-1",
        "facts",
        "Facts",
        makeContent(
          "On 15 March 2023 the defendant was detained (F1). The applicant states the detention is unlawful (F2).",
          ["F1", "F2"],
        ),
      ),
      makeSection(
        "s1-2",
        "draft-1",
        "v-1",
        "applicable_law",
        "Applicable Law",
        makeContent(
          "Article 215 of the Criminal Procedure Code requires the court to release the defendant when the detention exceeds the statutory maximum (L1).",
          ["L1"],
        ),
      ),
      makeSection(
        "s1-3",
        "draft-1",
        "v-1",
        "requested_relief",
        "Requested Relief",
        makeContent("The applicant requests release from detention.", [], {
          paragraphs: [
            "To release the defendant from detention immediately.",
            "To apply an alternative preventive measure.",
          ],
        }),
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F1",
          factId: "fact-a",
          proposition: "On 15 March 2023 the defendant was detained.",
          status: "DOCUMENT_VERIFIED",
          materiality: "HIGH",
          category: "DETENTION_STATUS",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
        {
          sourceId: "F2",
          factId: "fact-b",
          proposition: "The applicant states the detention is unlawful.",
          status: "ALLEGED",
          materiality: "MEDIUM",
          category: "PROCEDURAL_BASIS",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
      legislation: [
        {
          sourceId: "L1",
          source: "Criminal Procedure Code RA",
          citation: "Article 215 CrPC RA",
          passages: [
            "Article 215: A detention exceeding the statutory maximum shall be terminated and the detainee released.",
          ],
        },
      ],
    }),
    sourceIdMap: {
      F1: { type: "fact", refId: "fact-a", citation: "Case Fact F1 (detention date)" },
      F2: { type: "fact", refId: "fact-b", citation: "Case Fact F2 ( unlawfulness allegation)" },
      L1: {
        type: "legislation",
        refId: "leg-215",
        citation: "Article 215 CrPC RA",
      },
    },
    plan: emptyPlan({
      documentType: "MOTION",
      goal: "release from detention",
      requestedRelief: "release from detention",
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F1", "F2"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
        {
          sectionType: "applicable_law",
          required: true,
          sourceIds: ["L1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
        {
          sectionType: "requested_relief",
          required: true,
          sourceIds: [],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 2. fact with no evidence
  {
    index: 2,
    name: "fact with no evidence",
    scenario:
      "A draft section asserts an established fact (F9) that does not exist in the DraftingContext. The factual-assertion firewall must reject this fabrication (§16: no source = reject or SUPPORT_REQUIRED).",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s2-1",
        "draft-2",
        "v-2",
        "facts",
        "Facts",
        makeContent(
          "It is established that the defendant was unlawfully detained (F9).",
          ["F9"],
        ),
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F1",
          factId: "fact-a",
          proposition: "Defendant was detained on 15 March 2023.",
          status: "DOCUMENT_VERIFIED",
          materiality: "HIGH",
          category: "DETENTION_STATUS",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
    }),
    sourceIdMap: {
      F1: { type: "fact", refId: "fact-a", citation: "Case Fact F1" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F9"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: false,
      legalAssertionsPass: true,
      citationsPass: false,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "fabricated fact blocked (no source)", blocked: true },
    ],
  },

  // 3. disputed fact
  {
    index: 3,
    name: "disputed fact",
    scenario:
      "A draft section treats a DISPUTED fact (F1) as established. The factual-assertion firewall must reject the §9 status-language mismatch.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s3-1",
        "draft-3",
        "v-3",
        "facts",
        "Facts",
        makeContent(
          "It is established that the defendant was unlawfully detained (F1).",
          ["F1"],
        ),
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F1",
          factId: "fact-disputed",
          proposition: "Defendant was unlawfully detained.",
          status: "DISPUTED",
          materiality: "HIGH",
          category: "PROCEDURAL_BASIS",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
    }),
    sourceIdMap: {
      F1: { type: "fact", refId: "fact-disputed", citation: "Case Fact F1 (disputed)" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: false,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [{ name: "disputed-as-established blocked", blocked: true }],
  },

  // 4. contradicted fact
  {
    index: 4,
    name: "contradicted fact",
    scenario:
      "A draft section treats a CONTRADICTED fact (F1) as established. The factual-assertion firewall must reject the §9 status-language mismatch (CONTRADICTED requires disputed language).",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s4-1",
        "draft-4",
        "v-4",
        "facts",
        "Facts",
        makeContent(
          "It is established that the defendant possessed the disputed object (F1).",
          ["F1"],
        ),
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F1",
          factId: "fact-contradicted",
          proposition: "Defendant possessed the disputed object.",
          status: "CONTRADICTED",
          materiality: "HIGH",
          category: "OBJECT_ORIGIN",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
    }),
    sourceIdMap: {
      F1: { type: "fact", refId: "fact-contradicted", citation: "Case Fact F1 (contradicted)" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: false,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [{ name: "contradicted-as-established blocked", blocked: true }],
  },

  // 5. exact statute
  {
    index: 5,
    name: "exact statute",
    scenario:
      "A draft section quotes an exact verbatim passage from a statute (L1). The quote firewall must accept the quote (it is verbatim in the cited source).",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s5-1",
        "draft-5",
        "v-5",
        "applicable_law",
        "Applicable Law",
        makeContent(
          'Article 215 CrPC RA states: «A detention exceeding the statutory maximum shall be terminated and the detainee released.» (L1)',
          ["L1"],
        ),
      ),
    ],
    ctx: emptyContext({
      legislation: [
        {
          sourceId: "L1",
          source: "Criminal Procedure Code RA",
          citation: "Article 215 CrPC RA",
          passages: [
            "A detention exceeding the statutory maximum shall be terminated and the detainee released.",
          ],
        },
      ],
    }),
    sourceIdMap: {
      L1: { type: "legislation", refId: "leg-215", citation: "Article 215 CrPC RA" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "applicable_law",
          required: true,
          sourceIds: ["L1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 6. applicable Cassation
  {
    index: 6,
    name: "applicable Cassation",
    scenario:
      "A draft section cites an applicable Cassation precedent (C1) — directly relevant to the legal issue. The legal-assertion firewall must accept the citation.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s6-1",
        "draft-6",
        "v-6",
        "precedents",
        "Precedents",
        makeContent(
          "The Cassation Court held that detention beyond the statutory maximum is unlawful (C1).",
          ["C1"],
        ),
      ),
    ],
    ctx: emptyContext({
      cassationCases: [
        {
          sourceId: "C1",
          source: "Cassation Court",
          citation: "Cassation Decision NԱ/1234/2022",
          date: "2022-04-15",
          passages: ["Detention beyond the statutory maximum is unlawful."],
          applicability: "DIRECT",
        },
      ],
    }),
    sourceIdMap: {
      C1: {
        type: "cassation",
        refId: "cassation-1",
        citation: "Cassation Decision NԱ/1234/2022 (15.04.2022)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "precedents",
          required: true,
          sourceIds: ["C1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 7. similar but distinguishable precedent
  {
    index: 7,
    name: "similar but distinguishable precedent",
    scenario:
      "A draft section cites a precedent (C1) that is similar but distinguishable from the user's case. The plan flags this as WITH_DISTINCTIONS. The legal-assertion firewall accepts (the citation is valid) but the review model surfaces a PRECEDENT_WITH_DISTINCTIONS warning.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s7-1",
        "draft-7",
        "v-7",
        "precedents",
        "Precedents",
        makeContent(
          "A similar Cassation decision addressed detention in a customs-offence context; the present case concerns a violent-offence context and the precedent is distinguished (C1).",
          ["C1"],
        ),
      ),
    ],
    ctx: emptyContext({
      cassationCases: [
        {
          sourceId: "C1",
          source: "Cassation Court",
          citation: "Cassation Decision NԱ/5678/2021",
          date: "2021-08-20",
          passages: ["Detention in customs-offence cases is subject to shorter maximum."],
          applicability: "WITH_DISTINCTIONS",
          distinguishingFactors: ["different offence category"],
        },
      ],
      distinguishing: { C1: ["different offence category"] },
    }),
    sourceIdMap: {
      C1: {
        type: "cassation",
        refId: "cassation-2",
        citation: "Cassation Decision NԱ/5678/2021 (20.08.2021)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "precedents",
          required: true,
          sourceIds: ["C1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "PRECEDENT_WITH_DISTINCTIONS",
              detail: "Cassation decision NԱ/5678/2021 is distinguishable.",
              sourceId: "C1",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 8. counter-authority
  {
    index: 8,
    name: "counter-authority",
    scenario:
      "A draft section cites a counter-authority (E1) — an ECtHR decision that goes against the applicant's position. The drafter must disclose it (§20 — serious adverse authority cannot be hidden). The legal-assertion firewall accepts (the citation is valid); the review model surfaces a COUNTER_AUTHORITY warning.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s8-1",
        "draft-8",
        "v-8",
        "counterarguments",
        "Counter-authority",
        makeContent(
          "The ECtHR has held that detention for preventive purposes may be permissible when flight risk is demonstrated (E1).",
          ["E1"],
        ),
      ),
    ],
    ctx: emptyContext({
      echrCases: [
        {
          sourceId: "E1",
          source: "ECtHR",
          citation: "ECtHR, Sahin v. Turkey, App. no. 44774/98",
          date: "2001-11-08",
          passages: ["Detention for preventive purposes may be permissible when flight risk is demonstrated."],
          applicability: "DIRECT",
        },
      ],
      counterAuthorities: ["E1"],
    }),
    sourceIdMap: {
      E1: {
        type: "echr",
        refId: "echr-1",
        citation: "ECtHR, Sahin v. Turkey, App. no. 44774/98 (08.11.2001)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "counterarguments",
          required: true,
          sourceIds: ["E1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "COUNTER_AUTHORITY",
              detail: "E1 is a counter-authority going against the applicant's position.",
              sourceId: "E1",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 9. metadata-only case
  {
    index: 9,
    name: "metadata-only case",
    scenario:
      "A draft section cites a precedent (C2) where the context has only metadata (no passages). The drafter treats it as a holding. The completeness firewall must reject (§22 — no metadata-only case used as holding). The plan flags METADATA_ONLY.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s9-1",
        "draft-9",
        "v-9",
        "precedents",
        "Precedents",
        makeContent(
          "The Cassation Court held that detention beyond the statutory maximum is unlawful (C2).",
          ["C2"],
        ),
        "VERIFIED",
      ),
    ],
    ctx: emptyContext({
      cassationCases: [
        {
          sourceId: "C2",
          source: "Cassation Court",
          citation: "Cassation Decision NԱ/9999/2020",
          date: "2020-03-15",
          passages: [], // metadata-only — no passages
          applicability: "DIRECT",
        },
      ],
    }),
    sourceIdMap: {
      C2: {
        type: "cassation",
        refId: "cassation-3",
        citation: "Cassation Decision NԱ/9999/2020 (15.03.2020)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "precedents",
          required: true,
          sourceIds: ["C2"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "METADATA_ONLY",
              detail: "C2 is metadata-only — no extractable holding.",
              sourceId: "C2",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: false,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "metadata-only as holding blocked", blocked: true },
    ],
  },

  // 10. unverified quote
  {
    index: 10,
    name: "unverified quote",
    scenario:
      "A draft section quotes text that does not appear verbatim in any cited source. The quote firewall must reject (§18 — never create model wording inside quotation marks).",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s10-1",
        "draft-10",
        "v-10",
        "applicable_law",
        "Applicable Law",
        makeContent(
          'Article 215 CrPC RA states: «This is fabricated wording that the AI invented.» (L1)',
          ["L1"],
        ),
      ),
    ],
    ctx: emptyContext({
      legislation: [
        {
          sourceId: "L1",
          source: "Criminal Procedure Code RA",
          citation: "Article 215 CrPC RA",
          passages: [
            "A detention exceeding the statutory maximum shall be terminated and the detainee released.",
          ],
        },
      ],
    }),
    sourceIdMap: {
      L1: { type: "legislation", refId: "leg-215", citation: "Article 215 CrPC RA" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "applicable_law",
          required: true,
          sourceIds: ["L1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: false,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "fabricated quote blocked", blocked: true },
    ],
  },

  // 11. historical / stale-law scenario
  {
    index: 11,
    name: "historical / stale-law scenario",
    scenario:
      "A draft section relies on a Cassation precedent (C3) decided under a now-repealed version of the law. The plan flags STALE_LAW. The review model must surface a STALE_LAW warning; the section cannot be VERIFIED.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s11-1",
        "draft-11",
        "v-11",
        "precedents",
        "Precedents",
        makeContent(
          "A 2010 Cassation decision held that preventive detention requires a higher threshold (C3).",
          ["C3"],
        ),
        "VERIFIED",
      ),
    ],
    ctx: emptyContext({
      cassationCases: [
        {
          sourceId: "C3",
          source: "Cassation Court",
          citation: "Cassation Decision NԱ/111/2010",
          date: "2010-05-12",
          passages: ["Preventive detention requires a higher threshold."],
          applicability: "POTENTIALLY_STALE" as never,
        },
      ],
    }),
    sourceIdMap: {
      C3: {
        type: "cassation",
        refId: "cassation-4",
        citation: "Cassation Decision NԱ/111/2010 (12.05.2010)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "precedents",
          required: true,
          sourceIds: ["C3"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "STALE_LAW",
              detail: "C3 was decided under a now-repealed version of the law.",
              sourceId: "C3",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: false,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "stale-law as current blocked", blocked: true },
    ],
  },

  // 12. missing relief metadata
  {
    index: 12,
    name: "missing relief metadata",
    scenario:
      "The plan flags the requested_relief section as missing required metadata (court, case number). The completeness firewall must reject — missing metadata must be marked [MISSING_INFORMATION], not silently elided.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s12-1",
        "draft-12",
        "v-12",
        "requested_relief",
        "Requested Relief",
        makeContent("The applicant requests release from detention.", [], {
          paragraphs: ["To release the defendant."],
        }),
      ),
    ],
    ctx: emptyContext({}),
    sourceIdMap: {},
    plan: emptyPlan({
      missingMetadata: ["court", "caseNumber"],
      sections: [
        {
          sectionType: "requested_relief",
          required: true,
          sourceIds: [],
          note: "",
          missing: true,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: false,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "missing relief metadata blocked", blocked: true },
    ],
  },

  // 13. party claim mistaken for holding attempt
  {
    index: 13,
    name: "party claim mistaken for holding attempt",
    scenario:
      "A draft section cites a defendant's claim as if it were a court finding. The factual-assertion firewall must reject — party claims cannot be treated as holdings (§16, §12).",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s13-1",
        "draft-13",
        "v-13",
        "facts",
        "Facts",
        makeContent(
          "It is established that the defendant was not at the scene of the alleged offence (F5).",
          ["F5"],
        ),
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F5",
          factId: "fact-party-claim",
          proposition: "Defendant was not at the scene of the alleged offence.",
          status: "ALLEGED",
          materiality: "HIGH",
          category: "PRESENCE",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
    }),
    sourceIdMap: {
      F5: { type: "fact", refId: "fact-party-claim", citation: "Defendant's claim (alleged)" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F5"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "PARTY_CLAIM_AS_HOLDING",
              detail: "F5 is a defendant's claim — cannot be treated as a court finding.",
              sourceId: "F5",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: false,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "party-claim as holding blocked", blocked: true },
    ],
  },

  // 14. ECHR general principle vs case-specific finding
  {
    index: 14,
    name: "ECHR general principle vs case-specific finding",
    scenario:
      "A draft section cites an ECtHR general principle (E2) as if it were a case-specific finding. The drafter must distinguish (§44). The legal-assertion firewall accepts (the citation is valid) but the review model surfaces a GENERAL_VS_CASE_SPECIFIC warning.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s14-1",
        "draft-14",
        "v-14",
        "precedents",
        "Precedents",
        makeContent(
          "The ECtHR requires that detention be subject to judicial review (E2 — general principle).",
          ["E2"],
        ),
      ),
    ],
    ctx: emptyContext({
      echrCases: [
        {
          sourceId: "E2",
          source: "ECtHR",
          citation: "ECtHR, Winterwerp v. Netherlands, App. no. 6301/73",
          date: "1979-06-21",
          passages: ["Detention must be subject to judicial review."],
          applicability: "ANALOGICAL" as never,
        },
      ],
    }),
    sourceIdMap: {
      E2: {
        type: "echr",
        refId: "echr-2",
        citation: "ECtHR, Winterwerp v. Netherlands, App. no. 6301/73 (21.06.1979)",
      },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "precedents",
          required: true,
          sourceIds: ["E2"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [
            {
              type: "GENERAL_VS_CASE_SPECIFIC",
              detail: "E2 is a general principle; the drafter must distinguish from case-specific findings (§44).",
              sourceId: "E2",
            },
          ],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: true,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [],
  },

  // 15. human edit requiring reverification
  {
    index: 15,
    name: "human edit requiring reverification",
    scenario:
      "A draft section has been human-edited (reviewStatus=USER_EDITED). The previous content is preserved (§25). The verification firewalls re-run on the edited content. If the edit removed source ids, the factual-assertion firewall flags it for reverification.",
    docType: "MOTION",
    goal: "release from detention",
    sections: [
      makeSection(
        "s15-1",
        "draft-15",
        "v-15",
        "facts",
        "Facts",
        makeContent(
          "It is established that the defendant was unlawfully detained (the human edit removed the F1 source id).",
          [],
        ),
        "USER_EDITED",
      ),
    ],
    ctx: emptyContext({
      facts: [
        {
          sourceId: "F1",
          factId: "fact-a",
          proposition: "Defendant was unlawfully detained.",
          status: "DOCUMENT_VERIFIED",
          materiality: "HIGH",
          category: "PROCEDURAL_BASIS",
          supportingEvidence: [],
          contradictingEvidence: [],
        },
      ],
    }),
    sourceIdMap: {
      F1: { type: "fact", refId: "fact-a", citation: "Case Fact F1 (DOCUMENT_VERIFIED)" },
    },
    plan: emptyPlan({
      sections: [
        {
          sectionType: "facts",
          required: true,
          sourceIds: ["F1"],
          note: "",
          missing: false,
          needsSupport: false,
          warnings: [],
        },
      ],
    }),
    expected: {
      factualAssertionsPass: false,
      legalAssertionsPass: true,
      citationsPass: true,
      quotesPass: true,
      reliefPass: true,
      completenessPass: true,
    },
    expectedMetrics: { ...ZERO_GOLD_METRICS },
    expectedNegativeTests: [
      { name: "human-edited section re-verified", blocked: true },
    ],
  },
];
