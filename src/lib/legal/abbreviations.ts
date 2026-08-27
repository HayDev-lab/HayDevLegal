// src/lib/legal/abbreviations.ts
// Controlled Armenian legal abbreviation dictionary.
//
// ARLIS does NOT expand abbreviations server-side, so we expand them here
// before sending the simple_text query. Each canonical mapping keeps the
// original short form too, so ranking still benefits from exact-abbreviation
// matches.

export type AbbreviationEntry = {
  /** Uppercase canonical short form, e.g. "ՔԴՕ" */
  abbr: string;
  /** Full Armenian act title */
  full: string;
  /** Lowercase variant tokens used for body matching */
  tokens: string[];
  /** Type bucket for source-label classification */
  actType:
    | "code"
    | "law"
    | "constitution"
    | "casation"
    | "constitutional_court"
    | "echr"
    | "other";
};

export const ABBREVIATIONS: AbbreviationEntry[] = [
  {
    abbr: "ՔԴՕ",
    full: "ՀՀ քրեական դատավարության օրենսգիրք",
    tokens: ["քրեական", "դատավարության", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՔԴՕՐ",
    full: "ՀՀ քրեական դատավարության օրենսգիրք",
    tokens: ["քրեական", "դատավարության", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՔՕ",
    full: "ՀՀ քրեական օրենսգիրք",
    tokens: ["քրեական", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՔՔՕ",
    full: "ՀՀ քաղաքացիական օրենսգիրք",
    tokens: ["քաղաքացիական", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՔՔԴՕ",
    full: "ՀՀ քաղաքացիական դատավարության օրենսգիրք",
    tokens: ["քաղաքացիական", "դատավարության", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՎԴՕ",
    full: "ՀՀ վարչական դատավարության օրենսգիրք",
    tokens: ["վարչական", "դատավարության", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ԱՕ",
    full: "ՀՀ աշխատանքային օրենսգիրք",
    tokens: ["աշխատանքային", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ԸնտՕ",
    full: "ՀՀ ընտական օրենսգիրք",
    tokens: ["ընտական", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ԸՆՏՕ",
    full: "ՀՀ ընտական օրենսգիրք",
    tokens: ["ընտական", "օրենսգիրք"],
    actType: "code",
  },
  {
    abbr: "ՏՀՕ",
    full: "ՀՀ տարածքային ինքնակառավարման մասին օրենք",
    tokens: ["տարածքային", "ինքնակառավարման", "օրենք"],
    actType: "law",
  },
  {
    abbr: "ՍԱ",
    full: "ՀՀ Սահմանադրություն",
    tokens: ["սահմանադրություն"],
    actType: "constitution",
  },
  {
    abbr: "ՍԴ",
    full: "ՀՀ սահմանադրական դատարան",
    tokens: ["սահմանադրական", "դատարան"],
    actType: "constitutional_court",
  },
  {
    abbr: "ՎԴ",
    full: "ՀՀ վճռաբեկ դատարան",
    tokens: ["վճռաբեկ", "դատարան"],
    actType: "casation",
  },
  {
    abbr: "ՄԻԵՎԴ",
    full: "Մարդու իրավունքների եվրոպական դատարան",
    tokens: ["մարդու", "իրավունքների", "եվրոպական", "դատարան"],
    actType: "echr",
  },
];

const BY_ABBR = new Map<string, AbbreviationEntry>(
  ABBREVIATIONS.map((a) => [a.abbr, a]),
);

/** Find an abbreviation entry by its canonical short form (case-sensitive on Armenian). */
export function lookupAbbreviation(token: string): AbbreviationEntry | undefined {
  if (!token) return undefined;
  // Try uppercase first (Armenian has case)
  const up = token.toUpperCase();
  if (BY_ABBR.has(up)) return BY_ABBR.get(up);
  return BY_ABBR.get(token);
}

/** Expand every recognised abbreviation inside a query string into full text. */
export function expandAbbreviations(query: string): {
  expanded: string;
  matched: AbbreviationEntry[];
} {
  const matched: AbbreviationEntry[] = [];
  const seen = new Set<string>();
  if (!query) return { expanded: query, matched };

  // JS \b word boundaries do NOT work with Armenian Unicode, so we tokenize
  // manually: split on whitespace/punctuation, keep Armenian + Latin + digits.
  // We track separators to reconstruct the string with abbreviations replaced.
  const tokenRe = /[\u0530-\u058FA-Za-z0-9]+|[^\u0530-\u058FA-Za-z0-9]+/gu;
  const parts = query.match(tokenRe) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    // Is this a word token (starts with Armenian/Latin/digit)?
    if (/^[\u0530-\u058FA-Za-z0-9]/u.test(part)) {
      const entry = lookupAbbreviation(part);
      if (entry) {
        if (!seen.has(entry.abbr)) {
          seen.add(entry.abbr);
          matched.push(entry);
        }
        out.push(entry.full);
        continue;
      }
    }
    out.push(part);
  }
  return { expanded: out.join(""), matched };
}
