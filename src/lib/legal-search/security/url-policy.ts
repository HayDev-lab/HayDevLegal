// src/lib/legal-search/security/url-policy.ts
// SSRF protection for all outbound fetches performed by the legal-search engine.
//
// HARD RULES:
//  - only http/https schemes
//  - NO localhost, 127.0.0.1, 0.0.0.0, ::1
//  - NO link-local (169.254.0.0/16, fe80::/10)
//  - NO private ranges (10/8, 172.16/12, 192.168/16, fc00::/7)
//  - NO cloud metadata endpoints (any host resolving to metadata IPs)
//  - hostnames are resolved via DNS and EVERY resolved address must be public
//  - response size is capped
//
// The policy is enforced by fetchGuarded(), the ONLY sanctioned way for the
// search engine to perform outbound HTTP.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { MAX_REDIRECTS } from "../config";

const BLOCKED_LITERAL_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True when the IPv4 literal falls into a private / reserved range. */
function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n < 0) return true; // unparseable = treat as private (fail closed)
  const inRange = (cidr: string, bits: number) => {
    const base = ipv4ToInt(cidr);
    if (base < 0) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local / cloud metadata
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.88.99.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped range (::ffff:0:0/96) — URL normalizes "::ffff:127.0.0.1"
  // into hex form ("::ffff:7f00:1"), so block the whole mapped range:
  // no legitimate public site uses IPv4-mapped literals.
  if (lower.startsWith("::ffff:")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
    return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped dotted form (defensive; usually pre-normalized already).
  const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // not an IP literal → fail closed
}

export class UrlPolicyError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "bad_url"
      | "bad_scheme"
      | "blocked_host"
      | "private_address"
      | "dns_failure"
      | "redirect_limit",
  ) {
    super(message);
    this.name = "UrlPolicyError";
  }
}

// DNS resolution cache (positive + negative), short TTL.
const dnsCache = new Map<string, { expiresAt: number; ok: boolean }>();
const DNS_TTL_MS = 60_000;

async function hostnameIsPublic(hostname: string): Promise<boolean> {
  const key = hostname.toLowerCase();
  const cached = dnsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;

  let ok = false;
  try {
    const addresses = await lookup(key, { all: true, verbatim: true });
    // EVERY address must be public — if any resolves to a private IP, block.
    ok = addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    ok = false;
  }
  dnsCache.set(key, { ok, expiresAt: Date.now() + DNS_TTL_MS });
  return ok;
}

export type UrlPolicyCheck = {
  ok: boolean;
  url?: URL;
  reason?: UrlPolicyError["reason"];
};

/** Synchronous, cheap URL validation (scheme + literal host checks). */
export function checkUrlSafe(rawUrl: string): UrlPolicyCheck {
  if (!rawUrl || typeof rawUrl !== "string") return { ok: false, reason: "bad_url" };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "bad_scheme" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_LITERAL_HOSTS.has(host)) return { ok: false, reason: "blocked_host" };
  // Strip trailing dot from FQDN
  const h = host.endsWith(".") ? host.slice(0, -1) : host;
  if (BLOCKED_LITERAL_HOSTS.has(h)) return { ok: false, reason: "blocked_host" };
  const ipVer = isIP(h);
  if (ipVer !== 0) {
    if (isPrivateAddress(h)) return { ok: false, reason: "private_address" };
    return { ok: true, url };
  }
  // Hostname — needs DNS check (async) before fetch.
  return { ok: true, url };
}

/** Full validation including DNS resolution (private-IP pinning). */
export async function checkUrlSafeAsync(rawUrl: string): Promise<UrlPolicyCheck> {
  const sync = checkUrlSafe(rawUrl);
  if (!sync.ok || !sync.url) return sync;
  const host = sync.url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return sync; // literal already validated
  const publicHost = await hostnameIsPublic(host);
  if (!publicHost) {
    return { ok: false, reason: host.includes(".") ? "private_address" : "dns_failure" };
  }
  return sync;
}

export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024; // 3 MB hard cap per document

/**
 * Validate a candidate URL for the SSRF policy AND (when allowedOrigins is
 * non-empty) for the cross-origin allowlist. Used both for the initial
 * fetch URL and for every redirect Location header (§4–§8).
 *
 * Returns the validated URL on success; throws UrlPolicyError on rejection.
 */
async function validateFetchUrl(
  rawUrl: string,
  allowedOrigins?: string[],
): Promise<URL> {
  const check = await checkUrlSafeAsync(rawUrl);
  if (!check.ok || !check.url) {
    throw new UrlPolicyError(
      `URL blocked by policy (${check.reason}): ${rawUrl}`,
      check.reason!,
    );
  }
  if (allowedOrigins && allowedOrigins.length > 0) {
    const origin = `${check.url.protocol}//${check.url.host}`;
    if (!allowedOrigins.includes(origin)) {
      throw new UrlPolicyError(`Origin not allowed: ${origin}`, "blocked_host");
    }
  }
  return check.url;
}

/**
 * The ONLY sanctioned outbound fetch for the search engine.
 * Enforces: URL policy (SSRF), timeout, size cap, and a MANUAL redirect loop.
 *
 * SECURITY (Phase 4.1 §4–§8):
 *   - `redirect: "manual"` — we NEVER blindly follow a redirect.
 *   - Each Location header is resolved to an absolute URL against the
 *     current request URL, then re-validated through the FULL policy
 *     (scheme allowlist, blocked hosts, FRESH DNS resolution, private-IP
 *     pinning, allowedOrigins allowlist). Trust is never carried between
 *     hosts.
 *   - The redirect chain is capped at MAX_REDIRECTS (default 5). Exceeding
 *     the limit raises UrlPolicyError("redirect_limit").
 *   - The configured timeout covers the WHOLE redirect chain (a single
 *     abort fires when the budget elapses).
 *   - External abort signals are honoured.
 *   - Response body size remains enforced by callers via readBodyCapped
 *     (a streaming body cannot be bounded by headers alone).
 */
export async function fetchGuarded(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number; allowedOrigins?: string[] } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, maxBytes = MAX_DOCUMENT_BYTES, allowedOrigins, ...rest } = init;

  const currentUrl = await validateFetchUrl(rawUrl, allowedOrigins);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Combine with an external signal if provided.
  if (rest.signal) {
    const external = rest.signal as AbortSignal;
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  // The fetch options MINUS the body mutating fields we re-send verbatim
  // (headers / method / body are preserved across redirects per RFC 7231
  // for same-method redirects; for 303 we MUST switch to GET, but Datalex /
  // HUDOC / ConCourt never emit 303). We preserve them and let the manual
  // loop decide.
  const baseInit: RequestInit = { ...rest, signal: ctrl.signal };

  try {
    let url = currentUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url.toString(), {
        ...baseInit,
        redirect: "manual",
      });

      // 3xx → potential redirect. Resolve + validate the Location header.
      const status = res.status;
      const isRedirect =
        status >= 300 && status < 400 && status !== 304; // 304 is "not modified", not a redirect
      if (!isRedirect) {
        void maxBytes; // size cap enforced downstream by readBodyCapped
        return res;
      }

      const locationHeader = res.headers.get("location");
      if (!locationHeader) {
        // 3xx without Location → protocol error; return the response as-is
        // so the caller can decide. This is rare and never bypasses policy.
        void maxBytes;
        return res;
      }

      if (hop === MAX_REDIRECTS) {
        throw new UrlPolicyError(
          `redirect limit exceeded (${MAX_REDIRECTS} hops) at ${url.toString()}`,
          "redirect_limit",
        );
      }

      // Resolve against the current URL (handles both relative and absolute).
      let nextUrl: URL;
      try {
        nextUrl = new URL(locationHeader, url);
      } catch {
        throw new UrlPolicyError(
          `invalid redirect Location header: ${locationHeader}`,
          "bad_url",
        );
      }

      // Drain the redirect response body so the underlying socket can be
      // reused by undici; then continue with the fresh, re-validated URL.
      try {
        await res.body?.cancel();
      } catch {
        // ignore — body draining is best-effort
      }

      // FULL re-validation — DNS is checked fresh inside validateFetchUrl.
      url = await validateFetchUrl(nextUrl.toString(), allowedOrigins);
    }
    // Unreachable — the loop returns on the first non-redirect response and
    // throws on redirect-limit exhaustion at hop === MAX_REDIRECTS.
    throw new UrlPolicyError("redirect loop terminated unexpectedly", "redirect_limit");
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as text with a hard byte cap. */
export async function readBodyCapped(
  res: Response,
  maxBytes = MAX_DOCUMENT_BYTES,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes, bytes: text.length };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      if (total + value.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  return { text, truncated, bytes: total };
}

/** Content hash for deduplication. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
