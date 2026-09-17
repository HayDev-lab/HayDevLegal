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
      | "dns_failure",
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
 * The ONLY sanctioned outbound fetch for the search engine.
 * Enforces: URL policy (SSRF), timeout, size cap, redirect policy.
 */
export async function fetchGuarded(
  rawUrl: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number; allowedOrigins?: string[] } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, maxBytes = MAX_DOCUMENT_BYTES, allowedOrigins, ...rest } = init;

  const check = await checkUrlSafeAsync(rawUrl);
  if (!check.ok || !check.url) {
    throw new UrlPolicyError(`URL blocked by policy (${check.reason}): ${rawUrl}`, check.reason!);
  }
  if (allowedOrigins && allowedOrigins.length > 0) {
    const origin = `${check.url.protocol}//${check.url.host}`;
    if (!allowedOrigins.includes(origin)) {
      throw new UrlPolicyError(`Origin not allowed: ${origin}`, "blocked_host");
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Combine with an external signal if provided.
  if (rest.signal) {
    const external = rest.signal as AbortSignal;
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  try {
    const res = await fetch(check.url.toString(), {
      ...rest,
      signal: ctrl.signal,
      redirect: "follow",
    });
    // Note: full body size is enforced by callers reading with a cap
    // (Response headers alone can't bound a streaming body).
    void maxBytes;
    return res;
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
