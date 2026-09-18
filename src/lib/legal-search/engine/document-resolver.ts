// src/lib/legal-search/engine/document-resolver.ts
// Universal Document Resolver 2.0 (Phase 3 §30-§33, §58-§60, §65-§67).
//
//   resolveLegalDocument(candidate, context)
//
// Resolution strategy ladder (§31):
//   DIRECT API -> DIRECT HTML -> DIRECT PDF -> ACTIVE VALID SESSION ->
//   OTHER OFFICIAL SOURCE -> OFFICIAL DOMAIN SEARCH -> WEB DISCOVERY ->
//   SECONDARY SOURCE -> METADATA ONLY
//
// Identity rules (§32-§33):
//   - a fallback full text is accepted ONLY when an exact unique identifier
//     matches (case number / application number / ՍԴՈ / ECLI), or a strong
//     combination (court + date + title, ≥2 signals incl. title);
//   - when in doubt -> metadataOnly (a similar-but-different document is
//     WORSE than no document — §78 Wrong Document Rate must stay 0).
//
// Efficiency (§59-§60): in-flight coalescing + bounded LRU document cache.

import type {
  ResolutionCandidate,
  ResolvedLegalDocument,
  SearchContext,
} from "../types";
import { OFFICIAL_DOMAINS, RESOLUTION, TIMEOUTS } from "../config";
import { fetchGuarded, readBodyCapped, checkUrlSafe } from "../security/url-policy";
import { extractMainText } from "../security/content-sanitizer";
import { findAdapter } from "../sources/source-registry";
import { pdfToText } from "../sources/pdf-text";
import { recordSuccess, recordFailure, recordRestricted } from "./source-health";

// ---------------------------------------------------------------------------
// Coalescing (§59) + cache (§60)
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<ResolvedLegalDocument>>();
const cache = new Map<string, { expiresAt: number; value: ResolvedLegalDocument }>();

function docKey(c: ResolutionCandidate): string {
  return `${c.sourceId}:${c.externalId ?? c.caseNumber ?? c.url}`;
}

function cacheGet(key: string): ResolvedLegalDocument | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // refresh LRU order
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: ResolvedLegalDocument): void {
  cache.set(key, { expiresAt: Date.now() + RESOLUTION.documentCacheTtlMs, value });
  while (cache.size > RESOLUTION.documentCacheSize) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Identity verification (§32-§33)
// ---------------------------------------------------------------------------

function normalizeIdentifier(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

/**
 * Verify that a fetched text is REALLY the requested document.
 * Returns the matching signals. An exact unique identifier match => accept.
 */
export function verifyIdentity(
  candidate: ResolutionCandidate,
  text: string,
): { verified: boolean; signals: string[] } {
  const signals: string[] = [];
  const upper = text.toUpperCase().replace(/\s+/g, " ");
  const flat = normalizeIdentifier(text);

  // 1. Exact unique identifiers (§33 — auto-accept).
  if (candidate.caseNumber && flat.includes(normalizeIdentifier(candidate.caseNumber))) {
    signals.push(`caseNumber:${candidate.caseNumber}`);
  }
  if (candidate.applicationNumber) {
    const re = new RegExp(`\\b${candidate.applicationNumber.replace(/\//g, "\\/")}\\b`);
    if (re.test(text)) signals.push(`applicationNumber:${candidate.applicationNumber}`);
  }
  if (candidate.sdvoNumber && flat.includes(normalizeIdentifier(candidate.sdvoNumber))) {
    signals.push(`sdvo:${candidate.sdvoNumber}`);
  }
  if (candidate.ecli && flat.includes(candidate.ecli.toUpperCase().replace(/\s+/g, ""))) {
    signals.push(`ecli:${candidate.ecli}`);
  }

  if (signals.length > 0) return { verified: true, signals };

  // 2. Strong combination: court + date + title (§33).
  let combo = 0;
  const titleTokens = candidate.title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 4);
  if (titleTokens.length >= 2) {
    const present = titleTokens.filter((t) => text.toLowerCase().includes(t)).length;
    if (present / titleTokens.length >= 0.5) {
      signals.push("title");
      combo++;
    }
  }
  if (candidate.court) {
    const courtTokens = candidate.court
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 4);
    const present = courtTokens.filter((t) => text.toLowerCase().includes(t)).length;
    if (courtTokens.length > 0 && present / courtTokens.length >= 0.5) {
      signals.push("court");
      combo++;
    }
  }
  if (candidate.date) {
    const year = candidate.date.match(/\d{4}/)?.[0];
    if (year && text.includes(year)) {
      signals.push("date");
      combo++;
    }
  }
  void upper;

  // Title must be one of the matching signals, and at least
  // strongIdentityMinSignals of them (title + one more).
  const hasTitle = signals.includes("title");
  const verified = hasTitle && combo >= RESOLUTION.strongIdentityMinSignals;
  return { verified, signals: verified ? signals : signals.slice(0, 0) };
}

// ---------------------------------------------------------------------------
// Web discovery (§65-§67)
// ---------------------------------------------------------------------------

import { invokeWebSearch, type WebSearchItem } from "../sources/web-search-client";

async function webSearch(query: string, num: number, timeoutMs: number): Promise<WebSearchItem[]> {
  // Shared rate-limit-aware queue — parallel direct SDK calls trigger 429.
  const res = await invokeWebSearch(query, num, timeoutMs);
  return res ?? [];
}

function isOfficialHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** The exact identifier used for targeted discovery (§29, §66). */
function discoveryIdentifier(c: ResolutionCandidate): string | null {
  if (c.caseNumber) return c.caseNumber;
  if (c.applicationNumber) return c.applicationNumber;
  if (c.sdvoNumber) return c.sdvoNumber;
  if (c.ecli) return c.ecli;
  return null;
}

/** Fetch a discovered URL and extract its legal text (HTML or PDF). */
async function fetchDiscoveredText(
  url: string,
  deadline: number,
): Promise<{ text: string; sourceUrl: string } | null> {
  const check = checkUrlSafe(url);
  if (!check.ok) return null; // SSRF policy applies to discovery too (§68-§69)
  try {
    const res = await fetchGuarded(url, {
      timeoutMs: Math.max(2_000, Math.min(TIMEOUTS.documentMs, deadline - Date.now())),
      headers: { Accept: "text/html,application/pdf,*/*" },
    });
    if (!res.ok) return null;

    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
      if (ct.includes("text/html")) return null; // mislabeled; skip
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > RESOLUTION.pdfMaxBytes) return null; // §58 bounded
      const text = await pdfToText(buf);
      if (text && text.length > 200) return { text, sourceUrl: url };
      return null;
    }

    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      // Content sniffing for known sources that mislabel (§71): Datalex
      // serves JSON as text/html; some servers serve HTML as octet-stream.
      const { text: raw } = await readBodyCapped(res, 512 * 1024);
      const looksHtml = /^\s*(?:<!DOCTYPE|<html|<head|<body)/i.test(raw) || /<p[ >]|<div[ >]|<br/i.test(raw);
      if (!looksHtml) return null;
      const text = extractMainText(raw, { maxChars: 120_000 });
      return text && text.length > 200 ? { text, sourceUrl: url } : null;
    }

    const { text: raw } = await readBodyCapped(res, 1024 * 1024);
    const text = extractMainText(raw, { maxChars: 120_000 });
    return text && text.length > 200 ? { text, sourceUrl: url } : null;
  } catch {
    return null;
  }
}

/** Try to resolve via official-domain search then general web discovery. */
async function resolveViaDiscovery(
  candidate: ResolutionCandidate,
  context: SearchContext,
  allowGeneralWeb: boolean,
): Promise<ResolvedLegalDocument | null> {
  const identifier = discoveryIdentifier(candidate);
  if (!identifier) return null; // nothing exact to search for -> skip (§29)

  const remaining = context.deadline - Date.now();
  if (remaining < 4_000) return null;

  // §66 — official-domain search FIRST: "<caseNumber>" site:official-domain
  const officialDomains = OFFICIAL_DOMAINS.filter((d) => d !== "echr.coe.int").slice(0, 5);
  const queries: Array<{ q: string; officialOnly: boolean }> = [
    { q: `"${identifier}" ${officialDomains.map((d) => `site:${d}`).join(" OR ")}`, officialOnly: true },
  ];
  if (allowGeneralWeb) {
    queries.push({ q: `"${identifier}" ${candidate.court ?? "դատարան"}`, officialOnly: false });
  }

  const searched = new Set<string>([candidate.url]);
  for (const { q, officialOnly } of queries) {
    if (Date.now() > context.deadline - 2_500) break;
    const items = await webSearch(
      q,
      officialOnly ? RESOLUTION.officialDomainSearchResults : RESOLUTION.webDiscoveryResults,
      Math.max(2_000, Math.min(6_000, context.deadline - Date.now())),
    );

    // Prefer official hosts first (§31 OTHER_OFFICIAL_SOURCE before WEB_DISCOVERY).
    const ordered = [
      ...items.filter((i) => isOfficialHost(i.url)),
      ...items.filter((i) => !isOfficialHost(i.url)),
    ];

    for (const item of ordered.slice(0, 4)) {
      if (Date.now() > context.deadline - 1_500) return null;
      if (!item?.url || searched.has(item.url)) continue;
      searched.add(item.url);
      if (officialOnly && !isOfficialHost(item.url)) continue;

      const fetched = await fetchDiscoveredText(item.url, context.deadline);
      if (!fetched) continue;

      // §32-§33 — NEVER accept a wrong fallback document.
      const { verified, signals } = verifyIdentity(candidate, fetched.text);
      if (!verified) continue;

      return {
        status: "FULL_TEXT",
        method: isOfficialHost(item.url) ? "OTHER_OFFICIAL_SOURCE" : "WEB_DISCOVERY",
        text: fetched.text,
        url: candidate.url, // canonical URL stays the ORIGINAL source (§49)
        identityVerified: true,
        identitySignals: signals,
        sourceName: isOfficialHost(item.url) ? new URL(item.url).hostname : item.host_name ?? "Վեբ",
        sourceUrl: item.url,
        fetchedAt: new Date().toISOString(),
        bytes: fetched.text.length,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export type ResolverOptions = {
  /**
   * "full" — the whole ladder (deep mode).
   * "official" — direct + official-domain discovery only (quick mode).
   * "direct" — adapter fetch only (reference following, tight budget).
   */
  fallback: "full" | "official" | "direct";
};

/**
 * Resolve the full legal document for a candidate (§30).
 * NEVER throws — every failure maps to an honest ResolvedLegalDocument.
 */
export async function resolveLegalDocument(
  candidate: ResolutionCandidate,
  context: SearchContext,
  opts: ResolverOptions = { fallback: "full" },
): Promise<ResolvedLegalDocument> {
  const key = docKey(candidate);

  // §59 — coalesce concurrent requests for the same document.
  const existing = inFlight.get(key);
  if (existing) return existing;

  // §60 — cached resolution (bounded, TTL).
  const cached = cacheGet(key);
  if (cached) return cached;

  const run = (async (): Promise<ResolvedLegalDocument> => {
    const now = () => new Date().toISOString();
    const metadataOnly = (method: ResolvedLegalDocument["method"] = "METADATA_ONLY", extra: Partial<ResolvedLegalDocument> = {}): ResolvedLegalDocument => ({
      status: "METADATA_ONLY",
      method,
      url: candidate.url,
      identityVerified: true, // metadata came from the source keyed by its own id
      identitySignals: ["metadata_from_source"],
      sourceName: candidate.sourceName,
      fetchedAt: now(),
      ...extra,
    });

    // ---- Ladder step 1: DIRECT API (adapter fetch; includes ACTIVE_SESSION
    // for Datalex-family sources inside their adapters, §24/§31). ----------
    const adapter = findAdapter(candidate.sourceId);
    if (adapter?.fetchDocument) {
      try {
        const resultLike: import("../types").LegalSearchResult = {
          sourceId: candidate.sourceId,
          sourceName: candidate.sourceName,
          sourceType: candidate.sourceType,
          authority: candidate.authority,
          title: candidate.title,
          url: candidate.url,
          court: candidate.court,
          caseNumber: candidate.caseNumber,
          actNumber: candidate.actNumber,
          article: candidate.article,
          date: candidate.date,
          excerpt: candidate.excerpt ?? "",
          temporalStatus: "unknown",
          relevance: 0,
          retrievedAt: now(),
          externalId: candidate.externalId,
          metadataVerified: true,
          fullTextVerified: false,
          resolvedVia: "DIRECT_API",
        };
        const { status, document, accessState } = await adapter.fetchDocument(
          resultLike,
          { ...context, deadline: Math.min(context.deadline, Date.now() + TIMEOUTS.documentMs) },
        );

        if (status === "SUCCESS" && document?.text) {
          recordSuccess(candidate.sourceId, "document");
          const resolved: ResolvedLegalDocument = {
            status: "FULL_TEXT",
            method: "DIRECT_API",
            text: document.text,
            url: candidate.url,
            identityVerified: true,
            identitySignals: ["direct_api_by_id"],
            sourceName: candidate.sourceName,
            sourceUrl: document.url,
            fetchedAt: now(),
            bytes: document.bytes,
          };
          cacheSet(key, resolved);
          return resolved;
        }

        // CAPTCHA-gated: honest PARTIAL state (§23) — and the discovery
        // ladder may still find the same document elsewhere.
        if (status === "PARTIAL" && accessState === "CAPTCHA_REQUIRED") {
          recordRestricted(candidate.sourceId, "document");
          if (opts.fallback !== "direct") {
            const discovered = await resolveViaDiscovery(candidate, context, opts.fallback === "full");
            if (discovered) {
              cacheSet(key, discovered);
              return discovered;
            }
          }
          return {
            status: "CAPTCHA_REQUIRED",
            method: "ACTIVE_SESSION",
            accessState: "CAPTCHA_REQUIRED",
            url: candidate.url,
            identityVerified: true,
            identitySignals: ["metadata_from_source"],
            sourceName: candidate.sourceName,
            fetchedAt: now(),
          };
        }

        if (status === "RESTRICTED") {
          recordRestricted(candidate.sourceId, "document");
          // HUDOC-style restriction: try discovery before giving up (§17).
          if (opts.fallback !== "direct") {
            const discovered = await resolveViaDiscovery(candidate, context, opts.fallback === "full");
            if (discovered) {
              cacheSet(key, discovered);
              return discovered;
            }
          }
          return metadataOnly("METADATA_ONLY", { accessState: "RESTRICTED" });
        }
      } catch {
        recordFailure(candidate.sourceId, "document");
        // fall through to discovery
      }
    }

    // ---- Ladder steps 5-8: discovery (official domain first, then web). ---
    if (opts.fallback !== "direct" && discoveryIdentifier(candidate)) {
      const discovered = await resolveViaDiscovery(candidate, context, opts.fallback === "full");
      if (discovered) {
        cacheSet(key, discovered);
        return discovered;
      }
    }

    return metadataOnly();
  })();

  inFlight.set(key, run);
  try {
    const result = await run;
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/** Clear the document cache (e.g. between gold-set runs). */
export function clearDocumentCache(): void {
  cache.clear();
}
