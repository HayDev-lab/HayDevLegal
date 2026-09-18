// src/lib/legal-research/analysis/hierarchy-analysis.ts
// Authority / hierarchy analysis for the Armenian context
// (master prompt §36-§38).
//
// DETERMINISTIC. Authority is CONTEXTUAL, never a dumb numeric rating:
// the model distinguishes WHAT a source is and WHAT ROLE it plays for the
// user's issue, and states binding effect only where it is well established.
// No legally contested hierarchy is hardcoded without a source.

import type { LegalEvidence } from "@/lib/legal-search/types";
import type { AuthorityAssessment, AuthorityWeight } from "../types";

interface InstitutionProfile {
  jurisdiction: string;
  institution: string;
  legalRole: string;
  /** Contextual weight for a precedent-applicability question (§23). */
  weight: AuthorityWeight;
  /** Binding effect statement, only when well established (§36). */
  bindingEffect?: string;
}

const CONSTITUTION: InstitutionProfile = {
  jurisdiction: "Հայաստան",
  institution: "Սահմանադրություն",
  legalRole: "Բարձրագույն իրավական ուժ ունեցող հիմնական օրենք",
  weight: "BINDING",
  bindingEffect: "Սահմանադրության նորմերն ունեն բարձրագույն իրավական ուժ. օրենքներն ու այլ իրավական ակտերը պետք է համապատասխանեն դրանց։",
};

const CONCOURT: InstitutionProfile = {
  jurisdiction: "Հայաստան",
  institution: "Սահմանադրական դատարան",
  legalRole: "Սահմանադրական վերահսկողություն. նորմի սահմանադրականության և մեկնաբանության վերջնական դիրք",
  weight: "BINDING",
  bindingEffect: "Սահմանադրական դատարանի որոշումներն ունեն ընդհանուր պարտադիր ուժ և վերջնական են։",
};

const LEGISLATION: InstitutionProfile = {
  jurisdiction: "Հայաստան",
  institution: "Ազգային ժողով (օրենսդրություն)",
  legalRole: "Գործող օրենսդրական կարգավորում",
  weight: "BINDING",
  bindingEffect: "Գործող օրենքի նորմը պարտադիր է կիրառության ոլորտում։",
};

const CASSATION: InstitutionProfile = {
  jurisdiction: "Հայաստան",
  institution: "Վճռաբեկ դատարան",
  legalRole: "Դատական պրակտիկայի միասնականություն ապահովող վերադատավարություն. իրավական դիրքերի ձևավորում",
  weight: "HIGHLY_PERSUASIVE",
};

const LOWER_COURT: InstitutionProfile = {
  jurisdiction: "Հայաստան",
  institution: "Առաջին ատյանի / վերաքննիչ դատարան",
  legalRole: "Կոնկրետ գործի քննություն. փաստական նմանության արժեք",
  weight: "PERSUASIVE",
};

const ECtHR: InstitutionProfile = {
  jurisdiction: "ՄԻԵՎԴ / Խորհուրդ է Եվրոպայի",
  institution: "Մարդու իրավունքների եվրոպական դատարան",
  legalRole: "Կոնվենցիայի չափանիշի մեկնաբանություն. Հայաստանի համար Կոնվենցիայի կիրառման չափանիշ",
  weight: "HIGHLY_PERSUASIVE",
  bindingEffect:
    "Վավերացված Կոնվենցիան և ՄԻԵՎԴ-ի ձևակերպած չափանիշները կիրառվում են Հայաստանում օրենքի մեկնաբանության ժամանակ (հոդված 5-րդ ՀՍԴՀ համաձայն միջազգային պայմանագրերը օրենքից բարձր են)։",
};

const SECONDARY: InstitutionProfile = {
  jurisdiction: "—",
  institution: "Երկրորդային աղբյուր",
  legalRole: "Օժանդակ համատեքստ. իրավական ուժ չունի",
  weight: "CONTEXTUAL",
};

/** §42 — keep domestic rule and Convention standard conceptually separate. */
function isConstitution(e: LegalEvidence): boolean {
  return /սահմանադրություն|constitution/i.test(`${e.title} ${e.actNumber ?? ""}`);
}

export function assessAuthority(e: LegalEvidence): AuthorityAssessment {
  let profile: InstitutionProfile;
  switch (e.sourceType) {
    case "constitutional_court":
      profile = CONCOURT;
      break;
    case "echr":
      profile = ECtHR;
      break;
    case "legislation":
    case "local_laws":
      profile = isConstitution(e) ? CONSTITUTION : LEGISLATION;
      break;
    case "cassation":
    case "case_law":
      profile = /վճռաբեկ|cassation|ՎԴ|ԵԴ/i.test(`${e.court ?? ""} ${e.title}`)
        ? CASSATION
        : LOWER_COURT;
      break;
    default:
      profile = SECONDARY;
  }

  const relevance = relevancePhrase(e, profile);

  return {
    documentId: e.id,
    jurisdiction: profile.jurisdiction,
    institution: profile.institution,
    legalRole: profile.legalRole,
    relevanceToIssue: relevance,
    bindingEffect: profile.bindingEffect,
    evidence: e.passage ? [{ evidenceId: e.id, quote: e.passage.slice(0, 160) }] : undefined,
  };
}

function relevancePhrase(e: LegalEvidence, profile: InstitutionProfile): string {
  switch (profile) {
    case CONCOURT:
      return "Սահմանադրական դատարանի մեկնաբանությունը սահմանում է նորմի բովանդակությունը. անմիջականորեն առնչվում է նորմի կիրառմանը։";
    case ECtHR:
      return "ՄԻԵՎԴ-ի դիրքը որոշում է Կոնվենցիայի նվազագույն չափանիշը. ազգային պրակտիկան գնահատվում է դրա համեմատությամբ։";
    case LEGISLATION:
      return `Գործող կարգավորում. հարցի անմիջական նորմատիվ հիմք${e.article ? ` (հոդված ${e.article})` : ""}։`;
    case CASSATION:
      return "Վճռաբեկ դատարանի իրավական դիրքը կարևոր ուղենիշ է ստորին ատյանների համար։";
    case LOWER_COURT:
      return "Ստորին ատյանի որոշում. հիմնականում փաստական նմանության արժեք ունի։";
    default:
      return "Երկրորդային աղբյուր. համատեքստային արժեք։";
  }
}

/** Authority weight lookup used by the applicability engine (§23, §38). */
export function authorityWeight(e: LegalEvidence): AuthorityWeight {
  switch (e.sourceType) {
    case "constitutional_court":
    case "legislation":
    case "local_laws":
      return "BINDING";
    case "echr":
    case "cassation":
      return "HIGHLY_PERSUASIVE";
    case "case_law":
      return "PERSUASIVE";
    default:
      return "CONTEXTUAL";
  }
}
