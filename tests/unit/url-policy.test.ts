// tests/unit/url-policy.test.ts
// SSRF protection unit tests (spec §28).

import { describe, expect, test } from "bun:test";
import { checkUrlSafe, contentHash } from "@/lib/legal-search/security/url-policy";
import { normalizeForHash } from "@/lib/legal-search/security/content-sanitizer";

describe("checkUrlSafe (SSRF policy)", () => {
  test("allows public https URLs", () => {
    expect(checkUrlSafe("https://arlis.am/hy/acts/6/latest").ok).toBe(true);
    expect(checkUrlSafe("https://concourt.am/decisions/advanced-search").ok).toBe(true);
    expect(checkUrlSafe("https://datalex.am/?app=AppCaseSearch").ok).toBe(true);
  });

  test("blocks localhost and loopback", () => {
    expect(checkUrlSafe("http://localhost/admin").ok).toBe(false);
    expect(checkUrlSafe("http://127.0.0.1:3000/x").ok).toBe(false);
    expect(checkUrlSafe("http://0.0.0.0/").ok).toBe(false);
    expect(checkUrlSafe("http://[::1]/").ok).toBe(false);
    expect(checkUrlSafe("http://localhost.localdomain/").ok).toBe(false);
  });

  test("blocks private ranges", () => {
    expect(checkUrlSafe("http://10.0.0.1/x").ok).toBe(false);
    expect(checkUrlSafe("http://192.168.1.1/router").ok).toBe(false);
    expect(checkUrlSafe("http://172.16.0.5/internal").ok).toBe(false);
    expect(checkUrlSafe("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(checkUrlSafe("http://172.20.0.1:8080/").ok).toBe(false);
  });

  test("blocks link-local IPv6 and unique-local IPv6", () => {
    expect(checkUrlSafe("http://[fe80::1]/").ok).toBe(false);
    expect(checkUrlSafe("http://[fc00::1]/").ok).toBe(false);
    expect(checkUrlSafe("http://[fd12:3456:789a::1]/").ok).toBe(false);
  });

  test("blocks cloud metadata host", () => {
    expect(checkUrlSafe("http://metadata.google.internal/computeMetadata/v1/").ok).toBe(false);
  });

  test("blocks non-http schemes", () => {
    expect(checkUrlSafe("javascript:alert(1)").ok).toBe(false);
    expect(checkUrlSafe("data:text/html,hello").ok).toBe(false);
    expect(checkUrlSafe("file:///etc/passwd").ok).toBe(false);
    expect(checkUrlSafe("ftp://arlis.am/x").ok).toBe(false);
  });

  test("blocks malformed URLs", () => {
    expect(checkUrlSafe("").ok).toBe(false);
    expect(checkUrlSafe("not a url").ok).toBe(false);
    expect(checkUrlSafe("http://").ok).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 loopback", () => {
    expect(checkUrlSafe("http://[::ffff:127.0.0.1]/x").ok).toBe(false);
    expect(checkUrlSafe("http://[::ffff:169.254.169.254]/meta").ok).toBe(false);
  });
});

describe("contentHash / normalizeForHash", () => {
  test("hash is stable and different for different text", () => {
    const h1 = contentHash("հոդված 179");
    expect(contentHash("հոդված 179")).toBe(h1);
    expect(contentHash("հոդված 180")).not.toBe(h1);
  });

  test("normalizeForHash collapses whitespace and punctuation", () => {
    expect(normalizeForHash("Ողջույն, աշխարհ")).toBe(normalizeForHash("ողջույն աշխարհ"));
  });
});
