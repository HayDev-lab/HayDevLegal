// src/lib/legal-search/sources/datalex/client.ts
// Low-level RPC client for Datalex (datalex.am) — the Armenian judicial
// information system, Elasticsearch-backed.
//
// Transport contract (reverse-engineered from Datalex's own frontend):
//  1. GET /?app=AppCaseSearch  -> PHPSESSID session cookie
//  2. POST /json.php  form-urlencoded RPC envelope:
//       appName, appPage, moduleID=Common/ModGrid, class="",
//       function=getGridDataList, name=Common/ModGrid, type=modules,
//       arg=[<filterData>, <jqGrid postData>, <gridSearchDescription>, <sortByPrecedent>]
//  3. Response: {status, result:{data:[row...], totalCount, totalPages, page}, ...}
//
//  CASE VIEWING (Phase 3, verified live):
//  4. POST /json.php with moduleID=ModCaseViewer, function=showCase,
//     arg=["<captchaText>"], module_params={caseID, showMainInfo, ...}
//     -> {status:true, result:{html:"<case HTML>"} | false,
//         system_note:[{params:{errorType:"captcha"}}]}
//     `result:false` + errorType:"captcha"  =>  CAPTCHA_REQUIRED (§22-§23).
//     The captcha image is served per-session from
//     /file.php?show_captcha=1&...&section_name=userRegKey
//     and can be proxied to the user for the interactive flow (§25).
//
// We do NOT bypass CAPTCHA, authentication, or rate limits — the only path
// to a full case text is a captcha solution provided by a human user.

import { POLICY } from "../../config";
import { fetchGuarded } from "../../security/url-policy";
import { getSession, setSession, updateSession } from "../session-store";

const DATALEX_BASE = "https://datalex.am";
const RPC_URL = `${DATALEX_BASE}/json.php`;

export type DatalexRow = {
  _id?: string;
  case_id?: string;
  case_external_id?: string;
  case_number?: string;
  claim?: string;
  claimant_name?: string;
  claimant_full_name?: string;
  respondant_name?: string;
  respondant_full_name?: string;
  judge_name?: string;
  court_name?: string;
  instance_name?: string;
  start_date?: string;
  verdict_date?: string;
  final_date?: string;
  case_security?: string;
  is_precedent?: string | number | boolean;
  [k: string]: unknown;
};

export type DatalexGrid = {
  status: boolean;
  result?: {
    data?: DatalexRow[];
    page?: number;
    totalPages?: number;
    totalCount?: number;
  };
  error_page?: string;
};

/** Case-type tab -> grid search description. */
export const GRID_BY_TAB = {
  civil: "datalex_civ_case_info",
  criminal: "datalex_crim_case_info",
  administrative: "datalex_adm_case_info",
  bankruptcy: "datalex_bankr_case_info",
} as const;

export type CaseTab = keyof typeof GRID_BY_TAB;

/** Session state (single shared PHPSESSID, refreshed lazily). */
let sessionCookie: { value: string; fetchedAt: number } | null = null;
const SESSION_TTL_MS = 20 * 60 * 1000;

async function ensureSession(timeoutMs: number): Promise<string> {
  if (sessionCookie && Date.now() - sessionCookie.fetchedAt < SESSION_TTL_MS) {
    return sessionCookie.value;
  }
  const res = await fetchGuarded(`${DATALEX_BASE}/?app=AppCaseSearch`, {
    timeoutMs,
    headers: { "User-Agent": POLICY.userAgent, Accept: "text/html" },
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/PHPSESSID=([^;]+)/i);
  if (!m) throw new Error("Datalex session bootstrap failed (no PHPSESSID)");
  sessionCookie = { value: m[1], fetchedAt: Date.now() };
  // Mirror the shared search session into the bounded session store (§26)
  // so document resolution can reuse it (§24). This is the GLOBAL_PUBLIC
  // anonymous bootstrap — no CAPTCHA, no user binding — so it stays on the
  // legacy global bucket (Phase 4.1 §13-§14).
  setSession({
    source: "datalex",
    scope: "GLOBAL_PUBLIC",
    cookies: `PHPSESSID=${m[1]}`,
    createdAt: Date.now(),
  });
  return m[1];
}

/**
 * Bootstrap a DEDICATED Datalex session (own PHPSESSID) — used by the
 * interactive CAPTCHA flow so concurrent users never share one challenge.
 */
export async function bootstrapDatalexSession(
  timeoutMs: number,
): Promise<{ cookies: string }> {
  const res = await fetchGuarded(`${DATALEX_BASE}/?app=AppCaseSearch`, {
    timeoutMs,
    headers: { "User-Agent": POLICY.userAgent, Accept: "text/html" },
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/PHPSESSID=([^;]+)/i);
  if (!m) throw new Error("Datalex session bootstrap failed (no PHPSESSID)");
  return { cookies: `PHPSESSID=${m[1]}` };
}

/** CAPTCHA image URL for a session (§25 — proxied to the user, never solved by us). */
export function datalexCaptchaImageUrl(): string {
  return (
    `${DATALEX_BASE}/file.php?show_captcha=1&width=200&height=60` +
    `&font_size=20&let_amount=5&bg_img_path=default.jpg&section_name=userRegKey`
  );
}

export type DatalexSearchOpts = {
  tab: CaseTab;
  /** Full-text verdict query (semantic search). Optional for exact lookups. */
  text?: string;
  /** 1=root, 2=all words, 3=any word, 4=exclude, 5=exact. */
  matchType?: 1 | 2 | 3 | 5;
  /**
   * EXACT case-number lookup (§29): uses the structured `case_number`
   * filter — live-verified total=1 for existing numbers. Wins over text.
   */
  caseNumber?: string;
  page?: number;
  rows?: number;
  appName?: string;
  sortByPrecedent?: boolean;
  timeoutMs: number;
};

/**
 * Run one Datalex grid search. Throws on transport errors — the adapter
 * maps them to statuses.
 *
 * LIVE-VERIFIED contract (2026-09): the RPC filter must be a NESTED object
 *   {verdict: {value: [text], type: [matchType]}}
 * or a structured field
 *   {case_number: "ՎԴ/0008/05/23"}
 * The old flat form (data[verdict][value][]) is silently IGNORED by the
 * current backend — every query returned the same default listing.
 */
export async function datalexSearchGrid(opts: DatalexSearchOpts): Promise<DatalexGrid> {
  const phpsessid = await ensureSession(opts.timeoutMs);

  // Nested filter (live-verified; see comment above).
  const filterData: Record<string, unknown> = opts.caseNumber
    ? { case_number: opts.caseNumber }
    : {
        verdict: {
          value: [opts.text],
          type: [String(opts.matchType ?? 2)],
        },
      };
  const postData = { page: opts.page ?? 1, rows: opts.rows ?? 10, sidx: "", sord: "desc" };
  const gridDesc = GRID_BY_TAB[opts.tab];
  const arg = JSON.stringify([filterData, postData, gridDesc, !!opts.sortByPrecedent]);
  const moduleParams = JSON.stringify({
    gridSearchDescription: gridDesc,
    filterParams: [],
    sortByPrecedent: !!opts.sortByPrecedent,
    moduleID: "Common/ModGrid",
    viewID: "common-mod-grid",
  });

  const body = new URLSearchParams({
    appName: opts.appName ?? "AppCaseSearch",
    appPage: "default",
    moduleID: "Common/ModGrid",
    class: "",
    function: "getGridDataList",
    name: "Common/ModGrid",
    type: "modules",
    dataType: "json",
    arg,
    module_params: moduleParams,
  });

  const res = await fetchGuarded(RPC_URL, {
    method: "POST",
    timeoutMs: opts.timeoutMs,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      Cookie: `PHPSESSID=${phpsessid}`,
      "User-Agent": POLICY.userAgent,
      Referer: `${DATALEX_BASE}/?app=${opts.appName ?? "AppCaseSearch"}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Datalex HTTP ${res.status}`);
  // NOTE: Datalex serves JSON bodies with a text/html content-type header.
  // Parse the body as JSON directly and validate the shape instead.
  const text = await res.text();
  let data: DatalexGrid;
  try {
    data = JSON.parse(text) as DatalexGrid;
  } catch {
    throw new Error(`Datalex non-JSON response (${text.slice(0, 80)})`);
  }
  if (typeof data.status !== "boolean") throw new Error("Datalex malformed RPC response");
  if (data.error_page) throw new Error(`Datalex error page: ${data.error_page}`);
  return data;
}

/**
 * Exact case-number lookup across ALL case grids (§29).
 * Live-verified: the structured `case_number` filter returns total=1 for an
 * existing number and 0 for a nonexistent one — a true exact match.
 */
export async function datalexExactCaseLookup(
  caseNumber: string,
  opts: { appName?: string; timeoutMs: number; rows?: number },
): Promise<DatalexRow[]> {
  const tabs: CaseTab[] = ["civil", "criminal", "administrative", "bankruptcy"];
  const out: DatalexRow[] = [];
  for (const tab of tabs) {
    try {
      const grid = await datalexSearchGridCached({
        tab,
        caseNumber,
        rows: opts.rows ?? 2,
        appName: opts.appName,
        timeoutMs: opts.timeoutMs,
      });
      if (grid.status && grid.result?.data) {
        for (const row of grid.result.data) {
          if ((row.case_number ?? "").toString().trim() === caseNumber.trim()) {
            out.push(row);
          }
        }
      }
    } catch {
      // best-effort per grid
    }
    if (out.length > 0) break; // found in this grid — no need to check others
  }
  return out;
}

// ---------------------------------------------------------------------------
// showCase — full case document via the CAPTCHA-gated viewer (Phase 3)
// ---------------------------------------------------------------------------

export type DatalexShowCaseResult =
  | { kind: "full_text"; html: string }
  | { kind: "captcha_required" }
  | { kind: "not_found" }
  | { kind: "error"; detail: string };

type ShowCaseResponse = {
  status?: boolean;
  result?: { html?: string } | false | null;
  system_note?: Array<{ params?: { errorType?: string } }>;
  error_page?: string;
};

/**
 * Fetch the FULL case document through Datalex's ModCaseViewer.showCase RPC.
 *
 * The captchaText is either a fresh user solution (interactive flow, §25)
 * or a previously accepted session key reused via the session store (§24).
 * We NEVER attempt to solve the captcha ourselves.
 */
export async function datalexShowCase(opts: {
  caseExternalId: string;
  appName?: string;
  captchaText?: string;
  /** Dedicated session cookies (interactive flow); defaults to shared session. */
  cookies?: string;
  timeoutMs: number;
  /**
   * Phase 4.1 §13-§14 — when provided, a SOLVED captcha is stored under
   * USER_SESSION scope with this key (per-request/per-user session id),
   * never on the shared global bucket. The interactive /api/resolve flow
   * passes a fresh crypto.randomUUID() here so concurrent users never
   * share a solved-CAPTCHA session.
   */
  sessionId?: string;
}): Promise<DatalexShowCaseResult> {
  const appName = opts.appName ?? "AppCaseSearch";
  const cookie =
    opts.cookies ??
    (getSession("datalex", "GLOBAL_PUBLIC")?.cookies ?? `PHPSESSID=${await ensureSession(opts.timeoutMs)}`);

  const moduleParams = JSON.stringify({
    showHeaderBox: true,
    caseID: opts.caseExternalId,
    caseNumber: "",
    caseTypeID: null,
    searchDescription: null,
    showMainInfo: true,
    parentModuleID: "ModCaseSearch",
    moduleID: "ModCaseViewer",
    viewID: "mod-case-viewer",
    currIndex: 0,
    identName: null,
    hasError: false,
    useScrollToErrorField: true,
  });

  const body = new URLSearchParams({
    appName,
    appPage: "default",
    moduleID: "ModCaseViewer",
    moduleUsedIDs: "ModCaseViewer,ModCaptcha",
    class: "",
    function: "showCase",
    name: "ModCaseViewer",
    type: "modules",
    dataType: "json",
    arg: JSON.stringify([opts.captchaText ?? ""]),
    module_params: moduleParams,
  });

  const res = await fetchGuarded(RPC_URL, {
    method: "POST",
    timeoutMs: opts.timeoutMs,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      Cookie: cookie,
      "User-Agent": POLICY.userAgent,
      Referer: `${DATALEX_BASE}/?app=${appName}&case_id=${encodeURIComponent(opts.caseExternalId)}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Datalex HTTP ${res.status}`);

  const text = await res.text();
  let data: ShowCaseResponse;
  try {
    data = JSON.parse(text) as ShowCaseResponse;
  } catch {
    return { kind: "error", detail: `non-JSON response (${text.slice(0, 80)})` };
  }

  if (data.error_page) return { kind: "error", detail: `error page: ${data.error_page}` };

  // CAPTCHA gate: result:false + system_note errorType "captcha" (verified live).
  const captchaNote = (data.system_note ?? []).some((n) => n?.params?.errorType === "captcha");
  if (data.result === false || data.result === null || data.result === undefined) {
    if (captchaNote) return { kind: "captcha_required" };
    return { kind: "not_found" };
  }

  const html = data.result?.html;
  if (typeof html === "string" && html.trim().length > 0) {
    // The captcha text was accepted — remember it for session reuse (§24).
    // Phase 4.1 §13-§14: solved CAPTCHA sessions are stored under
    // USER_SESSION scope with the per-request session id; the GLOBAL_PUBLIC
    // bucket is NEVER polluted with a user-bound solved-CAPTCHA session.
    if (opts.captchaText && opts.sessionId) {
      updateSession(
        "datalex",
        { cookies: cookie, captchaKey: opts.captchaText },
        "USER_SESSION",
        opts.sessionId,
      );
    }
    return { kind: "full_text", html };
  }
  return { kind: "not_found" };
}

/** Canonical Datalex URL for opening a case in the browser (user solves captcha). */
export function datalexCaseUrl(externalId: string, appName = "AppCaseSearch"): string {
  return `${DATALEX_BASE}/?app=${appName}&case_id=${encodeURIComponent(externalId)}`;
}

/** Search-result cache: Datalex grid queries are identical for identical input. */
const gridCache = new Map<string, { expiresAt: number; value: DatalexGrid }>();
const GRID_TTL_MS = 5 * 60 * 1000;

export async function datalexSearchGridCached(opts: DatalexSearchOpts): Promise<DatalexGrid> {
  const key = JSON.stringify([
    opts.tab,
    opts.caseNumber ?? null,
    opts.text,
    opts.matchType ?? 2,
    opts.page ?? 1,
    opts.rows ?? 10,
    opts.appName ?? "",
  ]);
  const hit = gridCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await datalexSearchGrid(opts);
  if (gridCache.size > 128) gridCache.clear();
  gridCache.set(key, { expiresAt: Date.now() + GRID_TTL_MS, value });
  return value;
}
