// src/lib/legal/gold-set.ts
// Relevance gold-set test queries (spec §45).
//
// Each gold item specifies a query and the expected act/article that SHOULD
// appear in the top-4 results. The test harness measures Recall@4 and
// Exact Article Recall@4 (spec §46).

export type GoldItem = {
  /** The test query */
  query: string;
  /** Expected act title (or substring) that should appear in top-4 */
  expectedAct?: string;
  /** Expected article number */
  expectedArticle?: string;
  /** Expected ARLIS act ID */
  expectedActId?: string;
  /** Category for grouping results */
  category: GoldCategory;
};

export type GoldCategory =
  | "exact_code_article"
  | "natural_question"
  | "cassation"
  | "constitutional"
  | "law_title"
  | "article_part"
  | "abbreviation"
  | "no_result";

export const GOLD_SET: GoldItem[] = [
  // ---- Exact code + article ----
  {
    query: "ՔԴՕ 108 հոդված",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    expectedArticle: "108",
    category: "exact_code_article",
  },
  {
    query: "ՔԴՕ 105 հոդված",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    expectedArticle: "105",
    category: "exact_code_article",
  },
  {
    query: "ՔՕ 50 հոդված",
    expectedAct: "քրեական օրենսգիրք",
    expectedArticle: "50",
    category: "exact_code_article",
  },

  // ---- Law title ----
  {
    query: "քրեական դատավարության օրենսգիրք",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    category: "law_title",
  },
  {
    query: "քաղաքացիական օրենսգիրք",
    expectedAct: "քաղաքացիական օրենսգիրք",
    category: "law_title",
  },
  {
    query: "աշխատանքային օրենսգիրք",
    expectedAct: "աշխատանքային օրենսգիրք",
    category: "law_title",
  },

  // ---- Abbreviation ----
  {
    query: "ՔԴՕ",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    category: "abbreviation",
  },
  {
    query: "ՔՔՕ",
    expectedAct: "քաղաքացիական օրենսգիրք",
    category: "abbreviation",
  },
  {
    query: "ՎԴՕ",
    expectedAct: "վարչական դատավարության օրենսգիրք",
    category: "abbreviation",
  },

  // ---- Natural language question ----
  {
    query: "ձերբակալման կարգը քրեական դատավարության օրենսգրքում",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    category: "natural_question",
  },
  {
    query: "խափանման միջոցների տեսակները",
    expectedAct: "քրեական դատավարության օրենսգիրք",
    category: "natural_question",
  },

  // ---- No result (should return empty or unrelated) ----
  {
    query: "zzznonexistentquery12345",
    category: "no_result",
  },

  // ---- Constitutional ----
  {
    query: "ՀՀ Սահմանադրություն",
    expectedAct: "սահմանադրություն",
    category: "constitutional",
  },

  // ---- Cassation ----
  {
    query: "Վճռաբեկ դատարան ձերբակալում",
    category: "cassation",
  },
];

export type GoldTestResult = {
  query: string;
  category: GoldCategory;
  passed: boolean;
  resultCount: number;
  topResult?: string;
  topActId?: string;
  expectedAct?: string;
  expectedArticle?: string;
  foundExpectedAct: boolean;
  foundExpectedArticle: boolean;
  durationMs: number;
  error?: string;
};

export type GoldSetSummary = {
  total: number;
  passed: number;
  failed: number;
  recallAt4: number;
  exactArticleRecallAt4: number;
  avgDurationMs: number;
  results: GoldTestResult[];
};
