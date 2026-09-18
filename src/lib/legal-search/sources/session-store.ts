// src/lib/legal-search/sources/session-store.ts
// Bounded source-session store (Phase 3 §26-§27, Phase 4.1 §13-§14).
//
// Holds per-source session state (cookies, CSRF tokens, solved CAPTCHA keys)
// so a valid session is REUSED instead of re-created for every document
// fetch (§24). Hard rules:
//  - bounded (max SESSION_STORE.maxSessions entries, LRU eviction)
//  - TTL-bounded (never a perpetual session)
//  - cookies are NEVER logged and NEVER sent to the frontend
//  - everything stays in process memory only
//
// PHASE 4.1 SESSION ISOLATION (§13-§14):
//   Sessions are partitioned by `scope`:
//     - "REQUEST"         — single-request throwaway (not currently used by
//                           any source; the bucket is reserved).
//     - "USER_SESSION"    — a solved-CAPTCHA / authenticated user session;
//                           NEVER shared across users. `key` is the user or
//                           request-bound session id.
//     - "GLOBAL_PUBLIC"   — a generic anonymous bootstrap session (e.g.
//                           Datalex's initial PHPSESSID — no CAPTCHA, no
//                           user binding; safe to share).
//
//   Solved CAPTCHA sessions (Datalex interactive flow) MUST be stored under
//   USER_SESSION scope with a per-request/per-user `key` — they can never
//   become GLOBAL_PUBLIC.
//
//   Backward compatibility: callers that don't pass `scope` continue to
//   read the legacy global bucket (same behaviour as before Phase 4.1 for
//   the initial PHPSESSID bootstrap, which legitimately IS GLOBAL_PUBLIC).

import { SESSION_STORE } from "../config";

export type SessionScope = "REQUEST" | "USER_SESSION" | "GLOBAL_PUBLIC";

export interface SourceSession {
  /** Source id, e.g. "datalex". */
  source: string;
  /**
   * §14 — session isolation scope. Defaults to "GLOBAL_PUBLIC" for legacy
   * callers. Solved-CAPTCHA sessions MUST use "USER_SESSION" with a `key`.
   */
  scope?: SessionScope;
  /**
   * User/session id when scope is "USER_SESSION" or "REQUEST". Ignored for
   * "GLOBAL_PUBLIC" sessions.
   */
  key?: string;
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

/** Build the scoped storage key. Legacy (scope omitted) callers use `${source}`. */
function scopedKey(source: string, scope?: SessionScope, key?: string): string {
  if (!scope || scope === "GLOBAL_PUBLIC") return source;
  if (!key) return `${source}:${scope}`;
  return `${source}:${scope}:${key}`;
}

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

/** Expire a stale captcha key in place (clears the field but keeps the session). */
function refreshCaptchaKey(s: SourceSession | undefined): SourceSession | undefined {
  if (!s) return undefined;
  if (
    s.captchaKey &&
    (!s.captchaKeyAt || Date.now() - s.captchaKeyAt > SESSION_STORE.captchaKeyTtlMs)
  ) {
    s.captchaKey = undefined;
    s.captchaKeyAt = undefined;
  }
  return s;
}

/**
 * Get a live session for a source.
 *
 * Phase 4.1 (§13-§14): when `scope` is provided, look up by the scoped
 * storage key (`${source}:${scope}:${key}`). Falls back to the legacy global
 * bucket ONLY when scope is omitted — preserving the behaviour of the
 * initial PHPSESSID bootstrap (which legitimately IS GLOBAL_PUBLIC).
 */
export function getSession(
  source: string,
  scope?: SessionScope,
  key?: string,
): SourceSession | undefined {
  const sk = scopedKey(source, scope, key);
  const s = store.get(sk);
  if (!s) return undefined;
  if (s.expiresAt && s.expiresAt < Date.now()) {
    store.delete(sk);
    return undefined;
  }
  refreshCaptchaKey(s);
  return s;
}

/** Insert/replace a session (bounded). */
export function setSession(session: SourceSession): void {
  if (!session.source) return;
  const sk = scopedKey(session.source, session.scope, session.key);
  const ttl = session.expiresAt
    ? session.expiresAt - session.createdAt
    : SESSION_STORE.defaultTtlMs;
  const normalized: SourceSession = {
    ...session,
    createdAt: session.createdAt || Date.now(),
    expiresAt: session.createdAt + Math.min(Math.max(ttl, 60_000), SESSION_STORE.defaultTtlMs),
  };
  store.delete(sk); // refresh insertion order
  store.set(sk, normalized);
  prune();
}

/**
 * Patch an existing session in place (keeps creation time / order).
 *
 * `scope` and `key` follow the same rules as getSession. When the scoped
 * bucket is empty but the patch carries cookies/csrfToken/captchaKey, a new
 * session is created on that scoped bucket — this matches the pre-Phase-4.1
 * "create-on-patch" behaviour for legacy callers.
 */
export function updateSession(
  source: string,
  patch: Partial<Omit<SourceSession, "source">>,
  scope?: SessionScope,
  key?: string,
): SourceSession | undefined {
  const sk = scopedKey(source, scope, key);
  const existing = store.get(sk);
  // Backward-compat: when no scope is given, also fall back to the legacy
  // global bucket (so `updateSession("datalex", {...})` still works).
  const legacy = !scope ? store.get(source) : undefined;
  const base = existing ?? legacy;
  if (!base) {
    if (patch.cookies || patch.csrfToken || patch.captchaKey) {
      const created: SourceSession = {
        source,
        ...(scope ? { scope, key } : {}),
        createdAt: Date.now(),
        ...patch,
      };
      setSession(created);
      return getSession(source, scope, key);
    }
    return undefined;
  }
  const next: SourceSession = { ...base, ...patch };
  if (patch.captchaKey) next.captchaKeyAt = Date.now();
  store.set(sk, next);
  return next;
}

/** Drop a session (e.g. the source invalidated it). */
export function clearSession(source: string, scope?: SessionScope, key?: string): void {
  const sk = scopedKey(source, scope, key);
  store.delete(sk);
}

/** Diagnostics: source ids with live sessions (NO cookie values). */
export function sessionDiagnostics(): Array<{
  source: string;
  scope?: SessionScope;
  key?: string;
  ageMs: number;
  hasCaptchaKey: boolean;
}> {
  const now = Date.now();
  return Array.from(store.values()).map((s) => ({
    source: s.source,
    scope: s.scope,
    key: s.key,
    ageMs: now - s.createdAt,
    hasCaptchaKey: !!s.captchaKey,
  }));
}
