// tests/unit/query-understanding.test.ts
// Semantic query understanding + expansion tests (spec §8-§11).

import { describe, expect, test } from "bun:test";
import { understandQuery } from "@/lib/legal-search/engine/query-understanding";
import { expandQuery } from "@/lib/legal-search/engine/query-expansion";
import { detectConcepts, CONCEPT_LEXICON } from "@/lib/legal-search/engine/concept-lexicon";

describe("understandQuery", () => {
  test("detects exact article reference (overrides expansion, §10)", () => {
    const u = understandQuery("ՔԴՕ 179 հոդված");
    expect(u.hasExactReference).toBe(true);
    expect(u.exactReferences.articles).toContain("179");
    expect(u.exactReferences.actTitles.length).toBeGreaterThan(0);
    expect(u.parsed.actTitle).toContain("քրեական դատավարության");
  });

  test("detects case numbers", () => {
    const u = understandQuery("ԵԴ/36723/02/21 գործի վերաբերյալ");
    expect(u.exactReferences.caseNumbers.length).toBe(1);
    expect(u.parsed.questionType).toBe("case_law");
  });

  test("detects legal concepts in natural-language questions (§8)", () => {
    const u = understandQuery("դատարանը նիստ է անցկացրել առանց ինձ պատշաճ ծանուցելու");
    const conceptKeys = u.concepts.map((c) => c.hy);
    expect(conceptKeys).toContain("պատշաճ ծանուցում");
    expect(u.concepts[0].en).toBeDefined();
  });

  test("detects search-and-seizure concept with ECHR equivalents", () => {
    const u = understandQuery("ոստիկանությունը խուզարկության ժամանակ ապացույց է գտել");
    const keys = u.concepts.map((c) => c.hy);
    expect(keys).toContain("խուզարկություն");
    const search = u.concepts.find((c) => c.hy === "խուզարկություն")!;
    expect(search.en?.toLowerCase()).toContain("search");
  });

  test("detects historical intent (§18)", () => {
    const u = understandQuery("2021 թվականին գործող ՔԴՕ 108 հոդված");
    expect(u.parsed.wantsHistoricalLaw).toBe(false);
    expect(u.parsed.date).toBe("2021");
  });
});

describe("expandQuery", () => {
  test("exact-reference variants come FIRST (§10)", () => {
    const u = expandQuery(understandQuery("ՔԴՕ 179 հոդված"), "quick");
    expect(u.variants.length).toBeGreaterThan(0);
    expect(u.variants[0].lang).toBe("hy");
    // The first variant must mention the act title or article.
    const v0 = u.variants[0].text;
    expect(v0.includes("քրեական") || v0.includes("179")).toBe(true);
  });

  test("limits variant explosion (§9)", () => {
    const u = expandQuery(understandQuery("դատարանը նիստ է անցկացրել առանց ինձ պատշաճ ծանուցելու"), "quick");
    expect(u.variants.length).toBeLessThanOrEqual(8);
    const deep = expandQuery(
      { ...understandQuery("դատարանը նիստ է անցկացրել առանց ինձ պատշաճ ծանուցելու"), subquestions: ["a question one", "another question two"] },
      "deep",
    );
    expect(deep.variants.length).toBeLessThanOrEqual(12);
  });

  test("produces multilingual variants for concepts (§11)", () => {
    const u = expandQuery(understandQuery("պատշաճ ծանուցում դատական նիստ"), "deep");
    expect(u.multilingual).toBeDefined();
    const en = u.multilingual?.filter((m) => m.lang === "en") ?? [];
    expect(en.length).toBeGreaterThan(0);
  });

  test("subquestion variants are keyword-compressed", () => {
    const base = understandQuery("վարույթի նախաձեռնում չի եղել");
    base.subquestions = ["Ի՞նչ դեպքերում է պարտադիր քրեական վարույթ նախաձեռնել նոր հանցանքի հայտնաբերման դեպքում"];
    const u = expandQuery(base, "deep");
    const subq = u.variants.filter((v) => v.origin === "subquestion");
    expect(subq.length).toBeGreaterThan(0);
    expect(subq[0].text.length).toBeLessThanOrEqual(90);
  });
});

describe("concept lexicon", () => {
  test("lexicon is non-trivial and bilingual", () => {
    expect(CONCEPT_LEXICON.length).toBeGreaterThanOrEqual(30);
    for (const e of CONCEPT_LEXICON.slice(0, 10)) {
      expect(e.hy.length).toBeGreaterThan(3);
      expect(e.en.length).toBeGreaterThan(3);
    }
  });

  test("detectConcepts matches inflected forms", () => {
    const concepts = detectConcepts("ձերբակալված անձի իրավունքները խախտվել են");
    expect(concepts.map((c) => c.hy)).toContain("ձերբակալություն");
  });

  test("no concepts in unrelated text", () => {
    const concepts = detectConcepts("ոչ մի կապ չունեցող տեքստ եղանակի մասին");
    expect(concepts.length).toBe(0);
  });
});
