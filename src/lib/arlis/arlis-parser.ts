// src/lib/arlis/arlis-parser.ts
// Parses ARLIS HTML responses into structured LegalSource candidates.
//
// Two parsing paths:
//   1. parseSearchHtml(html)  -> raw act-card candidates
//   2. extractArticle(html, articleNumber) -> { title, body } for grounding
//
// All HTML is treated as UNTRUSTED. We never inject raw ARLIS HTML into the
// DOM; we extract plain text only and escape at render time.

import { stripHtml } from "@/lib/legal/normalizer";

export type RawCandidate = {
  actId?: string;
  canonicalUrl?: string;
  title: string;
  actNumber?: string;
  adoptionDate?: string;
  effectiveDate?: string;
  status?: string;
  excerpt: string;
};

const ABOUT_LABELS = {
  number: "Ակտի համար",
  adoption: "Ընդունման ամսաթիվ",
  effective: "Ուժի մեջ մտնելու ամսաթիվ",
  status: "Կարգավիճակ",
} as const;

/** Parse the JSON search response HTML into raw act-card candidates. */
export function parseSearchHtml(html: string): RawCandidate[] {
  if (!html) return [];
  const out: RawCandidate[] = [];
  // Split on act-card boundaries. Each card is a self-contained block.
  const cards = html.split(/<div\s+class="act-card[\s"]/i);
  // skip index 0 (preamble before first card)
  for (let i = 1; i < cards.length; i++) {
    const block = cards[i];
    const cand = parseActCard(block);
    if (cand) out.push(cand);
  }
  return out;
}

function parseActCard(block: string): RawCandidate | null {
  // Title + canonical URL: first <a href="/hy/acts/{id}/latest"> inside act-card__title
  const linkRe = /<a[^>]*href="([^"]*\/hy\/acts\/(\d+)(?:\/latest)?)"/i;
  const linkM = block.match(linkRe);
  let canonicalUrl: string | undefined;
  let actId: string | undefined;
  if (linkM) {
    actId = linkM[2];
    // Build canonical absolute URL
    canonicalUrl = `https://arlis.am${linkM[1].startsWith("/") ? linkM[1] : `/${linkM[1]}`}`;
    if (!/\/latest$/.test(canonicalUrl)) canonicalUrl = `${canonicalUrl}/latest`;
  }

  // Title text: content of the <span class="text-content ...">...</span> within the title link.
  let title = "";
  const titleSpanRe = /<span[^>]*class="[^"]*text-content[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
  const titleM = block.match(titleSpanRe);
  if (titleM) {
    title = stripHtml(titleM[1]).replace(/\s+/g, " ").trim();
  }
  if (!title) {
    // Fallback: title link's inner text
    const fallbackRe = /<a[^>]*href="[^"]*\/hy\/acts\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
    const fb = block.match(fallbackRe);
    if (fb) title = stripHtml(fb[1]).replace(/\s+/g, " ").trim();
  }
  if (!title && !actId) return null;

  // about-item blocks: each item is <div class="act-card__about-item">
  //   <div class="act-card__about-title">LABEL`</div>
  //   <div class="act-card__about-value|act-card__status|...">VALUE</div>
  // We split on about-item boundaries and parse each block.
  const itemRe = /<div[^>]*class="[^"]*act-card__about-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*act-card__about-item|<div[^>]*class="[^"]*mobile-collapsible|<\/div>\s*<\/div>\s*<\/div>)/gi;
  let im: RegExpExecArray | null;
  let actNumber: string | undefined;
  let adoptionDate: string | undefined;
  let effectiveDate: string | undefined;
  let status: string | undefined;
  while ((im = itemRe.exec(block)) !== null) {
    const itemHtml = im[1];
    // Label
    const labelM = itemHtml.match(
      /<div[^>]*class="[^"]*act-card__about-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (!labelM) continue;
    const label = stripHtml(labelM[1]).replace(/[:`\s]+/g, " ").trim();
    // Value: first div after the title that isn't another title.
    // Try act-card__about-value, then act-card__status, then any sibling div.
    let value = "";
    const valM = itemHtml.match(
      /<div[^>]*class="[^"]*act-card__about-value[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    );
    if (valM) {
      value = stripHtml(valM[1]).replace(/\s+/g, " ").trim();
    } else {
      const stM = itemHtml.match(
        /<div[^>]*class="[^"]*act-card__status[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      );
      if (stM) {
        value = stripHtml(stM[1]).replace(/\s+/g, " ").trim();
      }
    }
    if (!label || !value) continue;
    if (label.includes(ABOUT_LABELS.number)) actNumber = value;
    else if (label.includes(ABOUT_LABELS.adoption)) adoptionDate = value;
    else if (label.includes(ABOUT_LABELS.effective)) effectiveDate = value;
    else if (label.includes(ABOUT_LABELS.status)) status = value;
  }

  // Excerpt: we don't get a body snippet from ARLIS list — synthesize from metadata.
  const parts: string[] = [];
  if (title) parts.push(title);
  if (actNumber) parts.push(`Ակտի համար՝ ${actNumber}`);
  if (adoptionDate) parts.push(`Ընդունման ամսաթիվ՝ ${adoptionDate}`);
  if (effectiveDate) parts.push(`Ուժի մեջ մտնելու ամսաթիվ՝ ${effectiveDate}`);
  if (status) parts.push(`Կարգավիճակ՝ ${status}`);
  const excerpt = parts.join(" · ");

  return {
    actId,
    canonicalUrl,
    title: title || (actId ? `ARLIS ակտ ${actId}` : ""),
    actNumber,
    adoptionDate,
    effectiveDate,
    status,
    excerpt,
  };
}

export type ArticleExcerpt = {
  articleNumber: string;
  title: string;
  body: string;
};

/**
 * Extract a specific article's text from an ARLIS act-detail HTML page.
 *
 * ARLIS renders acts as a giant <table>; each article is a row whose first
 * cell contains "Հոդված {N}." and whose second cell contains the body.
 * We also support the case where the article is split across multiple rows.
 */
export function extractArticle(html: string, articleNumber: string): ArticleExcerpt | null {
  if (!html || !articleNumber) return null;
  const num = String(articleNumber).trim();
  // Match "Հոդված 108." or "Հոդված 108 " (allow trailing dot/space/colon)
  const articleRe = new RegExp(
    `Հոդված\\s*${escapeRegExp(num)}\\s*[.\\u0589:]?`,
    "u",
  );

  // Find all article markers; pick the one whose number matches.
  const markers: Array<{ idx: number; num: string }> = [];
  const re = /Հոդված\s*(\d{1,4})\s*[.\u0589:]?/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    markers.push({ idx: m.index, num: m[1] });
  }
  const target = markers.find((mk) => mk.num === num);
  if (!target) return null;

  // Find the next article marker to bound the slice.
  const next = markers.find((mk) => mk.idx > target.idx);
  const sliceEnd = next ? next.idx : Math.min(html.length, target.idx + 20000);
  const slice = html.slice(target.idx, sliceEnd);

  // The article title is the text on the same line as "Հոդված {N}."
  // up to the next <TD> boundary or newline.
  const afterMarker = slice.slice(articleRe.exec(slice)![0].length);
  // Title = text up to the first newline (after stripping tags) or first "&nbsp;"
  let titleText = "";
  const titlePart = afterMarker.split(/<TD/i)[0] ?? "";
  titleText = stripHtml(titlePart).split("\n")[0]?.trim() ?? "";

  // Body = full stripped slice minus the title prefix
  const fullText = stripHtml(slice).trim();
  let body = fullText;
  if (titleText && body.startsWith(titleText)) {
    body = body.slice(titleText.length).trim();
  }
  // Truncate very long bodies for grounding context (keep first ~4000 chars)
  if (body.length > 4000) body = `${body.slice(0, 4000)}…`;

  return {
    articleNumber: num,
    title: titleText || `Հոդված ${num}`,
    body,
  };
}

/** Find the act title from the act-detail page <title> tag. */
export function extractActTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!m) return undefined;
  const t = stripHtml(m[1]).trim();
  return t || undefined;
}

/** Find act status text from the act-detail page (look for status badges). */
export function extractActStatus(html: string): string | undefined {
  // ARLIS shows status with .act-status or content-tag elements.
  // Look for "Գործունակ" / "Չի գործունակ" / "Գործում է" / "Ուժը կորցրել է".
  const re =
    /(Գործունակ|Չի\s*գործունակ|Գործում\s+է|Ուժը\s+կորցրել\s+է|Ընդունված\s+չէ)/u;
  const m = html.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
