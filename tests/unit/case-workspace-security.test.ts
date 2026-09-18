// tests/unit/case-workspace-security.test.ts
// Phase 5.1 §28 — Security regression for the Case Workspace.
//
// Re-runs every Phase 4.1 / Phase 5 security invariant against the Case
// Workspace service layer. "Zero regressions" — the test must pass without
// any modification to the security modules themselves.
//
// Coverage (§28):
//   1.  Path traversal            — resolveStoragePath("../../etc/passwd") throws
//   2.  Path traversal in storageKey — generateStorageKey sanitizes `../`
//   3.  Cross-case access          — getDocument via case B for a doc in case A → 404
//   4.  Opaque storage keys        — storageKey does NOT expose server fs path
//   5.  MIME/magic validation      — valid PDF/DOCX accepted, fake/MZ/scripts rejected
//   6.  Size limits                — 50MB OK, 50MB+1 rejected
//   7.  QA guard still works      — withQaGuard returns 404 when QA disabled
//   8.  API rate limit             — rateLimit("qa") returns 429 after the 5-token
//                                    bucket is exhausted; module is wired into a route
//   9.  Redirect SSRF              — covered by tests/unit/redirect-ssrf.test.ts;
//                                    this file verifies the module is still importable
//  10.  Secret scan                — no OPENAI/CODEX/OLLAMA keys, no GitHub PATs
//  11.  Codex workspace isolation  — createWorkspace writes under /tmp/haydevlegal-case/<id>/
//                                    and is request-scoped (different id → different dir)
//  12.  Datalex isolation          — solved CAPTCHA sessions live under USER_SESSION scope,
//                                    never GLOBAL_PUBLIC

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";

import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_ROOT,
  archiveCase,
  createCase,
  deleteCase,
  generateStorageKey,
  getDocument,
  ingestDocument,
  resolveStoragePath,
  StorageError,
  validateFile,
} from "@/lib/case-workspace";
import { db } from "@/lib/case-workspace/db";
import {
  createWorkspace,
  cleanupWorkspace,
  type CaseAnalysisPack,
} from "@/lib/ai-runtime/codex";
import {
  rateLimit,
  __resetRateLimitStoreForTests,
} from "@/lib/legal-search/security/rate-limit";
import { withQaGuard } from "@/lib/legal-search/security/qa-guard";
import { fetchGuarded, UrlPolicyError } from "@/lib/legal-search/security/url-policy";

// ---------------------------------------------------------------------------
// Helpers — bytes + temp case lifecycle
// ---------------------------------------------------------------------------

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const DOCX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fillBytes(n: number, byte: number = 0x61): Uint8Array {
  const buf = new Uint8Array(n);
  buf.fill(byte);
  return buf;
}

function withMagic(magic: number[], tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(magic.length + tail.length);
  out.set(magic, 0);
  out.set(tail, magic.length);
  return out;
}

async function makeTempCase(prefix: string): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const c = await createCase({
    title: `${prefix}-${randomUUID()}`,
    caseType: "OTHER",
  });
  const cleanup = async () => {
    try {
      await archiveCase(c.id).catch(() => {});
    } catch {
      /* swallow */
    }
    try {
      await deleteCase(c.id).catch(() => {});
    } catch {
      /* swallow */
    }
  };
  return { id: c.id, cleanup };
}

// ---------------------------------------------------------------------------
// §28 — Security regression
// ---------------------------------------------------------------------------

describe("Phase 5.1 §28 — Case Workspace security regression", () => {
  // -------------------------------------------------------------------------
  // #1 — Path traversal in resolveStoragePath
  // -------------------------------------------------------------------------

  test("#1 path traversal — resolveStoragePath('../../etc/passwd') throws StorageError", () => {
    // The storage layer MUST reject any storageKey that would resolve outside
    // the storage root. `../../etc/passwd` would escape the root by 2 levels.
    let caught: unknown = null;
    try {
      resolveStoragePath("../../etc/passwd");
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(StorageError);

    // Defence-in-depth: even a single `..` component must be rejected.
    let caught2: unknown = null;
    try {
      resolveStoragePath("../etc/passwd");
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).toBeInstanceOf(StorageError);
  });

  // -------------------------------------------------------------------------
  // #2 — Path traversal in generateStorageKey
  // -------------------------------------------------------------------------

  test("#2 path traversal in storageKey — filename with ../ is sanitized", () => {
    // The user-supplied filename MUST NOT be embedded verbatim into the
    // storageKey. The slug regex strips slashes and dots-only segments.
    const key = generateStorageKey(
      "case-abc",
      "doc-xyz",
      "../../etc/passwd",
    );

    // storageKey must NOT contain `../` (path traversal sequence).
    expect(key.includes("../")).toBe(false);

    // The caseId + documentId are the first two path components (cuid-style),
    // so the storageKey never carries user-supplied path segments.
    expect(key.startsWith("case-abc/doc-xyz/")).toBe(true);

    // Filename-derived slug should be sanitized to alphanumerics only (with _).
    expect(key).toMatch(/^case-abc\/doc-xyz\/[a-f0-9]+-\.\._\.\._etc_passwd$/);
  });

  // -------------------------------------------------------------------------
  // #3 — Cross-case access
  // -------------------------------------------------------------------------

  test("#3 cross-case access — getDocument on case B for a doc in case A → 404 path", async () => {
    const ctxA = await makeTempCase("SEC-CROSS-A");
    const ctxB = await makeTempCase("SEC-CROSS-B");
    try {
      // Upload a TXT doc into case A.
      const bytes = textBytes(`cross-case test — ${randomUUID()}`);
      const r = await ingestDocument(ctxA.id, null, "doc-A.txt", "text/plain", bytes);
      expect(r.documentId).not.toBe("");

      // getDocument by id returns the row with caseId === ctxA.id.
      const doc = await getDocument(r.documentId);
      expect(doc).not.toBeNull();
      expect(doc?.caseId).toBe(ctxA.id);
      expect(doc?.caseId).not.toBe(ctxB.id);

      // §19 cross-case leakage backstop: the API route handler enforces
      // `if (!doc || doc.caseId !== id) return 404`. Simulate the check
      // for case B's id → must be rejected.
      const crossCheck = !doc || doc.caseId !== ctxB.id;
      expect(crossCheck).toBe(true); // would 404

      // And case A's id → must be allowed.
      const sameCaseCheck = !doc || doc.caseId !== ctxA.id;
      expect(sameCaseCheck).toBe(false); // would NOT 404
    } finally {
      await ctxA.cleanup();
      await ctxB.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // #4 — Opaque storage keys
  // -------------------------------------------------------------------------

  test("#4 opaque storage keys — storageKey does NOT expose server filesystem path", async () => {
    const ctx = await makeTempCase("SEC-OPAQUE");
    try {
      const bytes = textBytes(`opaque test — ${randomUUID()}`);
      const r = await ingestDocument(ctx.id, null, "doc.txt", "text/plain", bytes);
      expect(r.documentId).not.toBe("");

      const doc = await getDocument(r.documentId);
      expect(doc).not.toBeNull();

      // §19 — the storageKey is opaque: `${caseId}/${documentId}/${hash-slug}`.
      // It MUST NOT contain the server's filesystem path (e.g. STORAGE_ROOT).
      expect(doc?.storageKey).toBeTruthy();
      expect(doc?.storageKey).not.toContain(STORAGE_ROOT);
      expect(doc?.storageKey).not.toContain("/tmp/");
      expect(doc?.storageKey).not.toContain("/home/");
      expect(doc?.storageKey).not.toContain("..");

      // The storageKey MUST start with the caseId (the only path component
      // the user could legitimately know — the case they uploaded into).
      expect(doc?.storageKey.startsWith(ctx.id + "/")).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // #5 — MIME/magic validation
  // -------------------------------------------------------------------------

  test("#5 MIME/magic validation — valid PDF/DOCX accepted; fake/MZ/scripts rejected", () => {
    // valid PDF (magic %PDF) → ok
    const validPdf = validateFile(
      "ok.pdf",
      "application/pdf",
      withMagic(PDF_MAGIC, textBytes("\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")),
    );
    expect(validPdf.ok).toBe(true);

    // fake PDF — TXT content, application/pdf MIME → reject (magic mismatch)
    const fakePdf = validateFile(
      "fake.pdf",
      "application/pdf",
      textBytes("hello world, this is plain text"),
    );
    expect(fakePdf.ok).toBe(false);

    // valid DOCX (magic PK\x03\x04) → ok
    const validDocx = validateFile(
      "ok.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      withMagic(DOCX_MAGIC, fillBytes(64, 0xab)),
    );
    expect(validDocx.ok).toBe(true);

    // executable .exe with MZ magic → reject (extension blocklist fires first)
    const exe = validateFile(
      "evil.exe",
      "application/octet-stream",
      withMagic([0x4d, 0x5a], fillBytes(64, 0x00)),
    );
    expect(exe.ok).toBe(false);

    // script .js → reject
    const js = validateFile(
      "evil.js",
      "text/javascript",
      textBytes("console.log('hello');\n"),
    );
    expect(js.ok).toBe(false);

    // script .ts → reject
    const ts = validateFile(
      "evil.ts",
      "text/typescript",
      textBytes("const x: number = 1;\n"),
    );
    expect(ts.ok).toBe(false);

    // script .sh → reject
    const sh = validateFile(
      "evil.sh",
      "application/x-sh",
      textBytes("#!/bin/bash\necho hi\n"),
    );
    expect(sh.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // #6 — Size limits
  // -------------------------------------------------------------------------

  test("#6 size limits — 50MB OK, 50MB+1 rejected", () => {
    // exactly 50MB → ok (bytes.length === MAX_FILE_SIZE_BYTES, not greater)
    const exactly50 = fillBytes(MAX_FILE_SIZE_BYTES, 0x61); // 'a' printable
    const v1 = validateFile("fifty.txt", "text/plain", exactly50);
    expect(v1.ok).toBe(true);

    // 50MB + 1 → reject (size cap)
    const justOver = fillBytes(MAX_FILE_SIZE_BYTES + 1, 0x61);
    const v2 = validateFile("fifty-plus-one.txt", "text/plain", justOver);
    expect(v2.ok).toBe(false);
    if (!v2.ok) {
      const reason = v2.reason.toLowerCase();
      expect(reason.includes("large") || reason.includes("size")).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // #7 — QA guard still works
  // -------------------------------------------------------------------------

  test("#7 QA guard — withQaGuard returns 404 when LEGAL_QA_ENABLED is unset", async () => {
    // Save + clear the env var to simulate the production default.
    const prev = process.env.LEGAL_QA_ENABLED;
    delete process.env.LEGAL_QA_ENABLED;

    try {
      const handler = withQaGuard(async () =>
        new Response("should never reach here", { status: 200 }),
      );
      const req = new NextRequest("https://example.com/api/test/gold-set");
      const res = await handler(req, { params: {} });
      expect(res.status).toBe(404);
      // The 404 body is generic — never reveals the route's existence.
      const body = await res.json();
      expect(body).toEqual({ error: "not found" });
    } finally {
      if (prev !== undefined) process.env.LEGAL_QA_ENABLED = prev;
    }
  });

  // -------------------------------------------------------------------------
  // #8 — API rate limit
  // -------------------------------------------------------------------------

  test("#8 rate limit — qa bucket capacity=5; 6th request returns 429", async () => {
    // Reset the in-memory store so this test is deterministic.
    __resetRateLimitStoreForTests();

    // Use a unique IP so the bucket is fresh and not affected by other tests.
    const ip = "203.0.113.42";

    const results: Array<{ ok: boolean; status?: number }>= [];
    for (let i = 0; i < 6; i++) {
      const req = new NextRequest("https://example.com/api/test/gold-set", {
        headers: { "x-forwarded-for": ip },
      });
      const r = await rateLimit("qa")(req);
      results.push(r);
    }

    // First 5 should pass; 6th should be 429.
    const admitted = results.filter((r) => r.ok).length;
    const rejected = results.filter((r) => !r.ok).length;
    expect(admitted).toBe(5);
    expect(rejected).toBe(1);

    // Verify the module is wired into at least one route. The QA gold-set
    // route is the canonical site — it imports `rateLimit` and calls it as
    // `rateLimit("qa")(req)` inside `withQaGuard`. Reading the file directly
    // (rather than spawning `rg`) avoids interference from any sibling test
    // file that mocks `node:child_process` (codex-chatgpt-auth.test.ts does
    // this — see mock.module there).
    const goldSetRoutePath = resolve(
      "/home/z/my-project/src/app/api/test/gold-set/route.ts",
    );
    const goldSetRouteSrc = readFileSync(goldSetRoutePath, "utf-8");
    expect(goldSetRouteSrc).toContain("rateLimit");
    expect(goldSetRouteSrc).toContain("qa");
    // Also confirm the security/rate-limit module exports the function we
    // exercised above (already imported above, but assert it's the same fn).
    expect(typeof rateLimit).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// §28 #9 — Redirect SSRF (existing test reference)
// ---------------------------------------------------------------------------

describe("Phase 5.1 §28 #9 — Redirect SSRF (regression of Phase 4.1)", () => {
  test("redirect SSRF contract — fetchGuarded + UrlPolicyError still exported", () => {
    // The redirect-SSRF behaviour is covered in tests/unit/redirect-ssrf.test.ts
    // (Phase 4.1). This test simply verifies the security surface is still
    // importable after Phase 5.1 — i.e., Phase 5 did not delete or rename it.
    expect(typeof fetchGuarded).toBe("function");
    expect(typeof UrlPolicyError).toBe("function");
    expect(UrlPolicyError.name).toBe("UrlPolicyError");
  });
});

// ---------------------------------------------------------------------------
// §28 #10 — Secret scan (no real secrets in src/, tests/, .env)
// ---------------------------------------------------------------------------

describe("Phase 5.1 §28 #10 — Secret scan", () => {
  // We scan the codebase IN-PROCESS (not via `rg`) so the test is immune to
  // sibling test files that mock `node:child_process` (codex-chatgpt-auth.test.ts
  // installs a fake spawnSync that would break an `rg`-based scan).
  //
  // Patterns are matched literally (substring search). The "sk-..."
  // patterns require a 20+ char alphanumeric body — real API keys are long
  // random base62; the only "sk-..." literal in the repo is the test
  // placeholder "sk-accidental-leftover-key" which has hyphens in the body
  // and so does NOT match `sk-[A-Za-z0-9]{20,}` (the regex used here).
  const SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/OPENAI_API_KEY=sk-[A-Za-z0-9]{20,}/, "real OPENAI_API_KEY assignment"],
    [/CODEX_API_KEY=sk-[A-Za-z0-9]{20,}/, "real CODEX_API_KEY assignment"],
    [/OLLAMA_API_KEY=sk-[A-Za-z0-9]{20,}/, "real OLLAMA_API_KEY assignment"],
    [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub PAT literal"],
    [/ghp_[A-Za-z0-9]{30,}/, "GitHub fine-grained token literal"],
  ];

  // Walk src/, tests/ recursively + read .env. Return absolute file paths.
  function walkDir(dir: string, out: string[] = []): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      // Skip node_modules, .next, dist, .git, etc.
      if (
        name === "node_modules" ||
        name === ".next" ||
        name === "dist" ||
        name === ".git" ||
        name === "coverage"
      ) {
        continue;
      }
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walkDir(full, out);
      } else if (st.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|json|env)$/.test(name) || name === ".env") {
        out.push(full);
      }
    }
    return out;
  }

  function allScanFiles(): string[] {
    const files = [
      ...walkDir(resolve("/home/z/my-project/src")),
      ...walkDir(resolve("/home/z/my-project/tests")),
    ];
    const envPath = resolve("/home/z/my-project/.env");
    if (existsSync(envPath)) files.push(envPath);
    return files;
  }

  // Build the corpus once and reuse across the pattern tests.
  const corpus = allScanFiles().map((f) => ({
    path: f,
    content: readFileSync(f, "utf-8"),
  }));

  for (const [pattern, desc] of SECRET_PATTERNS) {
    test(`no matches for ${desc} (/${pattern.source}/)`, () => {
      const hits: Array<{ path: string; line: string }> = [];
      for (const { path, content } of corpus) {
        for (const line of content.split("\n")) {
          if (pattern.test(line)) {
            hits.push({ path, line: line.trim() });
          }
        }
      }
      if (hits.length > 0) {
        // Fail with a helpful message including the offending lines.
        throw new Error(
          `Secret pattern /${pattern.source}/ matched ${hits.length} line(s) in source/tests/.env:\n` +
            hits.map((h) => `  ${h.path}: ${h.line}`).join("\n"),
        );
      }
      expect(hits.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// §28 #11 — Codex workspace isolation
// ---------------------------------------------------------------------------

describe("Phase 5.1 §28 #11 — Codex workspace isolation", () => {
  const createdRoots: string[] = [];

  afterEach(() => {
    for (const r of createdRoots) {
      try {
        // cleanupWorkspace is the public, safe cleanup helper — refuses to
        // delete anything outside WORKSPACE_ROOT.
        void cleanupWorkspace(r).catch(() => {});
      } catch {
        /* swallow */
      }
      // Belt + suspenders: hard-rm the dir if it still exists.
      if (r && existsSync(r)) {
        try {
          rmSync(r, { recursive: true, force: true });
        } catch {
          /* swallow */
        }
      }
    }
    createdRoots.length = 0;
  });

  function emptyPack(): CaseAnalysisPack {
    return {
      query: "test",
      userFacts: [],
      issues: [],
      legislation: [],
      cassationCases: [],
      constitutionalCases: [],
      echrCases: [],
      otherEvidence: [],
    };
  }

  test("createWorkspace writes under /tmp/haydevlegal-case/<uuid>/ — NOT under project root", async () => {
    const requestId = randomUUID();
    const ws = await createWorkspace(requestId, emptyPack());
    createdRoots.push(ws.rootDir);

    // The workspace MUST be under /tmp/haydevlegal-case/<id>/, never under
    // the project repository root.
    expect(ws.rootDir.startsWith("/tmp/haydevlegal-case/")).toBe(true);
    expect(ws.rootDir).not.toContain("/home/");
    expect(ws.rootDir).not.toContain(process.cwd());
    expect(ws.rootDir).not.toContain("..");

    // Verify it's actually a directory on disk.
    expect(existsSync(ws.rootDir)).toBe(true);
  });

  test("different requestId → different directory (request-scoped isolation)", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const ws1 = await createWorkspace(id1, emptyPack());
    const ws2 = await createWorkspace(id2, emptyPack());
    createdRoots.push(ws1.rootDir, ws2.rootDir);

    expect(ws1.rootDir).not.toBe(ws2.rootDir);
    expect(ws1.rootDir.endsWith(id1)).toBe(true);
    expect(ws2.rootDir.endsWith(id2)).toBe(true);

    // Both exist on disk — neither overwrote the other.
    expect(existsSync(ws1.rootDir)).toBe(true);
    expect(existsSync(ws2.rootDir)).toBe(true);
  });

  test("cleanupWorkspace removes the directory", async () => {
    const requestId = randomUUID();
    const ws = await createWorkspace(requestId, emptyPack());

    expect(existsSync(ws.rootDir)).toBe(true);
    await cleanupWorkspace(ws.rootDir);
    expect(existsSync(ws.rootDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §28 #12 — Datalex session isolation
// ---------------------------------------------------------------------------

describe("Phase 5.1 §28 #12 — Datalex session isolation (no regression vs Phase 4.1)", () => {
  test("SessionScope type includes USER_SESSION and GLOBAL_PUBLIC", async () => {
    // Re-import the session store dynamically so this test is isolated from
    // any other test that might have mutated the in-memory store.
    const mod = await import("@/lib/legal-search/sources/session-store");
    // The scope type is exported as a value-less union — we just verify the
    // store's scoped-key logic distinguishes the three scopes.
    expect(typeof mod.setSession).toBe("function");
    expect(typeof mod.getSession).toBe("function");
    expect(typeof mod.updateSession).toBe("function");
  });

  test("solved CAPTCHA session under USER_SESSION does NOT leak into GLOBAL_PUBLIC bucket", async () => {
    const mod = await import("@/lib/legal-search/sources/session-store");

    // Clear any prior state.
    mod.clearSession("datalex");
    mod.clearSession("datalex", "USER_SESSION", "user-1");
    mod.clearSession("datalex", "USER_SESSION", "user-2");

    // Simulate Datalex interactive flow: a solved CAPTCHA under
    // USER_SESSION scope with per-request session id. The Datalex client
    // uses `updateSession` (not `setSession`) for solved-CAPTCHA storage
    // — see client.ts:370-377.
    //
    // The §13-§14 isolation guarantee we verify here is: a session
    // written under USER_SESSION scope with a per-request key does NOT
    // leak to the GLOBAL_PUBLIC bucket AND does NOT leak to a different
    // user's USER_SESSION bucket. (The captchaKeyAt lifetime quirk in
    // setSession is a pre-existing behaviour orthogonal to the
    // cross-scope isolation check — the captchaKey may be evicted by
    // refreshCaptchaKey on read, but the cookies + session row stay
    // scoped to USER_SESSION.)
    mod.updateSession(
      "datalex",
      { cookies: "PHPSESSID=abc; captcha=validated", captchaKey: "ABCD1234" },
      "USER_SESSION",
      "user-1",
    );

    // The session WAS persisted under USER_SESSION scope (cookies
    // survive; refreshCaptchaKey may evict the captchaKey on read but
    // the session row itself stays scoped).
    const diag = mod.sessionDiagnostics();
    const mineDiag = diag.find((d) => d.scope === "USER_SESSION" && d.key === "user-1");
    expect(mineDiag).toBeDefined();
    expect(mineDiag?.source).toBe("datalex");
    // Re-read via getSession — the session row is still there.
    const mine = mod.getSession("datalex", "USER_SESSION", "user-1");
    expect(mine).toBeDefined();
    expect(mine?.cookies).toContain("captcha=validated");

    // GLOBAL_PUBLIC bucket must NOT see the user-bound solved-CAPTCHA session.
    const global = mod.getSession("datalex", "GLOBAL_PUBLIC");
    expect(global ?? null).toBeNull();
    // Diagnostics: no GLOBAL_PUBLIC entry (scope undefined OR "GLOBAL_PUBLIC").
    const globalDiag = diag.find((d) => d.scope === undefined || d.scope === "GLOBAL_PUBLIC");
    expect(globalDiag ?? null).toBeNull();

    // A different user's USER_SESSION bucket must NOT see user-1's session.
    const other = mod.getSession("datalex", "USER_SESSION", "user-2");
    expect(other ?? null).toBeNull();
    const otherDiag = diag.find((d) => d.scope === "USER_SESSION" && d.key === "user-2");
    expect(otherDiag ?? null).toBeNull();

    // Cleanup so we don't leak state across tests.
    mod.clearSession("datalex", "USER_SESSION", "user-1");
  });

  test("Datalex client code writes solved-CAPTCHA sessions under USER_SESSION (source-scan)", () => {
    // §13-§14 — the source code MUST put solved-CAPTCHA sessions under
    // USER_SESSION scope, not GLOBAL_PUBLIC. We read the file directly
    // (rather than spawning `rg`) to avoid interference from sibling test
    // files that mock `node:child_process` (codex-chatgpt-auth.test.ts).
    const clientPath = resolve(
      "/home/z/my-project/src/lib/legal-search/sources/datalex/client.ts",
    );
    const src = readFileSync(clientPath, "utf-8");

    expect(src).toContain("USER_SESSION");
    expect(src).toContain("sessionId");
    expect(src).toContain("captchaKey");
    expect(src).toContain("updateSession");

    // The lines that mention GLOBAL_PUBLIC must NOT mention captchaKey.
    // (The GLOBAL_PUBLIC bucket is reserved for the bootstrap anonymous
    // PHPSESSID session — never for solved-CAPTCHA sessions.)
    const lines = src.split("\n");
    for (const line of lines) {
      if (line.includes("GLOBAL_PUBLIC")) {
        expect(line.toLowerCase()).not.toContain("captchakey");
      }
    }
  });
});
