// tests/unit/local-laws.test.ts
// Unit tests for the reconstructed local-laws source (spec §6-§7):
// corpus loader, alias/act resolution (incl. the historic ԴՕ substring bug),
// exact-article ladder, lexical+concept scoring, adapter contract, and the
// fail-closed missing-corpus path.

import { describe, expect, test } from "bun:test";
import {
  loadLocalCorpus,
  resetLocalCorpusCacheForTests,
} from "@/lib/legal-search/local-laws/loader";
import { searchLocalLaws } from "@/lib/legal-search/local-laws/search";
import { localLawsAdapter } from "@/lib/legal-search/local-laws/adapter";
import { understandQuery } from "@/lib/legal-search/engine/query-understanding";
import { expandQuery } from "@/lib/legal-search/engine/query-expansion";
import type { LegalSearchQuery } from "@/lib/legal-search/types";

function buildQuery(raw: string): LegalSearchQuery {
  const understanding = expandQuery(understandQuery(raw), "quick");
  return { raw, understanding, variants: understanding.variants, mode: "quick" };
}

// fetchDocument is optional on the contract; the adapter always provides it.
const fetchDocument = localLawsAdapter.fetchDocument!;

const CTX = {
  deadline: Date.now() + 9_000,
  sourceTimeoutMs: 9_000,
  documentTimeoutMs: 12_000,
  mode: "quick" as const,
  requestId: "test-local-laws",
};

describe("local corpus loader (§6-§7)", () => {
  test("loads all 9 acts with provenance frontmatter", async () => {
    const corpus = await loadLocalCorpus();
    expect(corpus.acts.length).toBe(9);
    expect(corpus.stats.articles).toBeGreaterThanOrEqual(3_500);
    const categories = corpus.acts.map((a) => a.category).sort();
    expect(categories).toContain("constitution");
    expect(categories).toContain("criminal-code");
    expect(categories).toContain("bankruptcy");
  });

  test("article counts match the built corpus (spot checks)", async () => {
    const corpus = await loadLocalCorpus();
    const byCat = new Map(corpus.acts.map((a) => [a.category, a]));
    // 3,575 articles in the built corpus incl. prefaces.
    expect(byCat.get("constitution")?.articles.length).toBe(117 + 1); // + preface
    expect(byCat.get("criminal-code")?.articles.length).toBe(552 + 1);
    expect(byCat.get("civil-code")?.articles.length).toBe(1290 + 1);
  });

  test("frontmatter provenance survives (actId, status, canonicalUrl)", async () => {
    const corpus = await loadLocalCorpus();
    const criminal = corpus.acts.find((a) => a.category === "criminal-code");
    expect(criminal).toBeDefined();
    expect(criminal!.actId).toBe("230013");
    expect(criminal!.canonicalUrl).toBe("https://arlis.am/hy/acts/230013/latest");
    expect(criminal!.status).toContain("Գործում");
    expect(criminal!.retrievedAt).toMatch(/^2026-\d{2}-\d{2}T/);
  });

  test("missing corpus fails closed to empty (never throws)", async () => {
    resetLocalCorpusCacheForTests();
    process.env.LOCAL_LAWS_DIR = "/nonexistent/dir/for/tests";
    try {
      const corpus = await loadLocalCorpus();
      expect(corpus.acts.length).toBe(0);
      expect(corpus.stats.articles).toBe(0);
      const q = buildQuery("ՔԴՕ 179");
      expect(await searchLocalLaws(q, 5)).toEqual([]);
    } finally {
      delete process.env.LOCAL_LAWS_DIR;
      resetLocalCorpusCacheForTests();
    }
  });
});

describe("local corpus act resolution + exact articles", () => {
  test("alias ՔԴՕ 179 resolves to criminal-procedure-code article 179 (historic regression)", async () => {
    const matches = await searchLocalLaws(buildQuery("ՔԴՕ 179-րդ հոդված"), 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].act.category).toBe("criminal-procedure-code");
    expect(matches[0].article.num).toBe("179");
    expect(matches[0].relevance).toBeGreaterThanOrEqual(0.95);
    // The ACTUAL text must be the real article, not a stub.
    expect(matches[0].article.body.length).toBeGreaterThan(80);
  });

  test("alias ՔՕ 179 resolves to criminal-code article 179 — ԴՕ must never substring-match ՔԴՕ", async () => {
    const matches = await searchLocalLaws(buildQuery("ՔՕ 179"), 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].act.category).toBe("criminal-code");
    expect(matches[0].article.num).toBe("179");
    for (const m of matches) {
      expect(m.act.category).not.toBe("judicial-code");
    }
  });

  test("constitution alias: ՍԱ 42 / սահմանադրության 42-րդ հոդված", async () => {
    for (const raw of ["ՍԱ 42-րդ հոդված", "սահմանադրության 42-րդ հոդվածը"]) {
      const matches = await searchLocalLaws(buildQuery(raw), 5);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].act.category).toBe("constitution");
      expect(matches[0].article.num).toBe("42");
    }
  });

  test("inflected act title (գրավ ... քաղաքացիական օրենսգրքի) resolves civil-code", async () => {
    const matches = await searchLocalLaws(
      buildQuery("գրավի կանոնները քաղաքացիական օրենսգրքի համաձայն"),
      8,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].act.category).toBe("civil-code");
  });

  test("bare article number without act needs lexical support (no cross-act flood)", async () => {
    // With a meaningful term, the exact article ranks FIRST (act-resolved
    // or lexically supported); other lexically-matching articles may follow.
    const withSupport = await searchLocalLaws(
      buildQuery("հոդված 63 սահմանադրական իրավունքներ"),
      12,
    );
    expect(withSupport.length).toBeGreaterThan(0);
    expect(withSupport[0].article.num).toBe("63");
    // A bare number with NO act hint and NO meaningful terms floods nothing.
    const bare = await searchLocalLaws(buildQuery("հոդված 63"), 12);
    const bareExact = bare.filter((m) => m.signals.includes("article-number+lexical"));
    expect(bareExact.length).toBe(0);
  });

  test("English 'Article 5' parse does not flood every act's article 5 (r7 regression)", async () => {
    const matches = await searchLocalLaws(
      buildQuery("Article 5 §3 Armenia երկարաձգված կալանքի գործ"),
      12,
    );
    const art5 = matches.filter((m) => m.article.num === "5");
    // At most acts with REAL lexical support — and NOT a 0.9+ “exact” claim.
    for (const m of art5) {
      expect(m.relevance).toBeLessThan(0.95);
    }
    // The flood signature (9 acts × article 5) must be gone.
    expect(art5.length).toBeLessThan(5);
  });
});

describe("local corpus lexical + concept search", () => {
  test("natural-language question about detention terms hits criminal-procedure articles", async () => {
    const matches = await searchLocalLaws(
      buildQuery("ձերբակալության առավելագույն ժամկետը որքանն է"),
      8,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].relevance).toBeGreaterThan(0);
    // Top hits should be dominated by the criminal procedure code.
    const cpc = matches.filter((m) => m.act.category === "criminal-procedure-code");
    expect(cpc.length).toBeGreaterThan(0);
    expect(matches[0].article.body.length).toBeGreaterThan(60);
  });

  test("case-number query never fakes exact article claims", async () => {
    const matches = await searchLocalLaws(buildQuery("ՎԴ/0008/05/23 վճռաբեկ դատարանի որոշում"), 12);
    // Lexical/title matches may exist (real articles about վճռաբեկ դատարան),
    // but nothing may masquerade as an exact reference to the case.
    for (const m of matches) {
      expect(m.relevance).toBeLessThan(0.95);
      expect(m.article.num).not.toBe("0008");
    }
  });

  test("limit is respected", async () => {
    const matches = await searchLocalLaws(buildQuery("պատիժ քրեական օրենսգրքով"), 4);
    expect(matches.length).toBeLessThanOrEqual(4);
  });
});

describe("local-laws adapter contract", () => {
  test("search returns SUCCESS with verified local results", async () => {
    const { outcome, results } = await localLawsAdapter.search(buildQuery("ՔԴՕ 179"), CTX);
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.resultCount).toBeGreaterThan(0);
    const r = results[0];
    expect(r.sourceId).toBe("local-laws");
    expect(r.sourceType).toBe("local_laws");
    expect(r.authority).toBe(70);
    expect(r.url).toBe("https://arlis.am/hy/acts/230458/latest");
    expect(r.fullText).toContain("Հոդված 179");
    expect(r.fullTextVerified).toBe(true);
    expect(r.metadataVerified).toBe(true);
    expect(r.temporalStatus).toBe("current");
    expect(r.externalId).toBe("230458#179");
    expect(r.meta?.snapshot).toBe("arlis");
  });

  test("ECHR case query surfaces only honestly-titled legislation, no fake exact refs", async () => {
    const { outcome, results } = await localLawsAdapter.search(
      buildQuery("ՄԻԵՎԴ 11275/07 գանգատ"),
      CTX,
    );
    // Whatever surfaces must be real corpus articles (e.g. acts literally
    // titled about human rights) — never an invented case or article ref.
    if (results.length > 0) {
      expect(outcome.status).toBe("SUCCESS");
      for (const r of results) {
        expect(r.caseNumber).toBeUndefined();
        expect(r.article).not.toBe("11275");
        expect(r.url).toMatch(/^https:\/\/arlis\.am\/hy\/acts\/\d+\/latest$/);
      }
    } else {
      expect(outcome.status).toBe("EMPTY");
      expect(outcome.detail).toBeTruthy();
    }
  });

  test("supports() is always true (local + fast)", () => {
    expect(localLawsAdapter.supports(buildQuery("anything"))).toBe(true);
  });

  test("fetchDocument returns the article text from the corpus", async () => {
    const { results } = await localLawsAdapter.search(buildQuery("ՔԴՕ 179"), CTX);
    const res = await fetchDocument(results[0], CTX);
    expect(res.status).toBe("SUCCESS");
    expect(res.document?.kind).toBe("text");
    expect(res.document?.text).toContain("Հոդված 179");
    expect(res.resolutionNote).toBeTruthy();
  });

  test("fetchDocument resolves by canonical URL when externalId is absent", async () => {
    const { results } = await localLawsAdapter.search(buildQuery("ՔԴՕ 179"), CTX);
    const stripped = { ...results[0], externalId: undefined, meta: undefined };
    const res = await fetchDocument(stripped, CTX);
    expect(res.status).toBe("SUCCESS");
  });

  test("fetchDocument is EMPTY for unknown documents (never throws)", async () => {
    const res = await fetchDocument(
      {
        sourceId: "local-laws",
        sourceName: "x",
        sourceType: "local_laws",
        authority: 70,
        title: "unknown",
        url: "https://arlis.am/hy/acts/999999999/latest",
        excerpt: "",
        relevance: 0,
        temporalStatus: "unknown",
        retrievedAt: new Date().toISOString(),
      },
      CTX,
    );
    expect(res.status).toBe("EMPTY");
  });
});
