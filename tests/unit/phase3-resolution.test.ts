// tests/unit/phase3-resolution.test.ts
// Phase 3 unit tests: HUDOC query builder + web-discovery contract (§7-§10, §19),
// reference extractor (§37-§39), document resolver identity verification
// (§32-§33), session store (§26-§27), evidence grading (§45-§46),
// access-state classification (§22-§23), resume store (§64).

import { describe, expect, test } from "bun:test";
import {
  HudocQueryBuilder,
  normalizeConventionArticle,
  extractConventionArticle,
  extractApplicationNumber,
  isApplicationNumber,
} from "@/lib/legal-search/sources/hudoc/query-builder";
import { parseHudocWebItemForTest, hudocCanonicalUrl } from "@/lib/legal-search/sources/hudoc/client";
import {
  extractLegalReferences,
  selectFollowableReferences,
  buildCitationGraph,
} from "@/lib/legal-search/engine/reference-extractor";
import { verifyIdentity } from "@/lib/legal-search/engine/document-resolver";
import {
  setSession,
  getSession,
  updateSession,
  clearSession,
  sessionDiagnostics,
} from "@/lib/legal-search/sources/session-store";
import { evidenceGrade, buildEvidencePack } from "@/lib/legal-search/engine/evidence-builder";
import { createResumeToken, getResumeToken, dropResumeToken, parseDocumentRef } from "@/lib/legal-search/engine/resume-store";
import { datalexAdapter } from "@/lib/legal-search/sources/datalex/adapter";
import type { LegalSearchResult, ResolutionCandidate } from "@/lib/legal-search/types";

// ---------------------------------------------------------------------------
// HUDOC query builder (§7-§10)
// ---------------------------------------------------------------------------

describe("HUDOC query builder (§7-§10)", () => {
  test("normalizes Convention article variants (§9)", () => {
    expect(normalizeConventionArticle("Article 5")).toBe("5");
    expect(normalizeConventionArticle("article 5 § 3")).toBe("5§3");
    expect(normalizeConventionArticle("Art. 5(3)")).toBe("5§3");
    expect(normalizeConventionArticle("Article 6 para 1")).toBe("6§1");
    expect(normalizeConventionArticle("P1-1")).toBe("P1-1");
    expect(normalizeConventionArticle("Protocol 1 Article 1")).toBe("P1-1");
    expect(normalizeConventionArticle("nonsense")).toBeNull();
  });

  test("extracts article from free text", () => {
    expect(extractConventionArticle("violation of Article 5 §3 of the Convention")).toBe("5§3");
    expect(extractConventionArticle("P4-2 property case")).toBe("P4-2");
  });

  test("application number detection (§8)", () => {
    expect(isApplicationNumber("11275/07")).toBe(true);
    expect(isApplicationNumber("12345/20")).toBe(true);
    expect(isApplicationNumber("12345/200")).toBe(false);
    expect(extractApplicationNumber("case no. 11275/07 against Armenia")).toBe("11275/07");
  });

  test("exact application search beats semantic (§8)", () => {
    const qb = HudocQueryBuilder.exactApplication("12345/20");
    const queries = qb.toWebDiscoveryQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0].exact).toBe(true);
    expect(queries[0].query).toContain('"12345/20"');
  });

  test("API filter string carries respondent + article (live-verified GET contract)", () => {
    const qb = HudocQueryBuilder.articleForRespondent("5§3", "ARM");
    const filter = qb.toApiFilter();
    expect(filter).toContain('(respondent="ARM")');
    expect(filter).toContain('(article="5-3")'); // paragraph facets use dash form
    expect(filter).toContain("(contentsitename=ECHR)");
    // press releases excluded from the main search
    expect(filter).toContain("NOT (doctype=PR");
  });

  test("article + respondent web discovery for Armenia (§10)", () => {
    const qb = HudocQueryBuilder.articleForRespondent("6§1", "ARM");
    const queries = qb.toWebDiscoveryQueries();
    expect(queries.some((q) => q.query.includes("Article 6 §1") && q.query.includes("Armenia"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HUDOC web-discovery parsing contract (§19 — fail gracefully on schema change)
// ---------------------------------------------------------------------------

describe("HUDOC web-discovery parsing (§19)", () => {
  test("parses a real HUDOC result link + snippet", () => {
    const doc = parseHudocWebItemForTest({
      url: "https://hudoc.echr.coe.int/eng?i=001-204811",
      name: "JHANGIRYAN v. ARMENIA - HUDOC - The Council of Europe",
      snippet:
        "Art 5 § 1 (c) • Lack of reasonable suspicion of the applicant having committed an offence. Art 5 § 3 • Reasonableness of pre-trial detention. The case originated in an application (no. 52445/02) against the Republic of Armenia.",
    });
    expect(doc).not.toBeNull();
    expect(doc!.itemId).toBe("001-204811");
    expect(doc!.caseName).toBe("JHANGIRYAN v. ARMENIA");
    expect(doc!.applicationNumbers).toContain("52445/02");
    expect(doc!.articles).toContain("5§1");
    expect(doc!.articles).toContain("5§3");
    expect(doc!.canonicalUrl).toBe("https://hudoc.echr.coe.int/eng?i=001-204811");
  });

  test("rejects non-HUDOC urls and malformed ids", () => {
    expect(parseHudocWebItemForTest({ url: "https://example.com/eng?i=001-1", name: "x", snippet: "" })).toBeNull();
    expect(
      parseHudocWebItemForTest({ url: "https://hudoc.echr.coe.int/eng?i=abc", name: "x", snippet: "" }),
    ).toBeNull();
    expect(parseHudocWebItemForTest({ url: "https://hudoc.echr.coe.int/eng", name: "x", snippet: "" })).toBeNull();
  });

  test("press links map to OTHER document type", () => {
    const doc = parseHudocWebItemForTest({
      url: "https://hudoc.echr.coe.int/eng-press?i=003-5557950-7004858",
      name: "Judgment Muradyan v. Armenia - press release",
      snippet: "Judgment Muradyan v. Armenia",
    });
    expect(doc).not.toBeNull();
    expect(doc!.documentType).toBe("OTHER");
  });

  test("canonical URL shape (§49 — URLs come from the resolver)", () => {
    expect(hudocCanonicalUrl("001-204811")).toBe("https://hudoc.echr.coe.int/eng?i=001-204811");
  });
});

// ---------------------------------------------------------------------------
// Reference extractor (§37-§39)
// ---------------------------------------------------------------------------

describe("reference extractor (§37-§39)", () => {
  test("extracts Armenian case numbers (§29)", () => {
    const refs = extractLegalReferences(
      "Վճռաբեկ դատարանը ուսումնասիրել է ԵԴ/1234/02/21 և ՎԴ/0105/02/21 գործերը և ԵԿԴ/55/02/22 որոշումը",
    );
    const caseNums = refs.filter((r) => r.kind === "armenian_case_number").map((r) => r.value);
    expect(caseNums).toContain("ԵԴ/1234/02/21");
    expect(caseNums).toContain("ՎԴ/0105/02/21");
    expect(caseNums).toContain("ԵԿԴ/55/02/22");
  });

  test("extracts ՍԴՈ numbers", () => {
    const refs = extractLegalReferences("հիմք ընդունելով ՍԴՈ-1842 որոշումը");
    const sdvo = refs.find((r) => r.kind === "concourt_decision");
    expect(sdvo?.value).toBe("ՍԴՈ-1842");
  });

  test("extracts ECHR application numbers and ECLI", () => {
    const refs = extractLegalReferences(
      "ՄԻԵՎԴ-ի 2012 թ. որոշումը գործով (no. 11275/07), ECLI:CE:ECHR:2012:1030JUD00168752",
    );
    expect(refs.find((r) => r.kind === "echr_application")?.value).toBe("11275/07");
    expect(refs.find((r) => r.kind === "ecli")?.value).toBe("ECLI:CE:ECHR:2012:1030JUD00168752");
  });

  test("citation graph skips self-references (§39)", () => {
    const r: LegalSearchResult = {
      sourceId: "judiciary",
      sourceName: "ՎԴ",
      sourceType: "cassation",
      authority: 90,
      title: "Գործ Ա",
      url: "https://datalex.am/x",
      caseNumber: "ՎԴ/1111/02/21",
      temporalStatus: "unknown",
      excerpt: "",
      relevance: 0,
      retrievedAt: new Date().toISOString(),
      fullText: "ՎԴ/1111/02/21 գործը վկայակոչում է ԵԴ/2222/02/21 և ՄԻԵՎԴ 33446/06 գործերը",
    };
    const edges = buildCitationGraph([r]);
    const values = edges.map((e) => e.ref.value);
    expect(values).toContain("ԵԴ/2222/02/21");
    expect(values).toContain("33446/06");
    expect(values).not.toContain("ՎԴ/1111/02/21"); // self-reference excluded
  });

  test("selectFollowableReferences excludes identifiers already in evidence", () => {
    const r: LegalSearchResult = {
      sourceId: "judiciary",
      sourceName: "ՎԴ",
      sourceType: "cassation",
      authority: 90,
      title: "Գործ Ա",
      url: "https://datalex.am/x",
      caseNumber: "ՎԴ/1111/02/21",
      temporalStatus: "unknown",
      excerpt: "",
      relevance: 0,
      retrievedAt: new Date().toISOString(),
      fullText: "վկայակոչում է ԵԴ/2222/02/21, ԵԴ/3333/02/21 և ՄԻԵՎԴ 33446/06, 44042/07 գործերը",
    };
    const follow = selectFollowableReferences([r], [r], 2);
    const values = follow.map((f) => f.value);
    expect(values.length).toBe(2);
    expect(values).not.toContain("ՎԴ/1111/02/21");
  });
});

// ---------------------------------------------------------------------------
// Document resolver — identity verification (§32-§33)
// ---------------------------------------------------------------------------

describe("document resolver identity verification (§32-§33)", () => {
  const candidate: ResolutionCandidate = {
    sourceId: "judiciary",
    sourceName: "Վճռաբեկ դատարան",
    sourceType: "cassation",
    authority: 90,
    url: "https://datalex.am/?app=AppPrecedentCaseSearch&case_id=123",
    title: "Դատական գործ Արամ Պետրոսյան ընդդեմ ՀՀ",
    court: "ՀՀ Վճռաբեկ դատարան",
    caseNumber: "ՎԴ/0105/02/21",
    date: "2021-05-10",
  };

  test("exact case number match verifies identity (§33 auto-accept)", () => {
    const { verified, signals } = verifyIdentity(candidate, "որոշումը կայացվել է ՎԴ/0105/02/21 գործով");
    expect(verified).toBe(true);
    expect(signals.some((s) => s.startsWith("caseNumber:"))).toBe(true);
  });

  test("wrong document is rejected (§78 — wrong document rate must be 0)", () => {
    const { verified } = verifyIdentity(candidate, "Այլ գործի տեքստ առանց համարի");
    expect(verified).toBe(false);
  });

  test("strong combination court+date+title verifies without identifier", () => {
    const c2: ResolutionCandidate = {
      ...candidate,
      caseNumber: undefined,
      applicationNumber: undefined,
    };
    const { verified, signals } = verifyIdentity(
      c2,
      "ՀՀ Վճռաբեկ դատարանի որոշում 2021 թ. մայիսի 10-ին. Դատական գործ Արամ Պետրոսյան ընդդեմ ՀՀ Հանրապետության",
    );
    expect(verified).toBe(true);
    expect(signals).toContain("title");
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });

  test("title alone is NOT enough (doubt -> metadata-only)", () => {
    const c2: ResolutionCandidate = { ...candidate, caseNumber: undefined, court: undefined, date: undefined };
    const { verified } = verifyIdentity(c2, "Դատական գործ Արամ Պետրոսյան ընդդեմ ՀՀ Հանրապետության վերնագիրը");
    expect(verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session store (§26-§27)
// ---------------------------------------------------------------------------

describe("session store (§26-§27)", () => {
  test("set / get / update / clear lifecycle", () => {
    clearSession("test-source");
    expect(getSession("test-source")).toBeUndefined();
    setSession({ source: "test-source", cookies: "PHPSESSID=abc", createdAt: Date.now() });
    expect(getSession("test-source")?.cookies).toBe("PHPSESSID=abc");
    updateSession("test-source", { captchaKey: "Xy9Zk" });
    const s = getSession("test-source");
    expect(s?.captchaKey).toBe("Xy9Zk");
    expect(s?.captchaKeyAt).toBeGreaterThan(0);
    clearSession("test-source");
    expect(getSession("test-source")).toBeUndefined();
  });

  test("expired captcha key is dropped on read", () => {
    clearSession("test-source2");
    setSession({ source: "test-source2", createdAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 });
    updateSession("test-source2", { captchaKey: "abc12" });
    // age the key artificially
    const s = getSession("test-source2");
    if (s) {
      // simulate TTL expiry
      (s as { captchaKeyAt?: number }).captchaKeyAt = Date.now() - 16 * 60 * 1000;
    }
    expect(getSession("test-source2")?.captchaKey).toBeUndefined();
    clearSession("test-source2");
  });

  test("diagnostics never expose cookie values (§27)", () => {
    clearSession("test-source3");
    setSession({ source: "test-source3", cookies: "PHPSESSID=SECRETVALUE", createdAt: Date.now() });
    const diag = JSON.stringify(sessionDiagnostics());
    expect(diag).not.toContain("SECRETVALUE");
    clearSession("test-source3");
  });
});

// ---------------------------------------------------------------------------
// Evidence grading (§45-§46)
// ---------------------------------------------------------------------------

describe("evidence grading (§45-§46)", () => {
  const base: LegalSearchResult = {
    sourceId: "arlis",
    sourceName: "ARLIS",
    sourceType: "legislation",
    authority: 100,
    title: "Act",
    url: "https://arlis.am/x",
    temporalStatus: "unknown",
    excerpt: "sample excerpt long enough for the pack builder",
    relevance: 0.5,
    retrievedAt: new Date().toISOString(),
    passages: ["Հոդված 1. Բավական երկար տեքստ ապացույցի համար։"],
  };

  test("official + verified full text = PRIMARY_VERIFIED", () => {
    expect(evidenceGrade({ ...base, fullText: "text", fullTextVerified: true })).toBe("PRIMARY_VERIFIED");
  });
  test("official + metadata only = PRIMARY_METADATA", () => {
    expect(evidenceGrade({ ...base, metadataVerified: true, fullTextVerified: false })).toBe("PRIMARY_METADATA");
  });
  test("web + verified text = SECONDARY_VERIFIED", () => {
    expect(
      evidenceGrade({
        ...base,
        sourceId: "web",
        sourceName: "Վեբ",
        sourceType: "web",
        authority: 20,
        fullText: "text",
        fullTextVerified: true,
      }),
    ).toBe("SECONDARY_VERIFIED");
  });
  test("web snippet only = DISCOVERY_ONLY", () => {
    expect(
      evidenceGrade({ ...base, sourceId: "web", sourceName: "Վեբ", sourceType: "web", authority: 20 }),
    ).toBe("DISCOVERY_ONLY");
  });

  test("evidence pack carries grade + verification flags + documentRef (§46, §64)", () => {
    const pack = buildEvidencePack([
      {
        ...base,
        sourceId: "judiciary",
        sourceName: "ՎԴ",
        sourceType: "cassation",
        authority: 90,
        externalId: "999888",
        metadataVerified: true,
        fullTextVerified: false,
        accessState: "CAPTCHA_REQUIRED",
      },
    ]);
    expect(pack.length).toBe(1);
    expect(pack[0].grade).toBe("PRIMARY_METADATA");
    expect(pack[0].fullTextVerified).toBe(false);
    expect(pack[0].metadataVerified).toBe(true);
    expect(pack[0].accessState).toBe("CAPTCHA_REQUIRED");
    expect(pack[0].documentRef).toBe("judiciary:999888");
  });
});

// ---------------------------------------------------------------------------
// Access-state classification (§22-§23) — CAPTCHA is not "not found"
// ---------------------------------------------------------------------------

describe("datalex access states (§22-§23)", () => {
  test("fetchDocument without a solved session returns PARTIAL + CAPTCHA_REQUIRED", async () => {
    clearSession("datalex");
    const result: LegalSearchResult = {
      sourceId: "datalex",
      sourceName: "Datalex",
      sourceType: "case_law",
      authority: 75,
      title: "Գործ",
      url: "https://datalex.am/?app=AppCaseSearch&case_id=123",
      temporalStatus: "unknown",
      excerpt: "",
      relevance: 0,
      retrievedAt: new Date().toISOString(),
      externalId: "123",
    };
    const outcome = await datalexAdapter.fetchDocument!(result, {
      deadline: Date.now() + 3_000,
      sourceTimeoutMs: 2_000,
      documentTimeoutMs: 2_000,
      mode: "quick",
      requestId: "test",
    });
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.accessState).toBe("CAPTCHA_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Resume store (§64)
// ---------------------------------------------------------------------------

describe("resume store (§64)", () => {
  test("document reference parsing accepts datalex/judiciary refs only", () => {
    expect(parseDocumentRef("datalex:49258120924452013")?.source).toBe("datalex");
    expect(parseDocumentRef("judiciary:49258120924452013")?.source).toBe("judiciary");
    expect(parseDocumentRef("arlis:6")).toBeNull();
    expect(parseDocumentRef("datalex:")).toBeNull();
    expect(parseDocumentRef("javascript:alert(1)")).toBeNull();
  });

  test("token lifecycle with TTL + drop", () => {
    const t = createResumeToken({
      source: "datalex",
      caseExternalId: "12345",
      appName: "AppCaseSearch",
      canonicalUrl: "https://datalex.am/x",
      cookies: "PHPSESSID=zzz",
    });
    expect(getResumeToken(t.token)?.caseExternalId).toBe("12345");
    dropResumeToken(t.token);
    expect(getResumeToken(t.token)).toBeUndefined();
  });

  test("expired token is rejected", () => {
    const t = createResumeToken({
      source: "datalex",
      caseExternalId: "67890",
      appName: "AppCaseSearch",
      canonicalUrl: "https://datalex.am/y",
      cookies: "PHPSESSID=eee",
    });
    // force expiry
    const raw = getResumeToken(t.token);
    if (raw) (raw as { expiresAt: number }).expiresAt = Date.now() - 1;
    expect(getResumeToken(t.token)).toBeUndefined();
  });
});
