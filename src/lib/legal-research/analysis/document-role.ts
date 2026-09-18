// src/lib/legal-research/analysis/document-role.ts
// Document role classification (master prompt §10, §64).
//
// DETERMINISTIC — no LLM. A lexically similar document is NOT automatically
// a governing authority; the role comes from source type, court, and
// court-reasoning markers in the passage.

import type { DocumentRoleAssessment, LegalDocumentRole } from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";

/** Armenian court-reasoning markers — signal an interpretive precedent. */
const INTERPRETIVE_MARKERS = [
  "իրավական դիրք",
  "իրավական միավոր",
  "դատարանը եզրակացրել է",
  "դատարանը հիմնավորել է",
  "գերակա իրավական դիրք",
  "ըստ որում",
  "կիրառելով իրավական դիրքը",
  "միասնական դատական պրակտիկա",
];

/** Armenian markers of party positions — NOT court holdings (§13). */
const PARTY_MARKERS = [
  "մեղադրյալի դիրքորոշում",
  "պաշտպանի դիրքորոշում",
  "կողմերի դիրքորոշում",
  "մեղադրողի կարծիք",
  "davitetvats",
];

export function classifyDocumentRole(e: LegalEvidence): DocumentRoleAssessment {
  const role = computeRole(e);
  return {
    evidenceId: e.id,
    role,
    rationale: rationaleFor(role, e),
  };
}

function courtReasoningScore(e: LegalEvidence): number {
  const text = `${e.title} ${e.passage}`.toLowerCase();
  let hits = 0;
  for (const m of INTERPRETIVE_MARKERS) if (text.includes(m)) hits++;
  const party = PARTY_MARKERS.some((m) => text.includes(m));
  return party ? Math.max(0, hits - 1) : hits;
}

function computeRole(e: LegalEvidence): LegalDocumentRole {
  // Secondary / discovery material.
  if (e.sourceType === "web") return "SECONDARY_CONTEXT";

  // Legislation & curated local corpus — the governing text itself.
  if (e.sourceType === "legislation" || e.sourceType === "local_laws") {
    return "GOVERNING_RULE";
  }

  // Constitutional Court — definitional standards.
  if (e.sourceType === "constitutional_court") return "CONSTITUTIONAL_STANDARD";

  // ECtHR — Convention standards.
  if (e.sourceType === "echr") return "ECHR_STANDARD";

  // Domestic case law: interpretive vs factually similar.
  if (e.sourceType === "case_law" || e.sourceType === "cassation") {
    return courtReasoningScore(e) >= 1 ? "INTERPRETIVE_PRECEDENT" : "FACTUALLY_SIMILAR_PRECEDENT";
  }

  return "SECONDARY_CONTEXT";
}

function rationaleFor(role: LegalDocumentRole, e: LegalEvidence): string {
  switch (role) {
    case "GOVERNING_RULE":
      return `Օրենսդրական ակտի տեքստ է (${e.sourceName})՝ կարգավորող նորմի անմիջական աղբյուր։`;
    case "CONSTITUTIONAL_STANDARD":
      return "Սահմանադրական դատարանի որոշում է՝ սահմանում է սահմանադրական մեկնաբանության չափանիշ։";
    case "ECHR_STANDARD":
      return "ՄԻԵՎԴ-ի որոշում է՝ Կոնվենցիայի չափանիշի մեկնաբանություն։";
    case "INTERPRETIVE_PRECEDENT":
      return "Դատական որոշում է՝ պարունակում է դատարանի իրավական դիրք (մեկնաբանական նախադեպ)։";
    case "FACTUALLY_SIMILAR_PRECEDENT":
      return "Դատական որոշում է՝ հիմնականում փաստային նմանությամբ, առանց հստակ իրավական դիրքի։";
    case "SECONDARY_CONTEXT":
      return "Երկրորդային/օժանդակ նյութ է՝ համատեքստի համար։";
    case "COUNTER_AUTHORITY":
      return "Հակառակ դիրք արտահայտող աղբյուր է։";
    case "PROCEDURAL_HISTORY":
      return "Վարույթի ընթացքի վերաբերյալ նյութ է։";
    case "IRRELEVANT":
      return "Ցածր համապատասխանության պատճառով էական նշանակություն չունի։";
  }
}

/**
 * §64-§65 — role-aware ANALYSIS PRIORITY (retrieval ranking untouched).
 * Which documents deserve the bounded deep-analysis budget first.
 */
export function analysisPriority(a: DocumentRoleAssessment, evidence: LegalEvidence): number {
  const roleWeight: Record<LegalDocumentRole, number> = {
    CONSTITUTIONAL_STANDARD: 60,
    ECHR_STANDARD: 55,
    INTERPRETIVE_PRECEDENT: 50,
    GOVERNING_RULE: 45,
    FACTUALLY_SIMILAR_PRECEDENT: 30,
    COUNTER_AUTHORITY: 30,
    PROCEDURAL_HISTORY: 15,
    SECONDARY_CONTEXT: 10,
    IRRELEVANT: 0,
  };
  // Verified full text is a hard prerequisite for holding extraction (§63);
  // within same role, prefer higher relevance and authority.
  const verifiedBonus = evidence.fullTextVerified ? 25 : 0;
  return roleWeight[a.role] + verifiedBonus + Math.round(evidence.relevance * 15);
}
