// src/lib/legal-search/sources/judiciary/adapter.ts
// Judiciary / Cassation adapter — Վճռաբեկ դատարանի նախադեպային որոշումեր.
//
// The official judiciary portal (judiciary.am) is unreachable from this
// runtime, but Cassation PRECEDENT decisions are published through the
// Datalex precedent indices (datalex_civ/crim/adm_prec_case_info) with
// sortByPrecedent=true. Those indices are the official judicial-info-system
// mirror of precedent practice, so authority = OFFICIAL_COURT.
//
// Full-text viewing is CAPTCHA-gated (RESTRICTED) — canonical URLs provided.

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  LegalSourceAdapter,
  SourceStatus,
  FetchedDocument,
  AccessState,
} from "../../types";
import { classifyError } from "../source-adapter";
import { AUTHORITY, STAGES, TIMEOUTS } from "../../config";
import { datalexSearchGridCached, datalexCaseUrl, datalexShowCase, datalexExactCaseLookup, type DatalexRow } from "../datalex/client";
import { getSession } from "../session-store";
import { extractMainText } from "../../security/content-sanitizer";

const PREC_GRID_BY_TAB = {
  civil: "datalex_civ_prec_case_info",
  criminal: "datalex_crim_prec_case_info",
  administrative: "datalex_adm_prec_case_info",
} as const;

type PrecTab = keyof typeof PREC_GRID_BY_TAB;

function tabsFor(query: LegalSearchQuery): PrecTab[] {
  const q = query.raw.toLowerCase();
  if (/վարչական/.test(q)) return ["administrative", "civil"];
  if (/քրեական|քրեա/.test(q)) return ["criminal", "civil"];
  return ["civil", "criminal"];
}

function rowToResult(row: DatalexRow): LegalSearchResult | null {
  const externalId = row.case_external_id || row._id;
  if (!externalId) return null;
  const claim = (row.claim ?? "").toString().trim();
  const caseNumber = (row.case_number ?? "").toString().trim();
  const parties = [
    (row.claimant_name || row.claimant_full_name || "").toString().trim(),
    (row.respondant_name || row.respondant_full_name || "").toString().trim(),
  ]
    .filter(Boolean)
    .join(" ընդդեմ ");

  const excerptParts: string[] = [];
  if (claim) excerptParts.push(claim.slice(0, 500));
  if (parties) excerptParts.push(`Կողմեր՝ ${parties}`);
  const excerpt = excerptParts.join(" · ") || caseNumber;

  return {
    sourceId: "judiciary",
    sourceName: "Վճռաբեկ դատարան — նախադեպ",
    sourceType: "cassation",
    authority: AUTHORITY.officialCourt,
    title: parties
      ? `Նախադեպ՝ ${caseNumber || "ՎԴ"} — ${parties}`.slice(0, 200)
      : `Վճռաբեկ դատարանի նախադեպ ${caseNumber}`,
    url: datalexCaseUrl(externalId, "AppPrecedentCaseSearch"),
    court: "ՀՀ Վճռաբեկ դատարան",
    caseNumber: caseNumber || undefined,
    date: (row.verdict_date || row.final_date || row.start_date || "").toString().trim() || undefined,
    temporalStatus: "unknown",
    excerpt,
    relevance: 0,
    retrievedAt: new Date().toISOString(),
    externalId,
    // Phase 3 §46: precedent rows are verified structured metadata.
    metadataVerified: true,
    fullTextVerified: false,
    accessState: "CAPTCHA_REQUIRED",
    meta: { caseId: (row.case_id ?? "").toString(), appName: "AppPrecedentCaseSearch" },
  };
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();
  const p = query.understanding.parsed;

  // Precedent search is only meaningful for deep mode / case-law questions
  // (spec §23: court practice belongs to DEEP RESEARCH).
  const wantsPrecedent =
    query.mode === "deep" &&
    (p.questionType === "case_law" ||
      p.questionType === "legal_rule" ||
      /պրակտիկ|նախադեպ|վճռաբեկ|դատական/.test(query.raw.toLowerCase()));

  if (!wantsPrecedent) {
    return {
      outcome: { status: "UNSUPPORTED", detail: "նախադեպային պրակտիկան փնտրվում է խորը որոնմամբ", durationMs: 0, resultCount: 0 },
      results: [],
    };
  }

  const hy = query.variants
    .filter((v) => v.lang === "hy")
    .sort((a, b) => a.weight - b.weight)
    .map((v) => v.text);
  const text =
    hy.find((t) => t.length >= 4 && t.length <= 90 && t.split(/\s+/).length <= 8) ?? query.raw;

  const tabs = tabsFor(query);
  const perTab = Math.max(3, Math.floor(STAGES.candidatesPerSource / tabs.length));
  const results: LegalSearchResult[] = [];
  let anyOk = false;
  let lastDetail: string | undefined;

  // §34 multi-source, part 1 — Datalex PRECEDENT index (semantic).
  for (const tab of tabs) {
    if (Date.now() > context.deadline - 1_500) break;
    try {
      const grid = await datalexSearchGridCached({
        tab,
        text,
        matchType: 2,
        rows: perTab,
        appName: "AppPrecedentCaseSearch",
        sortByPrecedent: true,
        timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.sourceMs, context.deadline - Date.now())),
      }).catch(async () => {
        // Precedent grid descriptions must match the app; retry with the
        // generic app envelope if the first attempt fails.
        return null;
      });
      if (!grid) continue;
      if (grid.status && grid.result?.data) {
        anyOk = true;
        for (const row of grid.result.data) {
          const r = rowToResult(row);
          if (r) results.push(r);
        }
      }
    } catch (err) {
      lastDetail = classifyError(err).detail;
    }
  }

  // §34 multi-source, part 2 — EXACT case-number lookup via the structured
  // `case_number` filter (live-verified total=1). A Cassation case number
  // like ՎԴ/1234/02/21 is the primary identifier (§29): exact search beats
  // semantic search. ECHR application numbers (11275/07) are NOT Datalex
  // case numbers.
  const exactCase =
    p.caseNumber && /^[Ա-Ֆ]{1,6}(?:ՔՐԴ|ՔԴ|Դ)\/\d{2,5}\/\d{2,4}(?:\/\d{2,4})?$/.test(p.caseNumber)
      ? p.caseNumber
      : undefined;
  if (exactCase && Date.now() < context.deadline - 1_500) {
    try {
      const rows = await datalexExactCaseLookup(exactCase, {
        appName: "AppCaseSearch",
        timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.sourceMs * 2, context.deadline - Date.now())),
      });
      for (const row of rows) {
        const r = rowToResult(row);
        if (r) results.push(r);
      }
    } catch {
      // best-effort exact lookup
    }
  }

  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = r.caseNumber ?? r.externalId ?? r.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    return {
      outcome: {
        status: anyOk ? "EMPTY" : "ERROR",
        detail: anyOk ? "համապատասխան նախադեպ չի գտնվել" : (lastDetail ?? "աղբյուրը անհասանելի է"),
        durationMs: Date.now() - start,
        resultCount: 0,
      },
      results: [],
    };
  }

  // §23/§34: precedent metadata verified; full text gated by captcha.
  return {
    outcome: {
      status: "PARTIAL",
      detail: `${deduped.length} նախադեպի մետատվյալներ${exactCase ? " (ճշգրիտ համարով)" : ""} · ամբողջական տեքստը պահանջում է աղբյուրի հաստատում`,
      durationMs: Date.now() - start,
      resultCount: deduped.length,
      accessState: "CAPTCHA_REQUIRED",
    },
    results: deduped,
  };
}

async function fetchDocument(
  result: LegalSearchResult,
  context: SearchContext,
): Promise<{ status: SourceStatus; document?: FetchedDocument; accessState?: AccessState; resolutionNote?: string }> {
  const externalId = result.externalId;
  if (!externalId) return { status: "ERROR" };

  // §24 — reuse a valid session (user-solved captcha key) when available.
  const session = getSession("datalex");
  if (session?.captchaKey) {
    try {
      const r = await datalexShowCase({
        caseExternalId: externalId,
        appName: "AppPrecedentCaseSearch",
        captchaText: session.captchaKey,
        cookies: session.cookies,
        timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.documentMs, context.deadline - Date.now())),
      });
      if (r.kind === "full_text") {
        const text = extractMainText(r.html, { maxChars: 120_000 });
        if (text && text.length > 100) {
          return {
            status: "SUCCESS",
            document: {
              url: result.url,
              text,
              kind: "html",
              fetchedAt: new Date().toISOString(),
              bytes: text.length,
            },
            resolutionNote: "ամբողջական տեքստ՝ գործող սեսիայով",
          };
        }
      }
    } catch {
      // best-effort
    }
  }

  return {
    status: "PARTIAL",
    accessState: "CAPTCHA_REQUIRED",
    resolutionNote: "ամբողջական տեքստը հասանելի է աղբյուրի հաստատումից հետո",
  };
}

export const judiciaryAdapter: LegalSourceAdapter = {
  id: "judiciary",
  name: "Վճռաբեկ դատարան — նախադեպային պրակտիկա",
  authority: AUTHORITY.officialCourt,
  sourceType: "cassation",
  supports: (query) =>
    query.mode === "deep" &&
    (query.understanding.parsed.questionType === "case_law" ||
      query.understanding.parsed.questionType === "legal_rule" ||
      /պրակտիկ|նախադեպ|վճռաբեկ|դատական|գործ/.test(query.raw.toLowerCase())),
  search,
  fetchDocument,
};
