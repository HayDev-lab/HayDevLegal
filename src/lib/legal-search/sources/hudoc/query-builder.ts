// src/lib/legal-search/sources/hudoc/query-builder.ts
// HUDOC query builder (Phase 3 §7-§10).
//
// ONE place that knows how to build HUDOC queries — the native Solr-style
// filter chain AND the web-discovery search phrases. No other module may
// concatenate HUDOC search strings.
//
// LIVE-VERIFIED native contract (2026-09, from hudoc.echr.coe.int's own
// compiled.js + live probes):
//   GET /app/query/results
//     ?query=(contentsitename=ECHR) AND (appno="11275/07") AND (respondent="ARM")
//     &select=itemid,docname,doctype,appno,...&sort=importance%20Desc&start=0&length=N
//   - paragraph facets use DASH form: article="5-3" (NOT "5§3")
//   - free-text = unfielded terms appended to the chain
//   - response: {resultcount, results:[{itemid, columns:{...}}], message}

/** Normalized Convention article reference, e.g. "5", "5§3", "P1-1". */
export type ConventionArticle = string;

/**
 * Normalize the many ways users write Convention articles (§9):
 *   "Article 5", "article 5 § 3", "Art 5(3)", "Article 5 para 3",
 *   "5-րդ հոդված" (ECHR context), "P1-1", "Protocol 1 Article 1"
 * -> canonical "5" | "5§3" | "P1-1"
 */
export function normalizeConventionArticle(input: string): ConventionArticle | null {
  if (!input) return null;
  const s = input.trim();

  // Protocol articles: P1-1 / P4-2 / Protocol 1 Article 1
  const proto = s.match(/^P\s?(\d)\s?-\s?(\d+)$/i) ?? s.match(/^Protocol\s+(\d+)\s+Article\s+(\d+)$/i);
  if (proto) return `P${proto[1]}-${proto[2]}`;

  // Article with paragraph: Article 5 §3 / Art 5 para 3 / Article 5(3)
  const withPar = s.match(
    /^(?:Article|Art\.?|հոդված)\s*(\d{1,2})\s*(?:§|par(?:a|agraph)?\.?|\()\s*(\d{1,2})\)?$/i,
  );
  if (withPar) return `${withPar[1]}§${withPar[2]}`;

  // Plain article: Article 6 / Art 6 / 6-րդ հոդված (ECHR context only)
  const plain = s.match(/^(?:Article|Art\.?)\s*(\d{1,2})$/i) ?? s.match(/^(\d{1,2})(?:-րդ)?\s*հոդված$/i);
  if (plain) return plain[1];

  return null;
}

/** Convert a normalized article to the native facet form ("5§3" -> "5-3"). */
export function articleToFacet(article: ConventionArticle): string {
  return article.replace("§", "-");
}

/** Extract a Convention article reference from free text (first match). */
export function extractConventionArticle(text: string): ConventionArticle | null {
  if (!text) return null;
  const m = text.match(/\b(?:Article|Art\.)\s*(\d{1,2})\s*(?:§|para?\s*)?(\d{1,2})?/i)
    ?? text.match(/\bP(\d)-(\d+)\b/i);
  if (!m) return null;
  if (m[0].match(/^P/i)) return `P${m[1]}-${m[2]}`;
  return m[2] ? `${m[1]}§${m[2]}` : m[1];
}

/** A structured HUDOC query (§7). */
export type HudocQuery = {
  caseName?: string;
  applicationNumber?: string;
  respondent?: string;
  article?: ConventionArticle;
  /** Free-text keyword search (unfielded terms in the native query). */
  keyword?: string;
  documentType?: HudocDocumentTypeFilter;
  ecli?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type HudocDocumentTypeFilter =
  | "JUDGMENT"
  | "DECISION"
  | "GRAND_CHAMBER"
  | "COMMITTEE"
  | "COMMUNICATED_CASE"
  | "LEGAL_SUMMARY";

/** Validate an ECHR application number like "11275/07" or "12345/20". */
export function isApplicationNumber(s: string): boolean {
  return /^\d{4,5}\/\d{2}$/.test(s.trim());
}

/** Extract an application number from free text, if present. */
export function extractApplicationNumber(text: string): string | null {
  if (!text) return null;
  const m = text.match(/\b(\d{4,5}\/\d{2})\b/);
  return m ? m[1] : null;
}

/**
 * Build the native HUDOC Solr-style filter chain (the `query` parameter of
 * GET /app/query/results). Live-verified field forms:
 *   (contentsitename=ECHR) AND (appno="11275/07") AND (respondent="ARM")
 *   AND (article="5-3") AND <unfielded free-text terms>
 */
export class HudocQueryBuilder {
  private q: HudocQuery;

  constructor(query: HudocQuery = {}) {
    this.q = query;
  }

  static exactApplication(appNo: string): HudocQueryBuilder {
    return new HudocQueryBuilder({ applicationNumber: appNo.trim() });
  }

  static articleForRespondent(article: ConventionArticle, respondent = "ARM"): HudocQueryBuilder {
    return new HudocQueryBuilder({ article, respondent });
  }

  static keywordForRespondent(keyword: string, respondent?: string): HudocQueryBuilder {
    return new HudocQueryBuilder({ keyword, respondent });
  }

  /** The native filter chain. Empty string = match-all. */
  toApiFilter(): string {
    const parts: string[] = ["(contentsitename=ECHR)"];
    // Main search excludes press releases / old documents (per the site's own
    // DOCTYPE_QUERY_PREFIX, live-verified).
    if (this.q.documentType !== "LEGAL_SUMMARY") {
      parts.push("(NOT (doctype=PR OR doctype=HFCOMOLD OR doctype=HECOMOLD))");
    }
    if (this.q.applicationNumber) parts.push(`(appno="${this.q.applicationNumber}")`);
    if (this.q.respondent) parts.push(`(respondent="${this.q.respondent}")`);
    if (this.q.article) parts.push(`(article="${articleToFacet(this.q.article)}")`);
    if (this.q.ecli) parts.push(`(ecli="${this.q.ecli}")`);
    switch (this.q.documentType) {
      case "JUDGMENT":
        parts.push("(documentcollectionid2=JUDGMENT)");
        break;
      case "DECISION":
        parts.push("(documentcollectionid2=DECISION)");
        break;
      case "GRAND_CHAMBER":
        parts.push("(documentcollectionid2=GRANDCHAMBER)");
        break;
      case "COMMITTEE":
        parts.push("(documentcollectionid2=COMMITTEE)");
        break;
      case "COMMUNICATED_CASE":
        parts.push("(documentcollectionid2=COMMUNICATED)");
        break;
      case "LEGAL_SUMMARY":
        parts.push("(doctype=PR)");
        break;
      default:
        break;
    }
    // Free text: case name and keywords become unfielded terms (live-verified).
    const freeText = [this.q.caseName, this.q.keyword].filter(Boolean).join(" ").trim();
    if (freeText) parts.push(freeText);
    return parts.join(" AND ");
  }

  /**
   * Web-discovery search phrases (fallback ladder step: official-domain
   * Web discovery). Ordered by precision — exact identifiers first (§8).
   * Multiple variants: the web search backend is non-deterministic in what
   * it returns, so the client tries them SEQUENTIALLY until HUDOC
   * documents are found (live-verified behaviour).
   */
  toWebDiscoveryQueries(): Array<{ query: string; exact: boolean }> {
    const out: Array<{ query: string; exact: boolean }> = [];
    const respondent = this.q.respondent && this.q.respondent === "ARM" ? "Armenia" : this.q.respondent;

    // 1. Exact application number beats everything (§8).
    if (this.q.applicationNumber) {
      out.push({ query: `hudoc.echr.coe.int "${this.q.applicationNumber}"`, exact: true });
      out.push({ query: `"${this.q.applicationNumber}" ECHR ${respondent ?? "Armenia"} judgment`, exact: true });
      out.push({ query: `ECHR application "${this.q.applicationNumber}" hudoc`, exact: true });
      return out;
    }

    // 2. Exact case name.
    if (this.q.caseName) {
      out.push({ query: `hudoc.echr.coe.int "${this.q.caseName}"`, exact: true });
      out.push({ query: `"${this.q.caseName}" ECHR judgment`, exact: true });
    }

    // 3. ECLI.
    if (this.q.ecli) {
      out.push({ query: `"${this.q.ecli}"`, exact: true });
    }

    // 4. Article + respondent semantic search (§9-§10).
    if (this.q.article) {
      const articleText = this.q.article.startsWith("P")
        ? this.q.article.replace("-", " Article ")
        : `Article ${this.q.article.replace("§", " §")}`;
      out.push({ query: `hudoc.echr.coe.int ${articleText} ${respondent ?? "Armenia"}`, exact: false });
      out.push({ query: `"${articleText}" ${respondent ?? "Armenia"} ECHR judgment`, exact: false });
      out.push({ query: `ECHR ${articleText} violation ${respondent ?? "Armenia"} case law`, exact: false });
    }

    // 5. Keyword + respondent.
    if (this.q.keyword) {
      out.push({ query: `hudoc.echr.coe.int ${this.q.keyword} ${respondent ?? "Armenia"}`, exact: false });
      out.push({ query: `ECHR ${this.q.keyword} ${respondent ?? "Armenia"} judgment hudoc`, exact: false });
    }

    if (out.length === 0 && respondent) {
      out.push({ query: `hudoc.echr.coe.int ${respondent}`, exact: false });
    }
    return out.slice(0, 3);
  }
}
