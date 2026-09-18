// tests/unit/redirect-ssrf.test.ts
// SSRF redirect validation contract tests (master prompt §4–§8, §80).
//
// These tests encode the CONTRACT for the manual redirect loop in
// `fetchGuarded()`:
//
//   validate URL → fetch redirect=manual → on 3xx read Location →
//   resolve absolute URL → re-validate (scheme/host/DNS/private/allowedOrigins) →
//   repeat (≤ maxRedirects = 5) → else REDIRECT_LIMIT.
//
// The current `src/lib/legal-search/security/url-policy.ts` (Task 1 has
// landed the manual redirect loop) honours this contract. These tests
// verify the live behavior:
//   - public URL → 200 (happy path)
//   - public URL → 302 → http://127.0.0.1 — MUST block (private loopback)
//   - public URL → 302 → http://169.254.169.254 — MUST block (cloud metadata)
//   - public URL → 302 → http://192.168.1.1 — MUST block (RFC1918)
//   - public URL → 302 → http://[::1]/ — MUST block (private IPv6 loopback)
//   - public URL → redirect chain > maxRedirects — MUST throw REDIRECT_LIMIT
//   - public URL → 302 → different origin not in allowedOrigins — MUST block
//   - public URL → 302 → second public URL in allowedOrigins — MUST allow
//   - public URL → 302 → non-http scheme (file://) — MUST block
//
// All tests mock `globalThis.fetch` with synthetic `Response` objects carrying
// `Location` headers — no real network calls are made. Initial URLs use
// public IP literals (8.8.8.8, 1.1.1.1) to avoid DNS-lookup nondeterminism
// in CI sandboxes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchGuarded, UrlPolicyError } from "@/lib/legal-search/security/url-policy";

// ---------------------------------------------------------------------------
// Helpers — synthetic Response builders
// ---------------------------------------------------------------------------

type RedirectStatus = 301 | 302 | 303 | 307 | 308;

function makeRedirect(
  location: string,
  status: RedirectStatus = 302,
): Response {
  return new Response(null, {
    status,
    // Use a plain object so the Location header survives any internal cloning.
    headers: { Location: location },
  });
}

function makeOk(body: string = "ok"): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/** A mock fetch implementation that returns a queue of canned responses. */
function queuedFetch(responses: Response[]): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let calls = 0;
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const idx = Math.min(calls, responses.length - 1);
    const res = responses[idx];
    calls++;
    return res;
  };
}

/** A mock fetch that always returns the same canned response (loop redirect). */
function alwaysFetch(res: Response): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => res;
}

/** A mock fetch that maps URLs → responses, falling back to a default. */
function routedFetch(
  routes: Record<string, Response>,
  fallback: Response = makeOk(),
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Try exact URL match first; fall back to scheme+host match.
    if (routes[url]) return routes[url];
    for (const key of Object.keys(routes)) {
      if (url.startsWith(key)) return routes[key];
    }
    return fallback;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

describe("fetchGuarded — redirect SSRF (§4–§8, §80)", () => {
  beforeEach(() => {
    // Each test installs its own mock; restore original after.
    globalThis.fetch = ORIGINAL_FETCH as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH as unknown as typeof globalThis.fetch;
  });

  test("public URL → 200 (basic happy path)", async () => {
    globalThis.fetch = queuedFetch([makeOk("body")]) as unknown as typeof globalThis.fetch;
    const res = await fetchGuarded("https://8.8.8.8/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body");
  });

  test("public URL → 302 → http://127.0.0.1 — MUST block", async () => {
    globalThis.fetch = queuedFetch([makeRedirect("http://127.0.0.1/admin")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(["private_address", "blocked_host"]).toContain(err.reason);
  });

  test("public URL → 302 → http://169.254.169.254 — MUST block (cloud metadata)", async () => {
    globalThis.fetch = queuedFetch([makeRedirect("http://169.254.169.254/latest/meta-data/")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(["private_address", "blocked_host"]).toContain(err.reason);
  });

  test("public URL → 302 → http://192.168.1.1 — MUST block (RFC1918)", async () => {
    globalThis.fetch = queuedFetch([makeRedirect("http://192.168.1.1/router")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(["private_address", "blocked_host"]).toContain(err.reason);
  });

  test("public URL → 302 → http://[::1]/ — MUST block (private IPv6 loopback)", async () => {
    globalThis.fetch = queuedFetch([makeRedirect("http://[::1]/")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(["private_address", "blocked_host"]).toContain(err.reason);
  });

  test("public URL → redirect chain > maxRedirects (5) — MUST throw REDIRECT_LIMIT", async () => {
    // Every fetch returns a 302 → next hop on the same host. This is an
    // infinite redirect chain that the new fetchGuarded must cap at 5 hops.
    globalThis.fetch = alwaysFetch(makeRedirect("https://8.8.8.8/loop")) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/loop");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    // Per §5 the error reason should communicate "REDIRECT_LIMIT" — the new
    // fetchGuarded (manual redirect loop) throws UrlPolicyError with reason
    // "redirect_limit". Accept either that explicit reason or any
    // UrlPolicyError whose message mentions "redirect" (defensive against
    // future reason-name changes).
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    const msg = err.message.toLowerCase();
    const explicitReason = err.reason === "redirect_limit";
    const mentionsRedirect = msg.includes("redirect");
    expect(explicitReason || mentionsRedirect).toBe(true);
  });

  test("public URL → 302 → different origin NOT in allowedOrigins — MUST block", async () => {
    // Initial URL passes origin check (https://8.8.8.8 is allowed), but the
    // redirect target (https://1.1.1.1) is NOT in allowedOrigins → block.
    globalThis.fetch = queuedFetch([makeRedirect("https://1.1.1.1/y")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x", { allowedOrigins: ["https://8.8.8.8"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(err.reason).toBe("blocked_host");
  });

  test("public URL → 302 → second public URL in allowedOrigins — MUST allow", async () => {
    // First call returns a 302 to https://1.1.1.1/y (which IS in allowedOrigins).
    // Second call (to https://1.1.1.1/y) returns 200 OK.
    globalThis.fetch = routedFetch(
      {
        "https://8.8.8.8/x": makeRedirect("https://1.1.1.1/y"),
        "https://1.1.1.1/y": makeOk("cross-origin body"),
      },
      makeOk("fallback"),
    ) as unknown as typeof globalThis.fetch;
    const res = await fetchGuarded("https://8.8.8.8/x", {
      allowedOrigins: ["https://8.8.8.8", "https://1.1.1.1"],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cross-origin body");
  });

  test("public URL → 302 chain through several public hops then 200 — MUST allow", async () => {
    // 3-hop chain on the same public host, then 200. Below maxRedirects.
    globalThis.fetch = routedFetch(
      {
        "https://8.8.8.8/r0": makeRedirect("https://8.8.8.8/r1"),
        "https://8.8.8.8/r1": makeRedirect("https://8.8.8.8/r2"),
        "https://8.8.8.8/r2": makeRedirect("https://8.8.8.8/r3"),
        "https://8.8.8.8/r3": makeOk("final body"),
      },
      makeOk("fallback"),
    ) as unknown as typeof globalThis.fetch;
    const res = await fetchGuarded("https://8.8.8.8/r0");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final body");
  });

  test("redirect to non-http scheme — MUST block", async () => {
    // Even if the host looks fine, the scheme allowlist must be enforced
    // on the redirect target too (per §4 "scheme" in the re-validation list).
    globalThis.fetch = queuedFetch([makeRedirect("file:///etc/passwd")]) as unknown as typeof globalThis.fetch;
    let caught: unknown = null;
    try {
      await fetchGuarded("https://8.8.8.8/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(UrlPolicyError);
    const err = caught as UrlPolicyError;
    expect(["bad_scheme", "bad_url", "blocked_host"]).toContain(err.reason);
  });
});
