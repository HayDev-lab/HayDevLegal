// src/lib/legal-search/sources/session-store.ts
// Bounded source-session store (Phase 3 §26-§27).
//
// Holds per-source session state (cookies, CSRF tokens, solved CAPTCHA keys)
// so a valid session is REUSED instead of re-created for every document
// fetch (§24). Hard rules:
//  - bounded (max SESSION_STORE.maxSessions entries, LRU eviction)
//  - TTL-bounded (never a perpetual session)
//  - cookies are NEVER logged and NEVER sent to the frontend
//  - everything stays in process memory only

import { SESSION_STORE } from "../config";

export interface SourceSession {
  /** Source id, e.g. "datalex". */
  source: string;
  /** Cookie header value(s) for replaying the session. */
  cookies?: string;
  /** CSRF token when the source uses one (e.g. concourt.am). */
  csrfToken?: string;
  /** Last CAPTCHA solution validated by the source (short-lived). */
  captchaKey?: string;
  /** When the captchaKey was accepted by the source. */
  captchaKeyAt?: number;
  createdAt: number;
  expiresAt?: number;
}

const store = new Map<string, SourceSession>();

function prune(): void {
  const now = Date.now();
  for (const [key, s] of store) {
    if (s.expiresAt && s.expiresAt < now) store.delete(key);
  }
  // LRU-ish eviction: Map preserves insertion order; delete+Set refreshes it.
  while (store.size > SESSION_STORE.maxSessions) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Get a live session for a source (undefined when absent/expired). */
export function getSession(source: string): SourceSession | undefined {
  const s = store.get(source);
  if (!s) return undefined;
  if (s.expiresAt && s.expiresAt < Date.now()) {
    store.delete(source);
    return undefined;
  }
  // A captchaKey older than its own TTL is considered stale.
  if (
    s.captchaKey &&
    (!s.captchaKeyAt || Date.now() - s.captchaKeyAt > SESSION_STORE.captchaKeyTtlMs)
  ) {
    s.captchaKey = undefined;
    s.captchaKeyAt = undefined;
  }
  return s;
}

/** Insert/replace a session (bounded). */
export function setSession(session: SourceSession): void {
  if (!session.source) return;
  const ttl = session.expiresAt
    ? session.expiresAt - session.createdAt
    : SESSION_STORE.defaultTtlMs;
  const normalized: SourceSession = {
    ...session,
    createdAt: session.createdAt || Date.now(),
    expiresAt: session.createdAt + Math.min(Math.max(ttl, 60_000), SESSION_STORE.defaultTtlMs),
  };
  store.delete(session.source); // refresh insertion order
  store.set(session.source, normalized);
  prune();
}

/** Patch an existing session in place (keeps creation time / order). */
export function updateSession(
  source: string,
  patch: Partial<Omit<SourceSession, "source">>,
): SourceSession | undefined {
  const existing = getSession(source);
  if (!existing) {
    if (patch.cookies || patch.csrfToken) {
      const created: SourceSession = { source, createdAt: Date.now(), ...patch };
      setSession(created);
      return getSession(source);
    }
    return undefined;
  }
  const next: SourceSession = { ...existing, ...patch };
  if (patch.captchaKey) next.captchaKeyAt = Date.now();
  store.set(source, next);
  return next;
}

/** Drop a session (e.g. the source invalidated it). */
export function clearSession(source: string): void {
  store.delete(source);
}

/** Diagnostics: source ids with live sessions (NO cookie values). */
export function sessionDiagnostics(): Array<{ source: string; ageMs: number; hasCaptchaKey: boolean }> {
  const now = Date.now();
  return Array.from(store.values()).map((s) => ({
    source: s.source,
    ageMs: now - s.createdAt,
    hasCaptchaKey: !!s.captchaKey,
  }));
}
