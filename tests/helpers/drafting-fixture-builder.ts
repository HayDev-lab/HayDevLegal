// tests/helpers/drafting-fixture-builder.ts
//
// Phase 6.1 — §4-8, §49 — REAL executable drafting gold fixtures.
//
// Each fixture creates a temporary CaseWorkspace + CaseEntity rows (parties) +
// CaseFact rows + ChronologyEvent rows + LegalIssueLink rows (with relatedLaw
// and relatedPrecedents) holding SYNTHETIC Armenian legal-style content, then
// calls the REAL `buildDraftingContext` service to produce a real bounded
// DraftingContext + SourceIdMap.
//
// Per §6 — NEVER use confidential real case data. All names, case numbers,
// citations and quotes below are SYNTHETIC.
//
// Per §19 — cleanup archives + hard-deletes the case (cascade to all derived
// data). NEVER throws.
//
// Per §8 — the resulting DraftingContext is what the gold test, the export
// test, and the round-trip test consume.

import { randomBytes, randomUUID } from "node:crypto";

import { db } from "@/lib/case-workspace/db";
import {
  archiveCase,
  createCase,
  deleteCase,
} from "@/lib/case-workspace/cases/service";
import { buildDraftingContext } from "@/lib/legal-drafting/planning/drafting-context";
import type {
  DocumentType,
  DraftingContext,
  SourceIdMap,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DraftingFixture {
  /** Owning CaseWorkspace id (so callers can clean up + query). */
  caseId: string;
  /** Synthetic draft id (used by buildDocumentPlan + section ids). */
  draftId: string;
  /** Real bounded DraftingContext built from the persisted case material. */
  ctx: DraftingContext;
  /** SourceIdMap produced alongside ctx (export-time citations). */
  sourceIdMap: SourceIdMap;
  /** User-selected goal (per §11). */
  goal: string;
  /** Document type for the draft (per §5). */
  docType: DocumentType;
  /**
   * §19 archive-first cleanup. NEVER throws — failures are swallowed so the
   * test runner doesn't abort.
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Scenario catalogue (G1-G15, per §7)
// ---------------------------------------------------------------------------

export type GoldScenarioId =
  | "G1"
  | "G2"
  | "G3"
  | "G4"
  | "G5"
  | "G6"
  | "G7"
  | "G8"
  | "G9"
  | "G10"
  | "G11"
  | "G12"
  | "G13"
  | "G14"
  | "G15";

export const GOLD_SCENARIO_IDS: readonly GoldScenarioId[] = [
  "G1", "G2", "G3", "G4", "G5",
  "G6", "G7", "G8", "G9", "G10",
  "G11", "G12", "G13", "G14", "G15",
];

// ---------------------------------------------------------------------------
// Scenario descriptors — what each fixture builds.
//
// Each descriptor lists the synthetic CaseFact rows, ChronologyEvent rows,
// LegalIssueLink rows (with relatedLaw + relatedPrecedents), the goal, and the
// document type for the draft.
//
// All content is SYNTHETIC Armenian legal-style text. No real case data.
// ---------------------------------------------------------------------------

interface FactSpec {
  proposition: string;
  /** VERIFIED | ALLEGED | DISPUTED | CONTRADICTED | UNKNOWN — Phase 5.1 namespace. */
  status: string;
  materiality: "HIGH" | "MEDIUM" | "LOW";
  category: string;
  supportingEvidenceJson: string;
  contradictingEvidenceJson: string;
  reviewStatus?: string;
}

interface ChronologySpec {
  date: string | null;
  originalDateText: string | null;
  dateStatus: "EXACT" | "INFERRED" | "UNKNOWN";
  eventType: string;
  title: string;
  description: string | null;
  participants: string[];
  evidenceRefsJson: string;
  verification: string;
  hasConflict: boolean;
  conflictDetail: string | null;
}

interface RelatedLawSpec {
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
}

interface RelatedPrecedentSpec {
  source: string;
  citation: string;
  url?: string;
  date?: string;
  passages: string[];
  applicability?: string;
}

interface LegalIssueLinkSpec {
  issueStatement: string;
  factIds: string[]; // resolved after facts are persisted (by index).
  factIdIndices: number[];
  relatedLaw: RelatedLawSpec[];
  relatedPrecedents: RelatedPrecedentSpec[];
}

interface ScenarioDef {
  scenarioId: GoldScenarioId;
  caseTitle: string;
  court: string;
  caseNumber: string;
  jurisdiction: string;
  proceedingType: string;
  caseType: string;
  partyNames: string[];
  /** Each party is a CaseEntity with these roles. */
  partyRoles: string[][];
  facts: FactSpec[];
  chronology: ChronologySpec[];
  legalIssues: LegalIssueLinkSpec[];
  goal: string;
  docType: DocumentType;
  /** When true, the fixture deliberately leaves goal/relief empty (G12). */
  missingGoal?: boolean;
}

// ---------------------------------------------------------------------------
// Synthetic Armenian legal-style content per scenario.
//
// Naming convention:
//   - All case numbers start with "Գ" + "/" + digits — synthetic.
//   - All Cassation decision numbers look like "ՎճԻՆԱ/NNNN/YYYY" — synthetic.
//   - All citations are synthetic. NEVER use real ARLIS URLs / real HUDOC
//     application numbers.
// ---------------------------------------------------------------------------

// §11 — Captured case identity used by ALL scenarios. Each scenario picks a
// distinct synthetic case number so cross-scenario leakage is detectable.
const SCENARIO_PREFIX: Record<GoldScenarioId, string> = {
  G1: "ԳԴ-1001/2024",
  G2: "ԳԴ-1002/2024",
  G3: "ԳԴ-1003/2024",
  G4: "ԳԴ-1004/2024",
  G5: "ԳԴ-1005/2024",
  G6: "ԳԴ-1006/2024",
  G7: "ԳԴ-1007/2024",
  G8: "ԳԴ-1008/2024",
  G9: "ԳԴ-1009/2024",
  G10: "ԳԴ-1010/2024",
  G11: "ԳԴ-1011/2024",
  G12: "ԳԴ-1012/2024",
  G13: "ԳԴ-1013/2024",
  G14: "ԳԴ-1014/2024",
  G15: "ԳԴ-1015/2024",
};

// ---------------------------------------------------------------------------
// Verbatim passages used across scenarios. Each is a SYNTHETIC Armenian-style
// statute / holding fragment that the quote firewall can verify verbatim.
// ---------------------------------------------------------------------------

const PASSAGE_CRPC_108 =
  "Անձի ձերբակալությունը չի կարող գերազանցել օրենսդրական առավելագույն ժամկետը, և կալանավորված անձը պետք է ազատ արձակվի անհետաձգելիորեն։";

const PASSAGE_CASSATION_DIRECT =
  "Վճռաբեկ դատարանը հաստատել է, որ օրենսդրական առավելագույն ժամկետը գերազանցող կալանքը ենթակա չէ շարունակման։";

const PASSAGE_CASSATION_DISTINGUISHABLE =
  "Մաքսային իրավախախտումների կատարման դեպքում առավել կարճ կալանքի առավելագույն ժամկետ է սահմանվում։";

const PASSAGE_ECHR_COUNTER =
  "Կանխարգելիչ նպատակով կալանքը կարող է թույլատրելի լինել, երբ ապացուցված է փախուստի վտանգը։";

const PASSAGE_ECHR_GENERAL =
  "Յուրաքանչյուր կալանք պետք է ենթարկվի դատական վերահսկողության ողջամիտ ժամկետում։";

const PASSAGE_ECHR_SPECIFIC =
  "Կոնկրետ գործում դատարանը պետք է գնահատի փախուստի և կրկնության ռիսկերը առանձին։";

// ---------------------------------------------------------------------------
// Scenario definitions (G1-G15)
// ---------------------------------------------------------------------------

function mkEvidenceJson(documentId: string | null, page: number | null, quote: string | null): string {
  const ref: Record<string, unknown> = {};
  if (documentId) ref.documentId = documentId;
  if (page !== null) ref.page = page;
  if (quote) ref.quote = quote;
  return JSON.stringify([ref]);
}

function mkEmptyEvidenceJson(): string {
  return "[]";
}

const SCENARIOS: Record<GoldScenarioId, ScenarioDef> = {
  // -----------------------------------------------------------------------
  // G1 — fully supported motion. Every material fact DOCUMENT_VERIFIED,
  // exact statute L1 with verbatim passage, user-selected goal "release".
  // -----------------------------------------------------------------------
  G1: {
    scenarioId: "G1",
    caseTitle: "Gold G1 — Fully Supported Motion for Release",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G1,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Արամ Պողոսյան", "Պաշտպան Սարգսյան"],
    partyRoles: [["DEFENDANT"], ["LAWYER"]],
    facts: [
      {
        proposition: "Մեղադրյալը ձերբակալվել է 2023թ. մարտի 15-ին։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "DETENTION_STATUS",
        supportingEvidenceJson: mkEvidenceJson("doc-g1-arrest", 1, "ձերբակալություն 2023թ. մարտի 15"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
      {
        proposition: "Կալանքի ժամկետը գերազանցում է քրեական դատավարության օրենսգրքի 108-րդ հոդվածով սահմանված առավելագույնը։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g1-deadline", 1, "գերազանցում է 108-րդ հոդվածի առավելագույնը"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [
      {
        date: "2023-03-15",
        originalDateText: "2023թ. մարտի 15",
        dateStatus: "EXACT",
        eventType: "ARREST",
        title: "Մեղադրյալի ձերբակալություն",
        description: "Ձերբակալություն կատարվել է դատախազի որոշմամբ։",
        participants: ["Մեղադրյալ Արամ Պողոսյան", "Դատախազ Սարգսյան"],
        evidenceRefsJson: mkEvidenceJson("doc-g1-arrest", 1, null),
        verification: "DOCUMENT_VERIFIED",
        hasConflict: false,
        conflictDetail: null,
      },
    ],
    legalIssues: [
      {
        issueStatement:
          "Արդյո՞ք մեղադրյալի կալանքի ժամկետը գերազանցում է քրեական դատավարության օրենսգրքի 108-րդ հոդվածով սահմանված առավելագույնը։",
        factIds: [],
        factIdIndices: [0, 1],
        relatedLaw: [
          {
            source: "ARLIS",
            citation: "ՀՀ Քրեական դատավարության օրենսգիրք, հոդված 108",
            date: "2022-01-01",
            passages: [PASSAGE_CRPC_108],
            applicability: "DIRECT",
          },
        ],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G2 — fact with NO supporting evidence (supportingEvidence=[]). The
  // planner flags needsSupport; the firewall requires [SUPPORT_REQUIRED] or
  // NEEDS_SUPPORT review status.
  //
  // The fact is ALLEGED with reviewStatus=USER_CONFIRMED so that
  // buildDraftingContext's loadFacts includes it (loadFacts only loads
  // VERIFIED/DISPUTED + ALLEGED+USER_CONFIRMED). The supportingEvidence=[]
  // is preserved (no evidence grounding).
  // -----------------------------------------------------------------------
  G2: {
    scenarioId: "G2",
    caseTitle: "Gold G2 — Fact Without Evidence",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G2,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Բագրատ Սաֆարյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը չի կարողացել վճարել գրավը։",
        status: "ALLEGED",
        materiality: "MEDIUM",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEmptyEvidenceJson(),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
        reviewStatus: "USER_CONFIRMED",
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք գրավի վճարումը հնարավի չի եղել օբյեկտիվ պատճառներով։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G3 — disputed fact (one source SUPPORTS, another CONTRADICTS).
  // -----------------------------------------------------------------------
  G3: {
    scenarioId: "G3",
    caseTitle: "Gold G3 — Disputed Fact",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G3,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Գագիկ Ավետիսյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը գտնվել է դեպքի վայրում։",
        status: "DISPUTED",
        materiality: "HIGH",
        category: "PRESENCE",
        supportingEvidenceJson: mkEvidenceJson("doc-g3-witness", 1, "ըստ վկայի՝ մեղադրյալը գտնվել է վայրում"),
        contradictingEvidenceJson: mkEvidenceJson("doc-g3-alibi", 1, "ըստ ալիբիի՝ մեղադրյալը գտնվել է այլ վայրում"),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք մեղադրյալը գտնվել է դեպքի վայրում։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G4 — contradicted fact (only contradictingEvidence, no supporting).
  //
  // Note: buildDraftingContext.loadFacts only loads VERIFIED/DISPUTED +
  // ALLEGED+USER_CONFIRMED facts. CONTRADICTED facts aren't loaded by
  // default. We use DISPUTED status here (which the firewall treats the
  // same as CONTRADICTED — both need disputed language per §9). The
  // contradictingEvidence is preserved.
  // -----------------------------------------------------------------------
  G4: {
    scenarioId: "G4",
    caseTitle: "Gold G4 — Contradicted Fact",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G4,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Դավիթ Մնացականյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալի մոտ հայտնաբերված առարկան պատկանում է վնասվող կողմին։",
        status: "DISPUTED",
        materiality: "HIGH",
        category: "OBJECT_ORIGIN",
        supportingEvidenceJson: mkEmptyEvidenceJson(),
        contradictingEvidenceJson: mkEvidenceJson("doc-g4-receipt", 1, "ըստ անդորրագրի՝ առարկան գնվել է այլ անձի կողմից"),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք առարկայի ծագումը հաստատվում է ապացույցներով։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G5 — exact statute citation with verbatim passage.
  // -----------------------------------------------------------------------
  G5: {
    scenarioId: "G5",
    caseTitle: "Gold G5 — Exact Statute Citation",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G5,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Եղիշե Առուստամյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Կալանքի ժամկետը գերազանցում է 108-րդ հոդվածի առավելագույնը։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g5-deadline", 1, "գերազանցում է 108-րդ հոդվածը"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք կալանքը համապատասխանում է քրեական դատավարության օրենսգրքի 108-րդ հոդվածին։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [
          {
            source: "ARLIS",
            citation: "ՀՀ Քրեական դատավարության օրենսգիրք, հոդված 108",
            date: "2022-01-01",
            passages: [PASSAGE_CRPC_108],
            applicability: "DIRECT",
          },
        ],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G6 — applicable Cassation precedent with verified holding (DIRECT).
  // -----------------------------------------------------------------------
  G6: {
    scenarioId: "G6",
    caseTitle: "Gold G6 — Applicable Cassation Precedent",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G6,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Զավեն Բարսեղյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Կալանքը գերազանցում է օրենսդրական առավելագույնը։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g6-deadline", 1, "գերազանցում է առավելագույնը"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք Վճռաբեկ դատարանի նախադեպը կիրառելի է տվյալ գործում։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "Cassation datalex",
            citation: "ՎճԻՆԱ/2233/2022",
            date: "2022-04-15",
            passages: [PASSAGE_CASSATION_DIRECT],
            applicability: "DIRECT",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G7 — similar but distinguishable precedent (WITH_DISTINCTIONS).
  // -----------------------------------------------------------------------
  G7: {
    scenarioId: "G7",
    caseTitle: "Gold G7 — Distinguishable Cassation Precedent",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G7,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Տիգրան Ղազարյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Գործը վերաբերում է մաքսային իրավախախտման հանգամածքին։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g7-customs", 1, "մաքսային իրավախախտում"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք մաքսային գործերի վերաբերյալ Վճռաբեկ դատարանի նախադեպը տարբենակից է։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "Cassation datalex",
            citation: "ՎճԻՆԱ/5678/2021",
            date: "2021-08-20",
            passages: [PASSAGE_CASSATION_DISTINGUISHABLE],
            applicability: "WITH_DISTINCTIONS",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G8 — counter-authority (ECHR precedent going against applicant).
  // -----------------------------------------------------------------------
  G8: {
    scenarioId: "G8",
    caseTitle: "Gold G8 — Counter-Authority (ECHR)",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G8,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Լևոն Կիրակոսյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Կալանքը կիրառվել է կանխարգելիչ նպատակով։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g8-preventive", 1, "կանխարգելիչ կալանք"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք կանխարգելիչ կալանքը հակասում է ՄԻԵԴ նախադեպին։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "HUDOC",
            citation: "ՄԻԵՎ, Սահինն ընդդեմ Թուրքիայի, հայց թիվ 44774/98",
            date: "2001-11-08",
            passages: [PASSAGE_ECHR_COUNTER],
            applicability: "DIRECT",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G9 — metadata-only case (precedent with NO passages).
  // -----------------------------------------------------------------------
  G9: {
    scenarioId: "G9",
    caseTitle: "Gold G9 — Metadata-Only Cassation Case",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G9,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Մհեր Ավագյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը պնդում է, որ կալանքը ապօրինի է։",
        status: "ALLEGED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEmptyEvidenceJson(),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք գոյություն ունի Վճռաբեկ դատարանի կիրառելի նախադեպ։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "Cassation datalex",
            citation: "ՎճԻՆԱ/9999/2020",
            date: "2020-03-15",
            passages: [], // metadata-only — no extractable holding.
            applicability: "DIRECT",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G10 — unverified quote (quote text not in any cited passage).
  // The firewall §18 must reject.
  // -----------------------------------------------------------------------
  G10: {
    scenarioId: "G10",
    caseTitle: "Gold G10 — Unverified Quote",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G10,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Նարեկ Հովսեփյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք քրեական դատավարության օրենսգրքի 108-րդ հոդվածը թույլ է տալիս կալանքի երկարաձգում։",
        factIds: [],
        factIdIndices: [],
        relatedLaw: [
          {
            source: "ARLIS",
            citation: "ՀՀ Քրեական դատավարության օրենսգիրք, հոդված 108",
            date: "2022-01-01",
            passages: [PASSAGE_CRPC_108],
            applicability: "DIRECT",
          },
        ],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G11 — historical / stale-law version (legislation with old date).
  // The §22 firewall doesn't directly catch stale law; the review model
  // surfaces a STALE_LAW warning. We persist the precedent with a 2010 date.
  // -----------------------------------------------------------------------
  G11: {
    scenarioId: "G11",
    caseTitle: "Gold G11 — Historical / Stale Law",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G11,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Շուշան Ադամյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Կալանքը կիրառվել է 2010 թվականի դատական պրակտիկայի հիման վրա։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g11-practice", 1, "2010 թվականի դատական պրակտիկա"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք 2010 թվականի նախադեպը կիրառելի է ներկայիս իրավակարգավորման պայմաններում։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "Cassation datalex",
            citation: "ՎճԻՆԱ/111/2010",
            date: "2010-05-12",
            passages: ["2010 թվականին կանխարգելիչ կալանքի համար պահանջվում էր ավելի բարձր շեմ։"],
            applicability: "POTENTIALLY_STALE",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G12 — missing remedy metadata (no goal + no requestedRelief).
  // The §21 firewall + §22 completeness flag.
  // -----------------------------------------------------------------------
  G12: {
    scenarioId: "G12",
    caseTitle: "Gold G12 — Missing Relief Metadata",
    court: "", // intentionally empty — missing court metadata
    caseNumber: "", // intentionally empty — missing case number
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Աշոտ Նալբանդյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը ձերբակալվել է 2023թ. մարտի 15-ին։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "DETENTION_STATUS",
        supportingEvidenceJson: mkEvidenceJson("doc-g12-arrest", 1, "ձերբակալություն 2023թ. մարտի 15"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք կալանքը հիմնավորված է։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [],
      },
    ],
    goal: "", // intentionally empty — missing goal
    docType: "MOTION",
    missingGoal: true,
  },

  // -----------------------------------------------------------------------
  // G13 — party claim mistaken for court holding.
  // Fact category=PRESENCE + status=ALLEGED — the §16 firewall must reject
  // "established" language.
  //
  // The fact is ALLEGED with reviewStatus=USER_CONFIRMED so loadFacts
  // includes it.
  // -----------------------------------------------------------------------
  G13: {
    scenarioId: "G13",
    caseTitle: "Gold G13 — Party Claim ≠ Court Holding",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G13,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Պարույր Մարգարյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը պնդում է, որ գտնվել է այլ վայրում դեպքի պահին (ալիբի)։",
        status: "ALLEGED",
        materiality: "HIGH",
        category: "PRESENCE",
        supportingEvidenceJson: mkEmptyEvidenceJson(),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
        reviewStatus: "USER_CONFIRMED",
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք մեղադրյալի ալիբին հաստատվում է ապացույցներով։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G14 — ECHR general principle vs case-specific finding.
  // Two ECHR precedents: one general principle (ANALOGICAL), one specific.
  // -----------------------------------------------------------------------
  G14: {
    scenarioId: "G14",
    caseTitle: "Gold G14 — ECHR General vs Case-Specific",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G14,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Ռուբեն Թադևոսյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Կալանքի դատական վերահսկողությունը տևել է ավելի քան ողջամիտ ժամկետ։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "PROCEDURAL_BASIS",
        supportingEvidenceJson: mkEvidenceJson("doc-g14-review", 1, "դատական վերահսկողություն"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [
      {
        issueStatement: "Արդյո՞ք դատական վերահսկողության ժամկետը հակասում է ՄԻԵԴ սկզբունքներին։",
        factIds: [],
        factIdIndices: [0],
        relatedLaw: [],
        relatedPrecedents: [
          {
            source: "HUDOC",
            citation: "ՄԻԵՎ, Վինտերպն ընդդեմ Նիդերլանդների, հայց թիվ 6301/73",
            date: "1979-06-21",
            passages: [PASSAGE_ECHR_GENERAL],
            applicability: "ANALOGICAL",
          },
          {
            source: "HUDOC",
            citation: "ՄԻԵԴ, Սաֆարովն ընդդեմ Մեծ Բրիտանիայի, հայց թիվ 71123/01",
            date: "2006-07-12",
            passages: [PASSAGE_ECHR_SPECIFIC],
            applicability: "DIRECT",
          },
        ],
      },
    ],
    goal: "release from detention",
    docType: "MOTION",
  },

  // -----------------------------------------------------------------------
  // G15 — human-edited paragraph after verification (USER_EDITED).
  // The §25 review model marks the section NEEDS_REVERIFY/stale.
  // The §16 firewall re-runs; if the edit removed source ids, it fails.
  // -----------------------------------------------------------------------
  G15: {
    scenarioId: "G15",
    caseTitle: "Gold G15 — Human Edit Requiring Reverification",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    caseNumber: SCENARIO_PREFIX.G15,
    jurisdiction: "ՀՀ Քրեական դատարան",
    proceedingType: "Քրեական",
    caseType: "CRIMINAL",
    partyNames: ["Մեղադրյալ Վահան Կարապետյան"],
    partyRoles: [["DEFENDANT"]],
    facts: [
      {
        proposition: "Մեղադրյալը ձերբակալվել է 2023թ. մարտի 15-ին։",
        status: "VERIFIED",
        materiality: "HIGH",
        category: "DETENTION_STATUS",
        supportingEvidenceJson: mkEvidenceJson("doc-g15-arrest", 1, "ձերբակալություն 2023թ. մարտի 15"),
        contradictingEvidenceJson: mkEmptyEvidenceJson(),
      },
    ],
    chronology: [],
    legalIssues: [],
    goal: "release from detention",
    docType: "MOTION",
  },
};

// ---------------------------------------------------------------------------
// Public API — createDraftingFixture
// ---------------------------------------------------------------------------

/**
 * Create a real persisted CaseWorkspace + CaseEntity rows (parties) + CaseFact
 * rows + ChronologyEvent rows + LegalIssueLink rows (with relatedLaw +
 * relatedPrecedents) for the named scenario, then call the REAL
 * `buildDraftingContext` service to produce a real bounded DraftingContext +
 * SourceIdMap.
 *
 * @param scenario  one of "G1".."G15"
 * @returns DraftingFixture — see interface above.
 */
export async function createDraftingFixture(
  scenario: GoldScenarioId,
): Promise<DraftingFixture> {
  const def = SCENARIOS[scenario];
  if (!def) {
    throw new Error(
      `Unknown gold scenario: ${scenario}. Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
  }

  // Random suffix to avoid collisions across multiple test runs.
  const suffix = randomBytes(4).toString("hex");
  const caseTitle = `${def.caseTitle} [${suffix}]`;

  // §11 — Create the case with captured identity (never invented).
  const c = await createCase({
    title: caseTitle,
    caseType: def.caseType as never,
    jurisdiction: def.jurisdiction || undefined,
    court: def.court || undefined,
    proceedingType: def.proceedingType || undefined,
    caseNumber: def.caseNumber || undefined,
  });

  const factIds: string[] = [];

  try {
    // §11 — Persist CaseEntity rows for parties (so buildDraftingContext
    // surfaces them in ctx.parties).
    for (let i = 0; i < def.partyNames.length; i++) {
      await db.caseEntity.create({
        data: {
          caseId: c.id,
          canonicalName: def.partyNames[i],
          aliases: "[]",
          type: i === 0 ? "PERSON" : "LAWYER",
          roles: JSON.stringify(def.partyRoles[i] ?? []),
          evidenceRefs: "[]",
        },
      });
    }

    // §10 — Persist CaseFact rows.
    for (const fact of def.facts) {
      const row = await db.caseFact.create({
        data: {
          caseId: c.id,
          proposition: fact.proposition,
          category: fact.category,
          status: fact.status,
          supportingEvidence: fact.supportingEvidenceJson,
          contradictingEvidence: fact.contradictingEvidenceJson,
          relatedIssues: "[]",
          materiality: fact.materiality,
          source: "USER",
          createdBy: "USER",
          reviewStatus: fact.reviewStatus ?? "UNREVIEWED",
        },
      });
      factIds.push(row.id);
    }

    // §8 — Persist ChronologyEvent rows.
    for (const ev of def.chronology) {
      await db.chronologyEvent.create({
        data: {
          caseId: c.id,
          date: ev.date,
          originalDateText: ev.originalDateText,
          dateStatus: ev.dateStatus,
          eventType: ev.eventType,
          title: ev.title,
          description: ev.description,
          participants: JSON.stringify(ev.participants),
          evidenceRefs: ev.evidenceRefsJson,
          verification: ev.verification,
          hasConflict: ev.hasConflict,
          conflictDetail: ev.conflictDetail,
          reviewStatus: "UNREVIEWED",
        },
      });
    }

    // §13 — Persist LegalIssueLink rows (resolve factIds by index).
    for (const issue of def.legalIssues) {
      const linkedFactIds = issue.factIdIndices.map((idx) => factIds[idx] ?? "");
      await db.legalIssueLink.create({
        data: {
          caseId: c.id,
          issueId: `issue-${randomUUID().slice(0, 8)}`,
          issueStatement: issue.issueStatement,
          factIds: JSON.stringify(linkedFactIds),
          evidenceRefs: "[]",
          relatedLaw: JSON.stringify(issue.relatedLaw),
          relatedPrecedents: JSON.stringify(issue.relatedPrecedents),
        },
      });
    }
  } catch (err) {
    // Clean up the partially-created case before re-throwing.
    await safeCleanup(c.id);
    throw err;
  }

  // §8 — Build the real bounded DraftingContext + SourceIdMap.
  const { context: ctx, sourceIdMap } = await buildDraftingContext(c.id, {});

  const draftId = `draft-${scenario}-${randomUUID().slice(0, 8)}`;

  return {
    caseId: c.id,
    draftId,
    ctx,
    sourceIdMap,
    goal: def.goal,
    docType: def.docType,
    cleanup: () => safeCleanup(c.id),
  };
}

// ---------------------------------------------------------------------------
// Helper — persist LegalDraft + DraftVersion + DraftSection rows (for export
// + round-trip tests). The export pipeline reads from the DB; this helper
// writes the assembled sections to the DB so `exportDraft(draftId,
// versionId, format)` can read them.
// ---------------------------------------------------------------------------

export interface PersistedDraftHandle {
  caseId: string;
  draftId: string;
  versionId: string;
  /** The sections that were persisted (so tests can compare to export output). */
  sections: import("@/lib/legal-drafting/types").DraftSection[];
  /** The sourceIdMap persisted on the version (for citation rendering). */
  sourceIdMap: SourceIdMap;
  /** Cleanup function (archives + deletes the case). */
  cleanup: () => Promise<void>;
}

export async function persistDraftSections(
  fixture: DraftingFixture,
  sections: import("@/lib/legal-drafting/types").DraftSection[],
  verificationStatus: "VERIFIED" | "PARTIAL" | "NEEDS_REVIEW" | "UNVERIFIED" = "VERIFIED",
  title?: string,
): Promise<PersistedDraftHandle> {
  const draftRow = await db.legalDraft.create({
    data: {
      caseId: fixture.caseId,
      documentType: fixture.docType,
      title: title ?? `Draft ${fixture.draftId}`,
      status: verificationStatus === "VERIFIED" ? "EXPORT_READY" : "NEEDS_REVIEW",
      language: "hy",
      targetCourtOrAuthority: fixture.ctx.court,
      proceduralStage: fixture.ctx.proceedingType,
      goal: fixture.goal,
      requestedRelief: fixture.goal,
      contextSummary: JSON.stringify({ factCount: fixture.ctx.facts.length }),
      plan: "{}",
      parties: JSON.stringify(fixture.ctx.parties),
      jurisdiction: fixture.ctx.jurisdiction,
      caseNumber: fixture.ctx.caseNumber,
    },
  });

  const versionRow = await db.draftVersion.create({
    data: {
      draftId: draftRow.id,
      version: 1,
      content: JSON.stringify(sections),
      createdBy: "SYSTEM",
      verificationStatus,
      sourceIdMap: JSON.stringify(fixture.sourceIdMap),
    },
  });

  for (const section of sections) {
    await db.draftSection.create({
      data: {
        draftId: draftRow.id,
        versionId: versionRow.id,
        sectionType: section.sectionType,
        title: section.title,
        content: JSON.stringify(section.content),
        reviewStatus: section.reviewStatus,
        stale: section.stale,
        warnings: JSON.stringify(section.warnings ?? []),
        previousContent: null,
      },
    });
  }

  return {
    caseId: fixture.caseId,
    draftId: draftRow.id,
    versionId: versionRow.id,
    sections,
    sourceIdMap: fixture.sourceIdMap,
    cleanup: fixture.cleanup,
  };
}

// ---------------------------------------------------------------------------
// Internal — §19 archive-first cleanup. NEVER throws.
// ---------------------------------------------------------------------------

async function safeCleanup(caseId: string): Promise<void> {
  try {
    await archiveCase(caseId);
  } catch {
    // fall through
  }
  try {
    await deleteCase(caseId);
  } catch {
    try {
      await db.caseWorkspace.delete({ where: { id: caseId } });
    } catch {
      // give up
    }
  }
}
