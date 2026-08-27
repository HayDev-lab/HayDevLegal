// src/lib/legal/legal-terms.ts
// Curated Armenian legal term dictionary for query autocomplete.
//
// Organized by category so the autocomplete can show category hints.
// Terms cover the most common Armenian legal acts, concepts, and
// procedures a user is likely to search for on ARLIS.

export type LegalTerm = {
  /** The Armenian term shown in the autocomplete dropdown */
  term: string;
  /** Short category label for grouping / display */
  category: LegalTermCategory;
  /** Optional expansion of an abbreviation (shown as a hint) */
  expansion?: string;
};

export type LegalTermCategory =
  | "օրենսգիրք" // code
  | "օրենք" // law
  | "դատական" // judicial
  | "հասկացություն" // concept
  | "ընթացակարգ" // procedure
  | "կազմակերպություն"; // organization

export const LEGAL_TERMS: LegalTerm[] = [
  // ---- Օրենսգրքեր (Codes) ----
  { term: "Քրեական դատավարության օրենսգիրք", category: "օրենսգիրք", expansion: "ՔԴՕ" },
  { term: "Քրեական օրենսգիրք", category: "օրենսգիրք", expansion: "ՔՕ" },
  { term: "Քաղաքացիական օրենսգիրք", category: "օրենսգիրք", expansion: "ՔՔՕ" },
  { term: "Քաղաքացիական դատավարության օրենսգիրք", category: "օրենսգիրք", expansion: "ՔՔԴՕ" },
  { term: "Վարչական դատավարության օրենսգիրք", category: "օրենսգիրք", expansion: "ՎԴՕ" },
  { term: "Աշխատանքային օրենսգիրք", category: "օրենսգիրք", expansion: "ԱՕ" },
  { term: "Ընտանեկան օրենսգիրք", category: "օրենսգիրք", expansion: "ԸՕ" },
  { term: "Հողային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Քաղաքաշինության օրենսգիրք", category: "օրենսգիրք" },
  { term: "Սակագնային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Հարկային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Մաքսային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Բնապահպանական օրենսգիրք", category: "օրենսգիրք" },
  { term: "Ջրային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Անտառային օրենսգիրք", category: "օրենսգիրք" },
  { term: "Քրեական դատավարության օրենսգիրք 108 հոդված", category: "օրենսգիրք" },
  { term: "Քրեական դատավարության օրենսգիրք ձերբակալում", category: "օրենսգիրք" },
  { term: "Քրեական դատավարության օրենսգիրք խափանման միջոց", category: "օրենսգիրք" },

  // ---- Հիմնական օրենքներ (Key laws) ----
  { term: "ՀՀ Սահմանադրություն", category: "օրենք", expansion: "ՍԱ" },
  { term: "Սահմանադրական օրենք «Դատաիրավական բարեփոխումների անցումային ժամանակաշրջանում վճռաբեկ դատարանի գործունեության մասին»", category: "օրենք" },
  { term: "Օրենք «Ապօրինի ծագում ունեցող գույքի բռնագանձման մասին»", category: "օրենք" },
  { term: "Օրենք «Դատախազության մասին»", category: "օրենք" },
  { term: "Օրենք «Փաստաբանության մասին»", category: "օրենք" },
  { term: "Օրենք «Նոտարիատի մասին»", category: "օրենք" },
  { term: "Օրենք «Քաղաքացիական վիճակի ակտերի մասին»", category: "օրենք" },
  { term: "Օրենք «Պետական գրանցման մասին»", category: "օրենք" },
  { term: "Օրենք «Ընտրական օրենսգիրք»", category: "օրենք" },
  { term: "Օրենք «Ազգային ժողովի կանոնակարգ»", category: "օրենք" },
  { term: "Օրենք «Նորմատիվ իրավական ակտերի մասին»", category: "օրենք" },
  { term: "Օրենք «Տեղական ինքնակառավարման մասին»", category: "օրենք" },
  { term: "Օրենք «Ազատությունից զրկելու մասին»", category: "օրենք" },
  { term: "Օրենք «Խաղաղ հավաքների մասին»", category: "օրենք" },
  { term: "Օրենք «Պետական գույքի սեփականաշինության մասին»", category: "օրենք" },

  // ---- Դատական (Judicial) ----
  { term: "Վճռաբեկ դատարանի որոշում", category: "դատական" },
  { term: "Վճռաբեկ դատարան ձերբակալում", category: "դատական" },
  { term: "Վճռաբեկ դատարան կալանք", category: "դատական" },
  { term: "Սահմանադրական դատարանի որոշում", category: "դատական" },
  { term: "Սահմանադրական դատարան", category: "դատական", expansion: "ՍԴ" },
  { term: "Վճռաբեկ դատարան", category: "դատական", expansion: "ՎԴ" },
  { term: "ՄԻԵՎԴ վճիռ", category: "դատական", expansion: "ՄԻԵԴ" },
  { term: "Մարդու իրավունքների եվրոպական դատարան", category: "դատական" },
  { term: "Դատական նախադեպ", category: "դատական" },
  { term: "Դատական պրակտիկա", category: "դատական" },
  { term: "Ատյանի որոշում", category: "դատական" },
  { term: "Վերաքննիչ դատարան", category: "դատական" },
  { term: "Առաջին ատյանի դատարան", category: "դատական" },
  { term: "Ընդհանուր իրավասության դատարան", category: "դատական" },

  // ---- Հասկացություններ (Concepts) ----
  { term: "ձերբակալում", category: "հասկացություն" },
  { term: "ձերբակալման իրավաչափություն", category: "հասկացություն" },
  { term: "խափանման միջոց", category: "հասկացություն" },
  { term: "կալանք", category: "հասկացություն" },
  { term: "կալանքի ընտրություն", category: "հասկացություն" },
  { term: "գրավ", category: "հասկացություն" },
  { term: "ստորագրության դուրս գալու մասին", category: "հասկացություն" },
  { term: "պատիժ", category: "հասկացություն" },
  { term: "քրեական պատասխանատվություն", category: "հասկացություն" },
  { term: "քրեական հետապնդում", category: "հասկացություն" },
  { term: "մեղադրանք", category: "հասկացություն" },
  { term: "մեղադրյալ", category: "հասկացություն" },
  { term: "կասկածյալ", category: "հասկացություն" },
  { term: "տուժող", category: "հասկացություն" },
  { term: "քաղաքացիական հայց", category: "հասկացություն" },
  { term: "գույքի արգելադրում", category: "հասկացություն" },
  { term: "գույքի բռնագանձում", category: "հասկացություն" },
  { term: "վճռաբեկություն", category: "հասկացություն" },
  { term: "վերաքննություն", category: "հասկացություն" },
  { term: "դատարանի իրավասություն", category: "հասկացություն" },
  { term: "բացառիկ իրավասություն", category: "հասկացություն" },
  { term: "համապատասխան դատարան", category: "հասկացություն" },

  // ---- Ընթացակարգ (Procedure) ----
  { term: "քրեական դատավարության կարգ", category: "ընթացակարգ" },
  { term: "դատական քննության կարգ", category: "ընթացակարգ" },
  { term: "նախաքննության կարգ", category: "ընթացակարգ" },
  { term: "հետաքննության կարգ", category: "ընթացակարգ" },
  { term: "ապացույցների գնահատում", category: "ընթացակարգ" },
  { term: "վկայի ցուցմունք", category: "ընթացակարգ" },
  { term: "փորձաքննություն", category: "ընթացակարգ" },
  { term: "պաշտպանի մասնակցություն", category: "ընթացակարգ" },
  { term: "պաշտպանի մասնակցության պարտադիր դեպքեր", category: "ընթացակարգ" },
  { term: "թարգմանչի մասնակցություն", category: "ընթացակարգ" },
  { term: "բողոքարկման կարգ", category: "ընթացակարգ" },
  { term: "վճռաբեկ բողոք", category: "ընթացակարգ" },
  { term: "առաքելության կարգ", category: "ընթացակարգ" },
  { term: "անհապաղ դատական վերահսկողություն", category: "ընթացակարգ" },
  { term: "դատական վերահսկողություն", category: "ընթացակարգ" },

  // ---- Կազմակերպություններ (Organizations) ----
  { term: "ՀՀ Արդարադատության նախարարություն", category: "կազմակերպություն" },
  { term: "ՀՀ դատախազություն", category: "կազմակերպություն" },
  { term: "ՀՀ Քննչական կոմիտե", category: "կազմակերպություն" },
  { term: "ՀՀ Ազգային ժողով", category: "կազմակերպություն" },
  { term: "ՀՀ Կառավարություն", category: "կազմակերպություն" },
  { term: "ՀՀ Նախագահ", category: "կազմակերպություն" },
  { term: "ՀՀ Ոստիկանություն", category: "կազմակերպություն" },
  { term: "ՀՀ Ազգային անվտանգության ծառայություն", category: "կազմակերպություն" },
  { term: "ՀՀ Հարկային ծառայություն", category: "կազմակերպություն" },
  { term: "ՀՀ Մաքսային ծառայություն", category: "կազմակերպություն" },

  // ---- Հապավումներ (Abbreviations users type directly) ----
  { term: "ՔԴՕ", category: "օրենսգիրք", expansion: "Քրեական դատավարության օրենսգիրք" },
  { term: "ՔՕ", category: "օրենսգիրք", expansion: "Քրեական օրենսգիրք" },
  { term: "ՔՔՕ", category: "օրենսգիրք", expansion: "Քաղաքացիական օրենսգիրք" },
  { term: "ՔՔԴՕ", category: "օրենսգիրք", expansion: "Քաղաքացիական դատավարության օրենսգիրք" },
  { term: "ՎԴՕ", category: "օրենսգիրք", expansion: "Վարչական դատավարության օրենսգիրք" },
  { term: "ԱՕ", category: "օրենսգիրք", expansion: "Աշխատանքային օրենսգիրք" },
  { term: "ՍԱ", category: "օրենք", expansion: "ՀՀ Սահմանադրություն" },
  { term: "ՍԴ", category: "դատական", expansion: "Սահմանադրական դատարան" },
  { term: "ՎԴ", category: "դատական", expansion: "Վճռաբեկ դատարան" },
  { term: "ՄԻԵՎԴ", category: "դատական", expansion: "Մարդու իրավունքների եվրոպական դատարան" },
];

// Normalize Armenian text for matching: lowercase + collapse whitespace.
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Suggest legal terms matching the user's input.
 *
 * Matching strategy (in priority order):
 *   1. Exact abbreviation match (e.g. typing "ՔԴՕ" → exact match first)
 *   2. Starts-with match on the term
 *   3. Word-boundary contains match (every query word appears in order)
 *   4. Loose contains match (query is a substring)
 *
 * Returns up to `limit` suggestions, prioritized by match quality.
 */
export function suggestTerms(query: string, limit = 8): LegalTerm[] {
  const q = normalize(query);
  if (!q || q.length < 1) return [];

  const exact: LegalTerm[] = [];
  const startsWith: LegalTerm[] = [];
  const wordMatch: LegalTerm[] = [];
  const contains: LegalTerm[] = [];

  const queryWords = q.split(" ").filter(Boolean);

  for (const t of LEGAL_TERMS) {
    const termNorm = normalize(t.term);
    const expansionNorm = t.expansion ? normalize(t.expansion) : "";

    // Exact abbreviation match
    if (expansionNorm && q === normalize(t.term) && termNorm.length <= 6) {
      exact.push(t);
      continue;
    }
    // Exact expansion match (user typed the abbreviation)
    if (expansionNorm && q === expansionNorm) {
      exact.push(t);
      continue;
    }
    // Starts with
    if (termNorm.startsWith(q) || (expansionNorm && expansionNorm.startsWith(q))) {
      startsWith.push(t);
      continue;
    }
    // All query words appear in order in the term
    if (queryWords.length > 1) {
      let idx = 0;
      let allFound = true;
      for (const w of queryWords) {
        const found = termNorm.indexOf(w, idx);
        if (found === -1) {
          allFound = false;
          break;
        }
        idx = found + w.length;
      }
      if (allFound) {
        wordMatch.push(t);
        continue;
      }
    }
    // Loose contains
    if (termNorm.includes(q) || (expansionNorm && expansionNorm.includes(q))) {
      contains.push(t);
    }
  }

  // Dedupe by term (an entry might match multiple categories)
  const seen = new Set<string>();
  const result: LegalTerm[] = [];
  for (const t of [...exact, ...startsWith, ...wordMatch, ...contains]) {
    if (seen.has(t.term)) continue;
    seen.add(t.term);
    result.push(t);
    if (result.length >= limit) break;
  }
  return result;
}

/** Category display metadata (Armenian label + color). */
export const CATEGORY_META: Record<LegalTermCategory, { label: string; color: string }> = {
  "օրենսգիրք": { label: "Օրենսգիրք", color: "text-emerald-600 dark:text-emerald-400" },
  "օրենք": { label: "Օրենք", color: "text-blue-600 dark:text-blue-400" },
  "դատական": { label: "Դատական", color: "text-purple-600 dark:text-purple-400" },
  "հասկացություն": { label: "Հասկացություն", color: "text-orange-600 dark:text-orange-400" },
  "ընթացակարգ": { label: "Ընթացակարգ", color: "text-pink-600 dark:text-pink-400" },
  "կազմակերպություն": { label: "Կազմակերպություն", color: "text-teal-600 dark:text-teal-400" },
};
