// src/lib/legal-research/analysis/temporal-analysis.ts
// Temporal applicability analysis (master prompt §33-§35).
//
// DETERMINISTIC. Considers:
//   date of facts (user date context) / date of precedent / later
//   amendments (status metadata) / later authorities in the pack /
//   ConCourt + ECtHR developments.
//
// §34 — a later decision does NOT automatically invalidate an earlier one:
// "newer = stronger" is FORBIDDEN without evidence. We only flag
// POTENTIALLY_STALE when there is a concrete signal (historical act status,
// or a later authority in the same pack touching the same provision).

import type { LegalEvidence, QueryUnderstanding } from "@/lib/legal-search/types";
import type { TemporalAnalysis, TemporalCompatibility } from "../types";

/** Parse an Armenian/ISO date string to epoch ms (null when unparseable). */
export function parseDate(raw?: string): number | null {
  if (!raw) return null;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return iso;
  // Armenian long form: 15 մարտի, 2021 թ. / 15.03.2021 / 15/03/2021
  const dotted = raw.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (dotted) {
    const [, d, m, y] = dotted;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return Date.parse(`${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
  }
  const armMonths =
    /(\d{1,2})\s*(հունվար|փետրվար|մարտ|ապրիլ|մայիս|հունիս|հուլիս|օգոստոս|սեպտեմբեր|հոկտեմբեր|նոյեմբեր|դեկտեմբեր)[ա-ֆ]*,?\s*(\d{4})/i;
  const arm = raw.match(armMonths);
  if (arm) {
    const months = ["հունվար", "փետրվար", "մարտ", "ապրիլ", "մայիս", "հունիս", "հուլիս", "օգոստոս", "սեպտեմբեր", "հոկտեմբեր", "նոյեմբեր", "դեկտեմբեր"];
    const mi = months.findIndex((mm) => arm[2].startsWith(mm));
    if (mi >= 0) {
      return Date.parse(`${arm[3]}-${String(mi + 1).padStart(2, "0")}-${arm[1].padStart(2, "0")}`);
    }
  }
  return null;
}

/**
 * Analyze temporal compatibility of one precedent within the pack context.
 * `pack` supplies the later-authority scan; `understanding` the user's date
 * context (facts date).
 */
export function analyzeTemporalApplicability(
  evidence: LegalEvidence,
  pack: LegalEvidence[],
  understanding: QueryUnderstanding,
): TemporalAnalysis {
  const notes: string[] = [];
  const laterAuthorities: string[] = [];

  const precedentDate = parseDate(evidence.date);
  const userDate = parseDate(understanding.parsed.date);

  // 1. Later authorities in the same pack touching the same article.
  const article = evidence.article?.replace(/\s+/g, "");
  for (const other of pack) {
    if (other.id === evidence.id) continue;
    const otherDate = parseDate(other.date);
    if (!precedentDate || !otherDate || otherDate <= precedentDate) continue;
    const sameArticle =
      !!article && !!other.article && other.article.replace(/\s+/g, "") === article;
    const sameAct =
      !!evidence.actNumber && evidence.actNumber === other.actNumber;
    if (sameArticle || sameAct) {
      laterAuthorities.push(other.id);
    }
  }

  // 2. Act status metadata (§33 — later amendment).
  const statusLabel = (evidence.statusLabel ?? "").toLowerCase();
  const historicalAct =
    evidence.sourceType === "legislation" &&
    (statusLabel.includes("պատմական") || evidence.temporalStatus === "historical");

  // 3. User's facts predate the precedent — the precedent may postdate the
  //    conduct in question (still citable, but flagged).
  const predatesUserFacts =
    !!userDate && !!precedentDate && precedentDate > userDate + 365 * 24 * 3600 * 1000;

  let compatibility: TemporalCompatibility = "UNKNOWN";
  if (historicalAct) {
    compatibility = "POTENTIALLY_STALE";
    notes.push("Ակտի վերադարձված խմբագրությունն ուժը կորցրած է՝ ստուգեք գործող խմբագրությունը։");
  } else if (laterAuthorities.length > 0) {
    compatibility = "POTENTIALLY_STALE";
    notes.push(
      `Գոյություն ունի ավելի ուշ իրավական ակտ նույն նորմի վերաբերյալ (${laterAuthorities.join(", ")})՝ ստուգեք հետագա պրակտիկան։`,
    );
  } else if (predatesUserFacts) {
    compatibility = "COMPATIBLE";
    notes.push("Նախադեպը ձևավորվել է փաստերից հետո. կիրառելի է որպես իրավական դիրք, բայց ստուգեք նյութական իրավունքի ժամանակային գործողությունը։");
  } else if (precedentDate) {
    compatibility = "COMPATIBLE";
  }

  // §35 — law version linking when identifiable.
  const lawVersion =
    evidence.actNumber && evidence.article
      ? `${evidence.actNumber}, հոդված ${evidence.article}`
      : undefined;

  return {
    evidenceId: evidence.id,
    compatibility,
    lawVersion,
    versionStatus: lawVersion ? "IDENTIFIED" : "TEMPORAL_VERSION_UNKNOWN",
    laterAuthorities,
    notes,
  };
}
