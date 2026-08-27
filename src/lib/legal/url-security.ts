// src/lib/legal/url-security.ts
// URL allowlist & canonicalization for source citations.
//
// Only ARLIS origins are permitted for citation links. Anything else
// (javascript:, data:, foreign hosts) is rejected.

export const ARLIS_ORIGINS = new Set<string>([
  "https://arlis.am",
  "https://www.arlis.am",
  "http://arlis.am",
  "http://www.arlis.am",
]);

/**
 * Canonicalize and validate an ARLIS URL.
 * Returns the safe absolute URL, or null if rejected.
 */
export function canonicalizeArlisUrl(raw: string): string | null {
  if (!raw) return null;
  // Reject obvious injection schemes early
  if (/^\s*javascript:/i.test(raw)) return null;
  if (/^\s*data:/i.test(raw)) return null;
  if (/^\s*vbscript:/i.test(raw)) return null;

  let url: URL;
  try {
    // ARLIS returns site-relative hrefs like "/hy/acts/6/latest"
    url = new URL(raw, "https://arlis.am");
  } catch {
    return null;
  }

  // Force https
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  const origin = `${url.protocol}//${url.host}`;
  if (!ARLIS_ORIGINS.has(origin)) return null;

  // Strip fragment for canonical comparison (acts page is the same)
  url.hash = "";
  return url.toString();
}

/** Build the canonical ARLIS act URL from an actId. */
export function arlisActUrl(actId: string | number | undefined): string | null {
  if (actId === undefined || actId === null || actId === "") return null;
  const id = String(actId).trim();
  if (!/^\d+$/.test(id)) return null;
  return `https://arlis.am/hy/acts/${id}/latest`;
}
