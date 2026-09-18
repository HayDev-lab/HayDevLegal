// src/lib/local-laws/adapter.ts
// Local-laws adapter — serves the CURATED local corpus (legal-data/am/, a
// provenance-tracked ARLIS snapshot) behind the federated LegalSourceAdapter
// contract. Zero network calls: the texts are already on disk, which is why
// this source participates in QUICK mode (fast baseline answer).
//
// Honesty rules (spec §6-§7):
//   - Every result carries the ARLIS canonicalUrl + retrievedAt snapshot date,
//     so date-sensitive answers can (and should) cross-check the live source.
//   - fullTextVerified is TRUE in the narrow sense that the text comes from
//     the verified snapshot — the evidence grade stays PRIMARY_VERIFIED and
//     meta.snapshot=arlis marks the provenance for downstream caveats.

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  FetchedDocument,
  LegalSourceAdapter,
  SourceStatus,
} from "@/lib/legal-search/types";
import { AUTHORITY, STAGES } from "@/lib/legal-search/config";
import { contentHash } from "@/lib/legal-search/security/url-policy";
import type { LocalLawAct } from "./loader";
import { loadLocalCorpus } from "./loader";
import { searchLocalLaws, type LocalLawMatch } from "./search";

const SOURCE_ID = "local-laws";
const SOURCE_NAME = "Տեղական օրենսդրություն (ARLIS պահեստ)";

function matchToResult(m: LocalLawMatch): LegalSearchResult {
  const { act, article } = m;
  const isPreface = article.num === "0";
  const articleLabel = isPreface ? "Նախաբան" : `հոդված ${article.num}`;
  const titleParts = [act.shortTitle, articleLabel];
  if (article.title && article.title.length <= 90) titleParts.push(article.title);

  const excerpt = article.excerpt || article.body.slice(0, 300);

  return {
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    sourceType: "local_laws",
    authority: AUTHORITY.localCuratedLaws,

    title: titleParts.join(", "),
    url: act.canonicalUrl,

    actNumber: act.actNumber,
    article: isPreface ? undefined : article.num,

    status: act.status,
    temporalStatus: "current", // snapshot was taken from the Գործում է card

    excerpt,
    fullText: isPreface
      ? `${act.title}\n\n${article.body}`
      : `Հոդված ${article.num}${article.title ? ` ${article.title}` : ""}\n\n${article.body}`,

    // The text IS in hand (local snapshot); metadata came from the verified
    // ARLIS act card. Provenance + snapshot date travel in meta.
    metadataVerified: true,
    fullTextVerified: true,
    resolvedVia: "DIRECT_HTML",

    relevance: m.relevance,
    retrievedAt: act.retrievedAt ?? new Date().toISOString(),
    contentHash: contentHash(`${act.actId}#${article.num}:${article.body.slice(0, 2000)}`),

    externalId: `${act.actId}#${article.num}`,
    meta: {
      snapshot: "arlis",
      snapshotRetrievedAt: act.retrievedAt ?? "",
      actId: act.actId,
      corpusCategory: act.category,
      matchedVia: m.signals.join("+").slice(0, 80),
    },
  };
}

async function search(
  query: LegalSearchQuery,
  _context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();
  try {
    const corpus = await loadLocalCorpus();
    if (corpus.acts.length === 0) {
      return {
        outcome: {
          status: "EMPTY",
          detail: "տեղական օրենսդրական բազան հասանելի չէ",
          durationMs: Date.now() - start,
          resultCount: 0,
        },
        results: [],
      };
    }

    const matches = await searchLocalLaws(query, STAGES.candidatesPerSource);
    if (matches.length === 0) {
      return {
        outcome: {
          status: "EMPTY",
          detail: "տեղական բազայում համապատասխան հոդված չի գտնվել",
          durationMs: Date.now() - start,
          resultCount: 0,
        },
        results: [],
      };
    }

    return {
      outcome: {
        status: "SUCCESS",
        durationMs: Date.now() - start,
        resultCount: matches.length,
      },
      results: matches.map(matchToResult),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: {
        status: "ERROR",
        detail: `տեղական բազայի սխալ՝ ${msg.slice(0, 120)}`,
        durationMs: Date.now() - start,
        resultCount: 0,
      },
      results: [],
    };
  }
}

async function fetchDocument(
  result: LegalSearchResult,
  _context: SearchContext,
): Promise<{ status: SourceStatus; document?: FetchedDocument; resolutionNote?: string }> {
  try {
    const corpus = await loadLocalCorpus();
    if (corpus.acts.length === 0) return { status: "EMPTY" };

    // Resolve the act: by externalId, then by meta.actId, then by canonical URL.
    let act: LocalLawAct | undefined;
    const extActId = result.externalId?.split("#")[0];
    if (extActId) act = corpus.acts.find((a) => a.actId === extActId);
    const metaActId = result.meta?.actId;
    if (!act && metaActId !== undefined) {
      act = corpus.acts.find((a) => a.actId === String(metaActId));
    }
    if (!act && result.url) {
      act = corpus.acts.find((a) => a.canonicalUrl === result.url);
    }
    if (!act) return { status: "EMPTY" };

    const num = result.externalId?.split("#")[1] ?? result.article;
    const article = num ? act.byNum.get(num) : undefined;
    const text = article
      ? article.num === "0"
        ? `${act.title}\n\n${article.body}`
        : `Հոդված ${article.num}${article.title ? ` ${article.title}` : ""}\n\n${article.body}`
      : [act.title, ...act.articles.filter((x) => x.num !== "0").slice(0, 5).map((x) => `Հոդված ${x.num} ${x.title}`)].join("\n");

    if (!text) return { status: "EMPTY" };
    return {
      status: "SUCCESS",
      document: {
        url: act.canonicalUrl,
        text,
        kind: "text",
        fetchedAt: new Date().toISOString(),
        bytes: text.length,
      },
      resolutionNote: "ամբողջական տեքստը տեղական պահեստից (ARLIS պահեստավորում)",
    };
  } catch {
    return { status: "ERROR" };
  }
}

export const localLawsAdapter: LegalSourceAdapter = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  authority: AUTHORITY.localCuratedLaws,
  sourceType: "local_laws",
  supports: () => true, // local + fast: always worth consulting, scoring decides
  search,
  fetchDocument,
};
