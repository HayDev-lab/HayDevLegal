// src/lib/legal-search/sources/datalex/adapter.ts
// Datalex source adapter — Armenian judicial information system (datalex.am).
//
// Provides live case-law search: civil / criminal / administrative /
// bankruptcy instances. Returns REAL case metadata: case number, parties,
// claim, judge, dates, and the canonical URL the user can open to read
// the full act (behind Datalex's public CAPTCHA — which we never bypass).
//
// supports(): case-law questions. For legislation ARLIS wins by authority;
// Datalex law search is an ARLIS proxy, so we skip it to avoid duplicates.

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
import { datalexSearchGridCached, datalexCaseUrl, datalexShowCase, datalexExactCaseLookup, type DatalexRow, type CaseTab } from "./client";
import { getSession } from "../session-store";
import { extractMainText } from "../../security/content-sanitizer";

/** Which tabs to search for a query. */
function tabsFor(query: LegalSearchQuery): CaseTab[] {
  const p = query.understanding.parsed;
  const q = query.raw.toLowerCase();
  if (/սնանկ|bankrupt/.test(q)) return ["bankruptcy"];
  if (/վարչական|administrative/.test(q) || p.actTitle?.includes("վարչական")) {
    return ["administrative", "civil"];
  }
  if (/քրեական|քրեա|criminal/.test(q) || p.actTitle?.includes("քրեական")) {
    return ["criminal", "civil"];
  }
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
  if (row.judge_name) excerptParts.push(`Դատավոր՝ ${row.judge_name}`);
  const excerpt = excerptParts.join(" · ") || caseNumber;

  return {
    sourceId: "datalex",
    sourceName: "Datalex",
    sourceType: "case_law",
    authority: AUTHORITY.reputableLegalDatabase,
    title: parties ? `${caseNumber || "Դատական գործ"} — ${parties}`.slice(0, 200) : `Դատական գործ ${caseNumber}`,
    url: datalexCaseUrl(externalId),
    court: (row.court_name || row.instance_name || "").toString().trim() || undefined,
    caseNumber: caseNumber || undefined,
    date: (row.verdict_date || row.final_date || row.start_date || "").toString().trim() || undefined,
    temporalStatus: "unknown",
    excerpt,
    relevance: 0,
    retrievedAt: new Date().toISOString(),
    externalId,
    // Phase 3 §46: grid rows ARE verified structured metadata from the source.
    metadataVerified: true,
    fullTextVerified: false,
    accessState: "CAPTCHA_REQUIRED",
    meta: {
      caseId: (row.case_id ?? "").toString(),
      security: (row.case_security ?? "").toString(),
      appName: "AppCaseSearch",
    },
  };
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();

  // Case-law intent or explicit case number -> Datalex is highly relevant.
  // Otherwise use it only when the question smells like practice/dispute.
  const p = query.understanding.parsed;
  const wantsCases =
    !!p.caseNumber ||
    p.questionType === "case_law" ||
    /գործ|պրակտիկ|նախադեպ|դատարան|վճիռ|որոշում|դատական/.test(query.raw.toLowerCase());

  if (!wantsCases) {
    return {
      outcome: { status: "UNSUPPORTED", detail: "հարցը վերաբերում է օրենսդրությանը", durationMs: 0, resultCount: 0 },
      results: [],
    };
  }

  // Choose the best search text: exact case number wins (spec §10);
  // otherwise the strongest Armenian variant. ECHR application numbers
  // (11275/07) are not Datalex case numbers — skip the exact mode for them.
  const wantsExactCase =
    !!p.caseNumber && /^[Ա-Ֆ]{1,6}(?:ՔՐԴ|ՔԴ|Դ)\/\d{2,5}\/\d{2,4}(?:\/\d{2,4})?$/.test(p.caseNumber);
  let text: string | undefined;
  if (wantsExactCase) {
    text = p.caseNumber;
  } else {
    const hy = query.variants
      .filter((v) => v.lang === "hy")
      .sort((a, b) => a.weight - b.weight)
      .map((v) => v.text);
    // Prefer concept variants (shorter, keyword-like) over the raw question.
    text = hy.find((t) => t.length >= 4 && t.length <= 90 && t.split(/\s+/).length <= 8) ?? query.raw;
  }

  const tabs = tabsFor(query);
  const perTab = Math.max(3, Math.floor(STAGES.candidatesPerSource / tabs.length));
  const results: LegalSearchResult[] = [];
  let anyOk = false;
  let lastDetail: string | undefined;

  // §29 — EXACT case-number lookup via the structured filter (total=1 for
  // existing numbers, live-verified). Skipped for ECHR appnos.
  if (wantsExactCase && p.caseNumber && Date.now() < context.deadline - 1_500) {
    try {
      const rows = await datalexExactCaseLookup(p.caseNumber, {
        timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.sourceMs * 2, context.deadline - Date.now())),
      });
      for (const row of rows) {
        const r = rowToResult(row);
        if (r) results.push(r);
      }
    } catch {
      // best-effort; fall through to semantic search
    }
  }

  for (const tab of tabs) {
    if (Date.now() > context.deadline - 1_500) break;
    try {
      const grid = await datalexSearchGridCached({
        tab,
        text,
        matchType: 2,
        rows: perTab,
        timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.sourceMs, context.deadline - Date.now())),
      });
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

  // Dedup by case number within this source.
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
        detail: anyOk ? "համապատասխան գործ չի գտնվել" : (lastDetail ?? "Datalex-ը անհասանելի է"),
        durationMs: Date.now() - start,
        resultCount: 0,
      },
      results: [],
    };
  }

  // §23: the case EXISTS, its metadata is real, the canonical URL works in
  // the user's browser — only the full-text view is captcha-gated. PARTIAL.
  return {
    outcome: {
      status: "PARTIAL",
      detail: `${deduped.length} գործի մետատվյալներ · ամբողջական տեքստը պահանջում է աղբյուրի հաստատում`,
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
  const appName = String(result.meta?.appName ?? "AppCaseSearch");

  // §24 — reuse a VALID session when the app already has one (a previously
  // user-solved captcha key). This is the only server-side path to the text.
  const session = getSession("datalex");
  if (session?.captchaKey) {
    try {
      const r = await datalexShowCase({
        caseExternalId: externalId,
        appName,
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
      // captcha_required here = the stored key expired; fall through.
    } catch {
      // best-effort; fall through to the honest gated state
    }
  }

  // No valid session: the full text is CAPTCHA-gated. The case EXISTS —
  // metadata + canonical URL remain valid (§23). We never bypass the gate;
  // the interactive resume flow (§25/§63-§64) can unlock it later.
  return {
    status: "PARTIAL",
    accessState: "CAPTCHA_REQUIRED",
    resolutionNote: "ամբողջական տեքստը հասանելի է աղբյուրի հաստատումից հետո",
  };
}

export const datalexAdapter: LegalSourceAdapter = {
  id: "datalex",
  name: "Datalex — դատական գործեր",
  authority: AUTHORITY.reputableLegalDatabase,
  sourceType: "case_law",
  supports: (query) => {
    const p = query.understanding.parsed;
    return (
      !!p.caseNumber ||
      p.questionType === "case_law" ||
      /գործ|պրակտիկ|նախադեպ|դատարան|վճիռ|որոշում|դատական|սնանկ/.test(query.raw.toLowerCase())
    );
  },
  search,
  fetchDocument,
};
