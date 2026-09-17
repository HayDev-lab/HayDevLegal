// tests/unit/engine-core.test.ts
// Unit tests for dedup, reranker, passage extraction, evidence pack,
// temporal validation, content sanitizer (spec §14-§20).

import { describe, expect, test } from "bun:test";
import { deduplicate } from "@/lib/legal-search/engine/deduplicator";
import { rerank, scoreResult } from "@/lib/legal-search/engine/legal-reranker";
import { splitPassages, scorePassage, extractPassages, bestPassage } from "@/lib/legal-search/engine/passage-extractor";
import { buildEvidencePack, evidenceToLegacySources } from "@/lib/legal-search/engine/evidence-builder";
import { validateTemporal, temporalWarnings, temporalLabel } from "@/lib/legal-search/engine/temporal-validator";
import { extractMainText, truncatePassage } from "@/lib/legal-search/security/content-sanitizer";
import { understandQuery } from "@/lib/legal-search/engine/query-understanding";
import type { LegalSearchResult } from "@/lib/legal-search/types";

function mkResult(over: Partial<LegalSearchResult>): LegalSearchResult {
  return {
    sourceId: "arlis",
    sourceName: "ARLIS",
    sourceType: "legislation",
    authority: 100,
    title: "Test act",
    url: "https://arlis.am/hy/acts/1/latest",
    temporalStatus: "unknown",
    excerpt: "Test excerpt about խուզարկություն and ծանուցում rules",
    relevance: 0,
    retrievedAt: new Date().toISOString(),
    ...over,
  };
}

describe("deduplicate (§19)", () => {
  test("dedups by case number across sources", () => {
    const a = mkResult({
      sourceId: "datalex",
      sourceName: "Datalex",
      sourceType: "case_law",
      authority: 75,
      title: "Գործ Ա",
      caseNumber: "ԵԴ/1234/02/21",
      url: "https://datalex.am/?app=AppCaseSearch&case_id=1",
      relevance: 0.5,
    });
    const b = mkResult({
      sourceId: "judiciary",
      sourceName: "ՎԴ",
      sourceType: "cassation",
      authority: 90,
      title: "Նախադեպ Ա",
      caseNumber: "ԵԴ/1234/02/21",
      url: "https://datalex.am/?app=AppPrecedentCaseSearch&case_id=2",
      relevance: 0.6,
    });
    const out = deduplicate([a, b]);
    expect(out.length).toBe(1);
    // The higher-authority/precedent representative wins.
    expect(out[0].sourceId).toBe("judiciary");
  });

  test("dedups by normalized title", () => {
    const a = mkResult({ title: "ՀՀ ՔՐԵԱԿԱՆ ՕՐԵՆՍԳԻՐՔ", url: "https://arlis.am/hy/acts/1/latest" });
    const b = mkResult({ title: "ՀՀ ՔՐԵԱԿԱՆ ՕՐԵՆՍԳԻՐՔ", url: "https://arlis.am/hy/acts/2/latest" });
    expect(deduplicate([a, b]).length).toBe(1);
  });

  test("keeps genuinely different documents", () => {
    const a = mkResult({ title: "Ակտ մեկ", caseNumber: "ԵԴ/1/02/21", url: "https://datalex.am/?app=AppCaseSearch&case_id=1" });
    const b = mkResult({ title: "Ակտ երկու", caseNumber: "ԵԴ/2/02/21", url: "https://datalex.am/?app=AppCaseSearch&case_id=2" });
    expect(deduplicate([a, b]).length).toBe(2);
  });
});

describe("legal-reranker (§16-§17)", () => {
  const u = understandQuery("ՔԴՕ 179 հոդված");

  test("exact act+article beats generic web hit", () => {
    const exact = mkResult({
      title: "ՀՀ ՔՐԵԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ",
      article: "179",
      passages: ["Հոդված 179. Քրեական վարույթ չնախաձեռնելը՝ ..."],
      sourceId: "arlis",
      authority: 100,
    });
    const web = mkResult({
      sourceId: "web",
      sourceName: "Վեբ",
      sourceType: "web",
      authority: 20,
      title: "Բլոգ քրեական իրավունքի մասին",
      passages: ["Իրավական բլոգի հոդված"],
    });
    const s1 = scoreResult(exact, u, "quick");
    const s2 = scoreResult(web, u, "quick");
    expect(s1.score).toBeGreaterThan(s2.score);
  });

  test("authority matters when lexical scores are equal", () => {
    const u2 = understandQuery("ինչ-որ ընդհանուր հարց իրավունքի մասին");
    const official = mkResult({ sourceId: "arlis", authority: 100, title: "Նորմատիվ ակտ", excerpt: "ընդհանուր" });
    const webHit = mkResult({ sourceId: "web", sourceType: "web", sourceName: "Վեբ", authority: 20, title: "Նորմատիվ ակտ", excerpt: "ընդհանուր" });
    expect(scoreResult(official, u2, "quick").score).toBeGreaterThan(
      scoreResult(webHit, u2, "quick").score,
    );
  });

  test("rerank keeps official sources from being crowded out (§23)", () => {
    const u3 = understandQuery("դատական պրակտիկա գործերի վերաբերյալ");
    const many = Array.from({ length: 12 }, (_, i) =>
      mkResult({
        title: `Գործ ${i}`,
        sourceId: "datalex",
        sourceName: "Datalex",
        sourceType: "case_law",
        authority: 75,
        caseNumber: `ԵԴ/${i}/02/21`,
        url: `https://datalex.am/?app=AppCaseSearch&case_id=${i}`,
        excerpt: "դատական գործ պրակտիկա",
        relevance: 0.9,
      }),
    );
    const official = Array.from({ length: 3 }, (_, i) =>
      mkResult({
        title: `Նորմատիվ ակտ ${i}`,
        sourceId: "arlis",
        excerpt: "դատական գործ պրակտիկա նորմ",
        relevance: 0.2,
      }),
    );
    const out = rerank([...many, ...official], u3, "deep", 10);
    // Official ARLIS results must survive despite lower lexical scores.
    expect(out.some((r) => r.sourceId === "arlis")).toBe(true);
    expect(out.length).toBe(10);
  });
});

describe("passage extraction (§15)", () => {
  test("splits on article markers", () => {
    const text = "Նախաբան...\n\nՀոդված 1. Առաջին հոդվածի տեքստը բավական երկար է որպեսզի նորմալ բաժանվի։\n\nՀոդված 2. Երկրորդ հոդվածի տեքստը նույնպես երկար է շատ տողերով։";
    const passages = splitPassages(text);
    expect(passages.length).toBeGreaterThanOrEqual(2);
  });

  test("scores concept-bearing passages higher", () => {
    const low = scorePassage("Ընդհանուր տեքստ առանց կապի եղանակի մասին", new Set(["ծանուցում"]), []);
    const high = scorePassage("Դատական նիստի ծանուցում կատարվել է պատշաճ կարգով", new Set(["ծանուցում"]), ["ծանուցում"]);
    expect(high).toBeGreaterThan(low);
  });

  test("extractPassages sets passages on the result", () => {
    const r = mkResult({});
    const doc = "Հոդված 179. Քրեական վարույթ չնախաձեռնելը պարունակում է կարևոր կանոններ ծանուցման վերաբերյալ և այլ դրույթներ։";
    const passages = extractPassages(r, doc, new Set(["ծանուցման", "վարույթ"]), ["ծանուցում"]);
    expect(passages.length).toBeGreaterThan(0);
    expect(r.passages?.length).toBeGreaterThan(0);
    expect(bestPassage(r).length).toBeGreaterThan(0);
  });
});

describe("evidence pack (§20)", () => {
  test("builds E1..En with canonical URLs and passages", () => {
    const rs = [
      mkResult({ title: "Ակտ մեկ", passages: ["Առաջին նորմի տեքստը ".repeat(10).trim()] }),
      mkResult({
        title: "Գործ երկու",
        sourceId: "datalex",
        sourceType: "case_law",
        sourceName: "Datalex",
        authority: 75,
        caseNumber: "ԵԴ/9/02/21",
        url: "https://datalex.am/?app=AppCaseSearch&case_id=9",
        passages: ["Դատական գործի մասին տեքստ ".repeat(8).trim()],
      }),
    ];
    const pack = buildEvidencePack(rs);
    expect(pack.length).toBe(2);
    expect(pack[0].id).toBe("E1");
    expect(pack[1].id).toBe("E2");
    expect(pack[0].url).toContain("arlis.am");
    expect(pack[1].caseNumber).toBe("ԵԴ/9/02/21");
    expect(pack[0].passage.length).toBeGreaterThan(40);
  });

  test("legacy mapping keeps ids and urls", () => {
    const rs = [mkResult({ title: "Ակտ", passages: ["Տեքստ ".repeat(20).trim()] })];
    const legacy = evidenceToLegacySources(buildEvidencePack(rs));
    expect(legacy[0].id).toBe("E1");
    expect(legacy[0].canonicalUrl).toContain("arlis.am");
    expect(legacy[0].sourceLabel).toBe("Օրենսդրություն");
  });
});

describe("temporal validation (§18)", () => {
  test("classifies current vs historical by status text", () => {
    expect(validateTemporal(mkResult({ status: "Գործունակ" })).temporalStatus).toBe("current");
    expect(validateTemporal(mkResult({ status: "Ուժը կորցրել է" })).temporalStatus).toBe("historical");
    expect(validateTemporal(mkResult({})).temporalStatus).toBe("unknown");
  });

  test("warns when user wants historical but only current available", () => {
    const u = understandQuery("նախկին խմբագրությամբ ՔԴՕ 108 հոդված");
    const rs = [mkResult({ sourceId: "arlis", status: "Գործունակ", temporalStatus: "current" })];
    const ws = temporalWarnings(u, rs);
    expect(ws.length).toBeGreaterThan(0);
    expect(ws[0].kind).toBe("temporal");
  });

  test("temporalLabel renders Armenian", () => {
    expect(temporalLabel({ temporalStatus: "current" })).toBe("Գործող");
    expect(temporalLabel({ temporalStatus: "historical" })).toBe("Պատմական խմբագրություն");
    expect(temporalLabel({ temporalStatus: "unknown" })).toBe("Անհայտ");
  });
});

describe("content sanitizer (§15, §28)", () => {
  test("strips scripts, styles, nav chrome", () => {
    const html = `<html><body>
      <script>alert('x')</script>
      <style>.x{}</style>
      <nav class="main-menu"><a href="#">Menu</a></nav>
      <div class="content"><p>Հոդված 1. Իրավական տեքստ</p><p>Շարունակություն</p></div>
    </body></html>`;
    const text = extractMainText(html);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Menu");
    expect(text).toContain("Իրավական տեքստ");
  });

  test("truncatePassage respects sentence boundary", () => {
    const long = "Առաջին նախադասություն։ Երկրորդ նախադասություն։ Երրորդ նախադասություն։ Չորրորդ։";
    const cut = truncatePassage(long, 40);
    expect(cut.length).toBeLessThanOrEqual(42);
  });
});
