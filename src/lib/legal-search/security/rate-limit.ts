// src/lib/legal-search/security/rate-limit.ts
// Application-level per-IP rate limiting (Phase 4.1 §11–§12).
//
// Design:
//   - In-memory sliding-window token bucket keyed by `${category}:${ip}`.
//   - One bucket per (category, ip). Each category has its own capacity
//     drawn from config.RATE_LIMIT.categories.
//   - Periodic prune of stale buckets (config.RATE_LIMIT.pruneIntervalMs)
//     keeps the Map bounded under sustained load.
//   - The store is wrapped behind a thin interface so an external store
//     (Redis, KV) can replace it later WITHOUT touching the call sites.
//
// IP extraction:
//   - Honour the first hop of `X-Forwarded-For` when present (Caddy injects
//     the upstream client IP).
//   - Fall back to NextRequest.ip when available.
//   - Final fallback: "unknown" — requests without a tractable client IP
//     share a single bucket so they cannot bypass the limit, only collapse
//     together.
//
// Categories (§12):
//   quick_search (60/min), deep_search (10/min), answer (20/min),
//   resolve (30/min), qa (5/min — strictest by design).

import { NextRequest } from "next/server";
import { RATE_LIMIT } from "../config";

export type RateLimitCategory =
  | "quick_search"
  | "deep_search"
  | "answer"
  | "resolve"
  | "qa";

export type RateLimitResult =
  | { ok: true }
  | { ok: false; status: 429; retryAfterMs: number };

/**
 * Pluggable rate-limit store. The default in-memory implementation is
 * exported below; an external store (Redis / KV) can implement this
 * contract later without touching call sites.
 */
export interface RateLimitStore {
  /** Returns true when the request was admitted; false when limited. */
  admit(
    category: RateLimitCategory,
    ip: string,
    now: number,
  ): { admitted: boolean; retryAfterMs: number };
  prune(now: number): void;
}

interface Bucket {
  tokens: number;
  /** Last refill timestamp (ms). */
  updatedAt: number;
}

interface InMemoryStoreEntry {
  buckets: Map<string, Bucket>;
  lastSeen: number;
}

class InMemoryRateLimitStore implements RateLimitStore {
  /** ip -> per-category buckets */
  private readonly ips = new Map<string, InMemoryStoreEntry>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Avoid timers when running inside Next.js edge contexts (none here, but
    // defensive): the prune runs lazily on every admit() too.
    if (typeof setInterval === "function" && typeof process !== "undefined") {
      try {
        this.pruneTimer = setInterval(
          () => this.prune(Date.now()),
          RATE_LIMIT.pruneIntervalMs,
        );
        // Do not keep the process alive on its account.
        if (this.pruneTimer && typeof this.pruneTimer.unref === "function") {
          this.pruneTimer.unref();
        }
      } catch {
        // Interval unavailable (edge runtime) — lazy prune only.
      }
    }
  }

  admit(
    category: RateLimitCategory,
    ip: string,
    now: number,
  ): { admitted: boolean; retryAfterMs: number } {
    const cap = RATE_LIMIT.categories[category].capacity;
    // Refill rate: capacity tokens per windowMs.
    const refillPerMs = cap / RATE_LIMIT.windowMs;

    let entry = this.ips.get(ip);
    if (!entry) {
      entry = { buckets: new Map(), lastSeen: now };
      this.ips.set(ip, entry);
    } else {
      entry.lastSeen = now;
    }
    let bucket = entry.buckets.get(category);
    if (!bucket) {
      bucket = { tokens: cap, updatedAt: now };
      entry.buckets.set(category, bucket);
    }

    // Refill proportional to elapsed time (token bucket).
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(cap, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { admitted: true, retryAfterMs: 0 };
    }
    // Tokens exhausted — compute the time until one token is replenished.
    const retryAfterMs = Math.ceil(1 / refillPerMs);
    return { admitted: false, retryAfterMs };
  }

  prune(now: number): void {
    const cutoff = now - RATE_LIMIT.entryTtlMs;
    for (const [ip, entry] of this.ips) {
      if (entry.lastSeen < cutoff) {
        this.ips.delete(ip);
        continue;
      }
      // Also drop buckets that have been idle per-category (kept simple —
      // the entry-level TTL is enough for any sane request volume).
    }
    // Hard cap: never let the map grow beyond 50_000 entries (single-instance
    // hot path). When exceeded, drop the oldest 25% by lastSeen.
    if (this.ips.size > 50_000) {
      const sorted = Array.from(this.ips.entries()).sort(
        (a, b) => a[1].lastSeen - b[1].lastSeen,
      );
      const dropCount = Math.floor(sorted.length / 4);
      for (let i = 0; i < dropCount; i++) {
        const [ip] = sorted[i];
        this.ips.delete(ip);
      }
    }
  }

  /** Test-only escape hatch — clears the store between unit tests. */
  reset(): void {
    this.ips.clear();
  }
}

const store: RateLimitStore = new InMemoryRateLimitStore();

/**
 * Extract a client IP from a Next.js request. Falls back to "unknown"
 * when no tractable IP is available — requests without a client IP share
 * a single bucket so they cannot bypass the limit, only collapse together.
 */
export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // NextRequest.ip is set by the runtime when running behind the deploy
  // gateway; fall back to a shared bucket otherwise.
  const ip = (req as unknown as { ip?: string }).ip;
  return ip || "unknown";
}

/**
 * The middleware-style rate-limit gate. Returns ok:true when the request
 * is admitted, ok:false with a 429 status + retryAfterMs hint when limited.
 *
 * Usage in an API route:
 *   const gated = await rateLimit("quick_search")(req);
 *   if (!gated.ok) return NextResponse.json(..., { status: 429, headers: { "retry-after": ... } });
 */
export function rateLimit(category: RateLimitCategory) {
  return async (req: NextRequest): Promise<RateLimitResult> => {
    const ip = getClientIp(req);
    const now = Date.now();
    // Lazy prune — cheap because prune is O(n) but only fires occasionally.
    if (now % 64 === 0) store.prune(now);
    const res = store.admit(category, ip, now);
    if (res.admitted) return { ok: true };
    return { ok: false, status: 429, retryAfterMs: res.retryAfterMs };
  };
}

/**
 * Reset the in-memory store — intended for unit tests; never call from
 * production code.
 */
export function __resetRateLimitStoreForTests(): void {
  store.prune(Date.now());
  if (typeof (store as InMemoryRateLimitStore).reset === "function") {
    (store as InMemoryRateLimitStore).reset();
  }
}
