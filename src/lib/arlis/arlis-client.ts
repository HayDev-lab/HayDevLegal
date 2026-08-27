// src/lib/arlis/arlis-client.ts
// Low-level HTTP client for ARLIS.
//
// Implements: bounded concurrency, retry with exponential backoff, timeout,
// proper ARLIS AJAX headers, JSON-encoded `simple_text` query contract.
//
// All outbound requests go to https://arlis.am only. We never bypass auth,
// CAPTCHA, or anti-bot mechanisms — we only use ARLIS's public search & act
// pages exactly as the ARLIS frontend itself does.

import { searchCache, actDetailCache } from "@/lib/legal/cache";

const ARLIS_BASE = "https://arlis.am";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const MAX_CONCURRENCY = 4;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Simple semaphore for bounded concurrency to ARLIS (per spec §38).
type Release = () => void;
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<Release> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return () => {
      active--;
      const next = waiters.shift();
      if (next) next();
    };
  }
  return new Promise<Release>((resolve) => {
    waiters.push(() => {
      active++;
      resolve(() => {
        active--;
        const n = waiters.shift();
        if (n) n();
      });
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const release = await acquire();
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        // Retry on 429 / 5xx
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < MAX_RETRIES) {
            await sleep(400 * Math.pow(2, attempt) + Math.random() * 200);
            continue;
          }
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          await sleep(400 * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("ARLIS fetch failed after retries");
  } finally {
    release();
  }
}

export type ArlisSearchResponse = {
  status: number;
  message: string | string[] | null;
  html: string;
};

/**
 * Perform an ARLIS search. The `simple_text` query is sent as a JSON-encoded
 * object in the query string, exactly as the ARLIS frontend does.
 *
 * We use ensure_ascii=false so the JSON contains raw UTF-8 Armenian (the
 * server handles this correctly) — we also URL-encode it for transport.
 */
export async function arlisSearch(
  query: string,
  opts: { page?: number; textFilter?: "title" | "content" } = {},
): Promise<ArlisSearchResponse> {
  const page = opts.page ?? 1;
  const paramsObj: Record<string, string> = { simple_text: query };
  if (opts.textFilter) paramsObj.text_filter = opts.textFilter;

  // JSON-encode with raw UTF-8 (ensure_ascii=false) then URL-encode the JSON.
  const json = JSON.stringify(paramsObj);
  const encoded = encodeURIComponent(json);
  const url = `${ARLIS_BASE}/hy/search/page/${page}?${encoded}&order_by=`;

  const cacheKey = `search:${url}`;
  const cached = actDetailCache.get(cacheKey) as ArlisSearchResponse | undefined;
  // search uses shorter cache; check the search-specific cache instead.
  const sCached = (searchCache as unknown as { get(k: string): unknown }).get(cacheKey) as
    | ArlisSearchResponse
    | undefined;
  if (sCached) return sCached;
  if (cached) return cached;

  const producer = async () => {
    const res = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          "X-REQUESTED-WITH": "XMLHttpRequest",
          Accept: "application/json",
          "Accept-Language": "hy,en;q=0.8",
          "User-Agent": UA,
          Referer: `${ARLIS_BASE}/hy/`,
        },
      },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`ARLIS search HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      // ARLIS sometimes returns HTML on errors; treat as failure.
      throw new Error(`ARLIS search unexpected content-type ${ct}`);
    }
    const data = (await res.json()) as ArlisSearchResponse;
    if (data.status === -1) {
      // ARLIS internal error: surface as Error so callers can fallback.
      const msg = Array.isArray(data.message) ? data.message[0] : data.message;
      throw new Error(`ARLIS error: ${msg ?? "internal"}`);
    }
    return data;
  };

  const value = await (searchCache as unknown as {
    coalesce: (k: string, p: () => Promise<ArlisSearchResponse>) => Promise<ArlisSearchResponse>;
  }).coalesce(cacheKey, producer);
  return value;
}

/**
 * Fetch the full HTML of an ARLIS act detail page.
 * Cached for 30 min (acts change rarely and we link to /latest anyway).
 */
export async function arlisActDetail(actId: string): Promise<string> {
  if (!/^\d+$/.test(actId)) throw new Error(`Invalid actId: ${actId}`);
  const url = `${ARLIS_BASE}/hy/acts/${actId}/latest`;
  const cacheKey = `act:${actId}`;
  const cached = actDetailCache.get(cacheKey) as string | undefined;
  if (cached) return cached;

  const producer = async () => {
    const res = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "hy,en;q=0.8",
          "User-Agent": UA,
          Referer: `${ARLIS_BASE}/hy/`,
        },
      },
      15_000,
    );
    if (!res.ok) throw new Error(`ARLIS act HTTP ${res.status}`);
    const html = await res.text();
    return html;
  };

  const value = await (actDetailCache as unknown as {
    coalesce: (k: string, p: () => Promise<string>) => Promise<string>;
  }).coalesce(cacheKey, producer);
  return value;
}
