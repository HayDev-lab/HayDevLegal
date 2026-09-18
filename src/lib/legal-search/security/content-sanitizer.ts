// src/lib/legal-search/security/content-sanitizer.ts
// Untrusted content sanitization for documents fetched from external sources.
//
// External HTML/PDF content is NEVER rendered or injected raw. We extract
// plain text, strip active content, remove navigation chrome, and bound sizes.

import { stripHtml } from "@/lib/legal/normalizer";

const NAV_CLASSES =
  /(nav|menu|footer|header|sidebar|breadcrumb|pagination|cookie|banner|social|share|comment|advert)/i;

/** Structural block tags used to split text. */
const BLOCK_SPLIT_RE = /<\/(p|div|tr|li|h[1-6]|td|section|article|blockquote)>/gi;

/**
 * Extract the main legal text from a fetched HTML page.
 * Pipeline (per spec §15):
 *   HTML -> remove scripts/styles/nav -> extract text -> detect structure
 */
export function extractMainText(html: string, opts: { maxChars?: number } = {}): string {
  if (!html) return "";
  const maxChars = opts.maxChars ?? 200_000;

  let s = html;

  // Remove active content first (defense in depth — stripHtml repeats this).
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Drop elements that look like site chrome by class/id heuristic.
  // (Cheap approximation of removing navigation: remove whole tagged blocks
  // whose class/id matches chrome patterns.)
  s = s.replace(
    /<(div|nav|aside|footer|header|section|ul|span)[^>]*(?:class|id)\s*=\s*["'][^"']*["'][^>]*>[\s\S]{0,4000}?<\/\1>/gi,
    (block) => {
      const attrMatch = block.match(/(?:class|id)\s*=\s*["']([^"']*)["']/i);
      return attrMatch && NAV_CLASSES.test(attrMatch[1]) ? " " : block;
    },
  );

  // Structural newlines before generic stripping.
  s = s.replace(BLOCK_SPLIT_RE, "\n");

  const text = stripHtml(s);

  // Collapse >2 consecutive blank lines.
  const collapsed = text.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.slice(0, maxChars);
}

/** Normalize whitespace for hashing / comparison. */
export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .replace(/[«»"'ʼ՚،؛,.:;!?()\[\]{}—–-]/g, "")
    .trim();
}

/** Truncate a passage at a sentence boundary when possible. */
export function truncatePassage(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  // Prefer sentence enders (Armenian full stop, period, semicolon).
  const idx = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("։ "), cut.lastIndexOf("; "), cut.lastIndexOf(".\n"));
  if (idx > maxChars * 0.5) return cut.slice(0, idx + 1).trim();
  return `${cut.trim()}…`;
}
