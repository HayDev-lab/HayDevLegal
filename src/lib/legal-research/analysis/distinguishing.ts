// src/lib/legal-research/analysis/distinguishing.ts
// Distinguishing engine (master prompt §25-§28).
//
// findDistinguishingFactors(userFacts, precedentFacts, holding):
// DETERMINISTIC comparison of material-fact dimensions. A difference is a
// candidate distinguishing factor when:
//   - both sides state the same dimension, and
//   - the polarity differs (asserted vs negated — §27: "letter was sent but
//     not collected" vs "no letter was ever sent" is a MAJOR difference), or
//   - the dimension is legally load-bearing (STAGE, PROCEDURAL_BASIS,
//     NOTICE, TIMING) with different content.
// Similar dimensions with matching polarity become SUPPORTING factors (§28).

import type {
  DistinguishingFactor,
  SupportingFactor,
  EvidenceRef,
  MaterialFact,
  UserCaseFact,
  LegalHolding,
} from "../types";
import { isNegativeFact } from "./material-facts";

/** Dimensions whose difference is presumptively MAJOR (§17, §27). */
const MAJOR_DIMENSIONS = new Set([
  "NOTICE",
  "PROCEDURAL_BASIS",
  "STAGE",
  "OBJECT_ORIGIN",
]);

const DIMENSION_LABELS: Record<string, string> = {
  STAGE: "վարույթի փուլ",
  PROCEDURAL_BASIS: "գործողության իրավական հիմք",
  AUTHORITY_ACTION: "գործող մարմին",
  TIMING: "ժամկետներ",
  NOTICE: "ծանուցում",
  PRESENCE: "ներկայություն",
  OBJECT_ORIGIN: "ապացույցի ծագում",
  CHARGE: "մեղադրանք",
  DETENTION_STATUS: "կալանքի վիճակ",
  RISK_ASSESSMENT: "ռիսկի գնահատում",
  OTHER: "այլ հանգամանք",
};

function dimensionLabel(d: string): string {
  return DIMENSION_LABELS[d] ?? d;
}

/**
 * Compare user facts with precedent facts on shared dimensions.
 * Returns [distinguishingFactors, supportingFactors].
 */
export function findDistinguishingFactors(
  userFacts: UserCaseFact[],
  precedentFacts: MaterialFact[],
  _holding?: LegalHolding,
): { distinguishing: DistinguishingFactor[]; supporting: SupportingFactor[] } {
  const distinguishing: DistinguishingFactor[] = [];
  const supporting: SupportingFactor[] = [];

  // Bucket precedent facts by category.
  const byCategory = new Map<string, MaterialFact[]>();
  for (const pf of precedentFacts) {
    const list = byCategory.get(pf.category) ?? [];
    list.push(pf);
    byCategory.set(pf.category, list);
  }

  const seenDims = new Set<string>();

  for (const uf of userFacts) {
    // Match user fact to a precedent dimension by keyword heuristics.
    const dim = matchDimension(uf.fact);
    if (!dim) continue;
    seenDims.add(dim);
    const pfs = byCategory.get(dim) ?? [];

    if (pfs.length === 0) {
      // Precedent silent on a dimension the user asserts — difference noted
      // only for load-bearing dimensions.
      if (MAJOR_DIMENSIONS.has(dim)) {
        distinguishing.push({
          dimension: dimensionLabel(dim),
          userCase: uf.fact,
          precedentCase: "նախադեպում չի հանդիպում",
          whyItMayMatter: `${dimensionLabel(dim)} նախադեպի փաստերում բացակայում է. համեմատությունն այս չափով հնարավոր չէ ստուգել։`,
          evidence: [],
          significance: "MINOR",
        });
      }
      continue;
    }

    const userNegative = isNegativeFact(uf.fact);
    for (const pf of pfs) {
      const precNegative = isNegativeFact(pf.fact);
      if (userNegative !== precNegative) {
        // §27 — polarity clash on the same dimension is the classic
        // distinguisher.
        distinguishing.push({
          dimension: dimensionLabel(dim),
          userCase: uf.fact,
          precedentCase: pf.fact,
          whyItMayMatter: `${dimensionLabel(dim)} չափով դիրքերը տարբերվում են. դա կարող է փոխել իրավական գնահատականը։`,
          evidence: pf.evidence,
          significance: MAJOR_DIMENSIONS.has(dim) ? "MAJOR" : "MODERATE",
        });
      } else {
        supporting.push({
          dimension: dimensionLabel(dim),
          similarity: `${uf.fact} ~ ${pf.fact}`,
          whyItMatters: `${dimensionLabel(dim)} չափով փաստերը համընկնում են։`,
          evidence: pf.evidence,
        });
      }
    }
  }

  // Dimensions asserted only by the precedent (not by the user): MINOR note
  // unless load-bearing.
  for (const [dim, pfs] of byCategory) {
    if (seenDims.has(dim)) continue;
    const pf = pfs[0];
    if (!pf) continue;
    if (MAJOR_DIMENSIONS.has(dim)) {
      distinguishing.push({
        dimension: dimensionLabel(dim),
        userCase: "օգտատիրոջ իրավիճակում անհայտ է",
        precedentCase: pf.fact,
        whyItMayMatter: `Կիրառելիությունը կարող է կախված լինել նրանից, արդյոք ${dimensionLabel(dim)} Ձեր դեպքում նույնն է (§97)։`,
        evidence: pf.evidence,
        significance: "MINOR",
      });
    }
  }

  return { distinguishing, supporting };
}

/** Keyword map from user fact text to a material-fact category. */
const USER_FACT_DIMENSIONS: Array<[RegExp, string]> = [
  [/ծանուց|notify|notice|ծանութ/i, "NOTICE"],
  [/խուզարկ|search|ևրբայն/i, "PROCEDURAL_BASIS"],
  [/կալանք|detention|custod|ձերբակալ/i, "DETENTION_STATUS"],
  [/մեղադրանք|charge|accus/i, "CHARGE"],
  [/վարույթ|proceed|stage|փուլ/i, "STAGE"],
  [/ժամկետ|term|deadline|time|օր անց/i, "TIMING"],
  [/ներկայա|attend|presence|ներկայ/i, "PRESENCE"],
  [/ապացույց|evidence|փաստաթուղթ/i, "OBJECT_ORIGIN"],
  [/ռիսկ|risk|փախուստ|abscond/i, "RISK_ASSESSMENT"],
  [/մարմին|organ|authority|ոստիկան|քննիչ|դատախազ/i, "AUTHORITY_ACTION"],
];

function matchDimension(factText: string): string | null {
  for (const [re, dim] of USER_FACT_DIMENSIONS) {
    if (re.test(factText)) return dim;
  }
  return null;
}
