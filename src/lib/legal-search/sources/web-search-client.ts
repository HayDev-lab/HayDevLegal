// src/lib/legal-search/sources/web-search-client.ts
// Shared, rate-limit-aware z-ai web_search client (Phase 3).
//
// LIVE-VERIFIED: the SDK's web_search endpoint returns HTTP 429 when several
// invocations run concurrently (web adapter + HUDOC discovery + document
// resolver discovery all search in parallel during a deep query). This module
// serializes every web_search call behind a small global semaphore and adds
// one bounded retry with backoff on 429. All call sites MUST use it.

export type WebSearchItem = {
  url: string;
  name: string;
  snippet: string;
  host_name?: string;
  rank?: number;
  date?: string;
};

let zaiPromise: Promise<Awaited<ReturnType<typeof import("z-ai-web-dev-sdk").default.create>>> | null =
  null;

async function getZai() {
  if (!zaiPromise) {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    zaiPromise = ZAI.create();
  }
  return zaiPromise;
}

// --- Global bounded concurrency (live-tuned: 3 parallel calls trigger 429) ---
const MAX_CONCURRENT = 2;
const RETRY_429_DELAY_MS = 900;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests/i.test(msg);
}

/**
 * Invoke web_search through the shared rate-limit-aware queue.
 * Returns null on timeout/failure (never throws).
 */
export async function invokeWebSearch(
  query: string,
  num: number,
  timeoutMs: number,
): Promise<WebSearchItem[] | null> {
  await acquire();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const zai = await getZai();
        const res = (await Promise.race([
          zai.functions.invoke("web_search", { query, num }) as Promise<unknown>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("__timeout__")), timeoutMs),
          ),
        ])) as unknown;
        if (Array.isArray(res)) return res as WebSearchItem[];
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("__timeout__")) return null; // caller decides how to treat it
        if (isRateLimit(err) && attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_429_DELAY_MS));
          continue;
        }
        return null;
      }
    }
    return null;
  } finally {
    release();
  }
}
