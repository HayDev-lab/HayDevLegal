// src/lib/legal-search/engine/temporal-validator.ts
// Temporal / source validation (spec §18).
//
// For law, temporal validity is mandatory:
//  - classify each result as current / historical / unknown;
//  - detect queries that pin a specific date or ask for a historical
//    version, and warn when the retrieved evidence cannot guarantee the
//    applicable version;
//  - when ARLIS metadata (status, effective dates) is present, trust it.

import type { LegalSearchResult, QueryUnderstanding, SearchWarning } from "../types";

const CURRENT_MARKERS = ["գործունակ", "գործում է", "ուժի մեջ է", "գործող"];
const HISTORICAL_MARKERS = ["չի գործունակ", "ուժը կորցրել է", "ուժից զրկված", "չեղյալ է հայտարարված"];

/** Refine temporalStatus of a result from its own status/date metadata. */
export function validateTemporal(r: LegalSearchResult): LegalSearchResult {
  const statusText = `${r.status ?? ""} ${r.temporalStatus === "current" ? "current" : ""}`.toLowerCase();

  if (HISTORICAL_MARKERS.some((m) => statusText.includes(m))) {
    r.temporalStatus = "historical";
    return r;
  }
  if (CURRENT_MARKERS.some((m) => statusText.includes(m))) {
    r.temporalStatus = "current";
    return r;
  }
  if (r.sourceId === "arlis" && r.status) {
    // ARLIS labels everything; unlabeled is unusual — keep unknown.
    r.temporalStatus = r.temporalStatus === "unknown" ? "unknown" : r.temporalStatus;
  }
  return r;
}

/** Build user-facing temporal warnings for a set of results. */
export function temporalWarnings(
  u: QueryUnderstanding,
  results: LegalSearchResult[],
): SearchWarning[] {
  const warnings: SearchWarning[] = [];
  const p = u.parsed;

  const hasDate = !!p.date;
  const wantsHistorical = p.wantsHistoricalLaw;
  const anyCurrentOnly = results.some((r) => r.sourceId === "arlis" && r.temporalStatus === "current");

  if (wantsHistorical && anyCurrentOnly) {
    warnings.push({
      kind: "temporal",
      message:
        "Դուք հարցրել եք նախկին խմբագրության մասին, սակայն առցանց աղբյուրները հիմնականում վերադարձնում են ԳՈՐԾՈՂ խմբագրությունը։ Ստուգեք ակտի փոփոխությունների պատմությունը սկզբնաղբյուրում։",
    });
  } else if (hasDate && anyCurrentOnly) {
    warnings.push({
      kind: "temporal",
      message: `Հարցումը կապված է ${p.date} ամսաթվի հետ, բայց աղբյուրները վերադարձնում են ընթացիկ խմբագրությունը. կիրառելի տարբերակը կարող է տարբեր լինել։`,
    });
  }

  const unknownCount = results.filter((r) => r.sourceType === "legislation" && r.temporalStatus === "unknown").length;
  if (unknownCount > 0 && results.length <= 4) {
    warnings.push({
      kind: "temporal",
      message:
        "Որոշ արդյունքների ժամանակային կարգավիճակը հնարավոր չեղավ հաստատել. ստուգեք գործողությունը սկզբնաղբյուրում։",
    });
  }

  return warnings;
}

/** Label for UI: Գործող / Պատմական խմբագրություն / Անհայտ. */
export function temporalLabel(r: { temporalStatus: string }): string {
  switch (r.temporalStatus) {
    case "current":
      return "Գործող";
    case "historical":
      return "Պատմական խմբագրություն";
    default:
      return "Անհայտ";
  }
}
