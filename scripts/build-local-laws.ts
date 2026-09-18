// scripts/build-local-laws.ts
// One-time corpus builder: fetches the CORE Armenian laws from the live ARLIS
// (exactly as the site serves them) and converts them to structured Markdown
// under legal-data/am/<category>/<act>.md with provenance frontmatter.
//
// Run: bun scripts/build-local-laws.ts
//
// The corpus is a CURATED SNAPSHOT (spec §6): never the absolute truth.
// Date-sensitive queries must cross-check the official online source.
//
// Parsing strategy: ARLIS renders acts as sequences of article-heading
// markers ("Հոդված N.") followed by <P>-paragraph bodies. We split on
// markers (structure-agnostic) and prefer the CURRENT (Գործունակ) act card.

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(ROOT, "legal-data", "am");

const ARLIS_BASE = "https://arlis.am";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type ActSpec = {
  category: string;
  file: string;
  search: string;
  titleMustInclude: string;
  /** Verified current actId on ARLIS (preferred when the search order shifts). */
  preferredActId?: string;
};

const ACTS: ActSpec[] = [
  { category: "constitution", file: "constitution.md", search: "ՀՀ Սահմանադրություն", titleMustInclude: "ՍԱՀՄԱՆԱԴՐՈՒԹՅՈՒՆ", preferredActId: "75780" },
  { category: "criminal-code", file: "criminal-code.md", search: "ՀՀ քրեական օրենսգիրք", titleMustInclude: "ՔՐԵԱԿԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "230013" },
  { category: "criminal-procedure-code", file: "criminal-procedure-code.md", search: "ՀՀ քրեական դատավարության օրենսգիրք", titleMustInclude: "ՔՐԵԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "230458" },
  { category: "civil-code", file: "civil-code.md", search: "ՀՀ քաղաքացիական օրենսգիրք", titleMustInclude: "ՔԱՂԱՔԱՑԻԱԿԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "230025" },
  { category: "civil-procedure-code", file: "civil-procedure-code.md", search: "ՀՀ քաղաքացիական դատավարության օրենսգիրք", titleMustInclude: "ՔԱՂԱՔԱՑԻԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "230005" },
  { category: "administrative-procedure-code", file: "administrative-procedure-code.md", search: "ՀՀ վարչական դատավարության օրենսգիրք", titleMustInclude: "ՎԱՐՉԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "229991" },
  { category: "administrative-offences", file: "administrative-offences-code.md", search: "վարչական իրավախախտումների վերաբերյալ", titleMustInclude: "ՎԱՐՉԱԿԱՆ ԻՐԱՎԱԽԱԽՈՒՄՆԵՐԻ", preferredActId: "230427" },
  { category: "judicial-code", file: "judicial-code.md", search: "ՀՀ դատական օրենսգիրք", titleMustInclude: "ԴԱՏԱԿԱՆ ՕՐԵՆՍԳԻՐՔ", preferredActId: "227243" },
  { category: "bankruptcy", file: "bankruptcy-law.md", search: "սնանկության մասին", titleMustInclude: "ՍՆԱՆԿՈՒԹՅԱՆ ՄԱՍԻՆ", preferredActId: "230438" },
];

async function fetchJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "X-REQUESTED-WITH": "XMLHttpRequest",
        Accept: "application/json",
        "User-Agent": UA,
        Referer: `${ARLIS_BASE}/hy/`,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchHtml(url: string, timeoutMs = 45000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA, Referer: `${ARLIS_BASE}/hy/` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

type Card = { actId: string; title: string; status?: string; number?: string };

function parseActCards(html: string): Card[] {
  const out: Card[] = [];
  const blocks = html.split(/<div\s+class="act-card[\s"]/i).slice(1);
  for (const block of blocks) {
    const linkM = block.match(/\/hy\/acts\/(\d+)(?:\/latest)?/i);
    if (!linkM) continue;
    const actId = linkM[1];
    let title = "";
    const spanM = block.match(/<span[^>]*class="[^"]*text-content[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (spanM) title = spanM[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    let status: string | undefined;
    const stM =
      block.match(/act-card__status[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ??
      block.match(/Կարգավիճակ[^<]*<\/div>\s*<div[^>]*>[\s\S]{0,120}?<span>([^<]+)<\/span>/i);
    if (stM) status = stM[1].trim();
    out.push({ actId, title: title || `ARLIS ${actId}`, status });
  }
  return out;
}

/** Strip HTML to plain text, paragraph-aware. */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

type Article = { num: string; title: string; body: string };

/**
 * Split an ARLIS act page into articles using "Հոդված N." markers.
 * Structure-agnostic: works for table-row and paragraph renderings.
 */
function extractArticles(html: string): { articles: Article[]; preface: string } {
  const markerRe = /Հոդված\s*(\d{1,4})\s*[.։:]\s*/gu;
  const markers: Array<{ num: string; idx: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(html)) !== null) {
    markers.push({ num: m[1], idx: m.index, end: m.index + m[0].length });
  }

  const preface = markers.length > 0 ? stripTags(html.slice(0, markers[0].idx)) : stripTags(html);

  const byNum = new Map<string, Article>();
  for (let i = 0; i < markers.length; i++) {
    const seg = html.slice(markers[i].end, i + 1 < markers.length ? markers[i + 1].idx : html.length);
    const text = stripTags(seg);
    if (!text) continue;
    const lines = text.split("\n");
    // First line (or two) = article title; rest = body.
    let title = "";
    let bodyStart = 0;
    if (lines.length > 1 && lines[0].length < 200) {
      title = lines[0];
      bodyStart = 1;
    } else if (lines.length > 2 && lines[1].length < 200) {
      title = lines[1];
      bodyStart = 2;
    }
    const body = lines.slice(bodyStart).join("\n").trim();
    const num = markers[i].num;
    const prev = byNum.get(num);
    // Keep the longest extraction per article number (TOC vs body duplicates).
    if (!prev || (title + body).length > (prev.title + prev.body).length) {
      byNum.set(num, { num, title, body });
    }
  }

  const articles = Array.from(byNum.values()).sort((a, b) => Number(a.num) - Number(b.num));
  return { articles, preface: preface.slice(0, 2000) };
}

function toMarkdown(actTitle: string, articles: Article[], preface: string): string {
  const out: string[] = [`# ${actTitle}`, ""];
  if (preface && preface.length > 60) {
    out.push("## Նախաբան", "", preface, "");
  }
  for (const a of articles) {
    out.push(`## Հոդված ${a.num}${a.title ? ` ${a.title}` : ""}`, "");
    if (a.body) out.push(a.body, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

async function buildAct(spec: ActSpec): Promise<{ ok: boolean; detail: string }> {
  try {
    const params = encodeURIComponent(JSON.stringify({ simple_text: spec.search }));
    const searchUrl = `${ARLIS_BASE}/hy/search/page/1?${params}&order_by=`;
    const data = (await fetchJson(searchUrl)) as { status?: number; html?: string };
    if (data.status !== 0 || !data.html) {
      return { ok: false, detail: `search failed for "${spec.search}"` };
    }
    const cards = parseActCards(data.html);

    // Prefer: verified actId, then current status (Գործում է) + title match.
    const titleMatch = (c: Card) =>
      c.title.toUpperCase().includes(spec.titleMustInclude) ||
      spec.titleMustInclude.includes(c.title.toUpperCase());
    const preferred = spec.preferredActId ? cards.find((c) => c.actId === spec.preferredActId) : undefined;
    const current = cards.filter((c) => titleMatch(c) && /գործունակ|գործում/i.test(c.status ?? ""));
    const card = preferred ?? (current.length > 0 ? current[0] : cards.find(titleMatch));
    if (!card) {
      return { ok: false, detail: `act not found for "${spec.search}" (cards: ${cards.length})` };
    }

    const html = await fetchHtml(`${ARLIS_BASE}/hy/acts/${card.actId}/latest`);
    const { articles, preface } = extractArticles(html);
    if (articles.length === 0) {
      return { ok: false, detail: `${spec.category}: 0 articles parsed (actId ${card.actId})` };
    }

    const title = card.title.replace(/\s+/g, " ").trim();
    const markdown = toMarkdown(title, articles, preface);

    const dir = join(OUT_ROOT, spec.category);
    await mkdir(dir, { recursive: true });
    const fm = [
      "---",
      "source: ARLIS (https://arlis.am)",
      `actId: ${card.actId}`,
      `actNumber: ${card.number ?? "unknown"}`,
      `status: ${card.status ?? "unknown"}`,
      `retrievedAt: ${new Date().toISOString()}`,
      `canonicalUrl: https://arlis.am/hy/acts/${card.actId}/latest`,
      "---",
      "",
    ].join("\n");

    await writeFile(join(dir, spec.file), fm + markdown, "utf-8");

    return {
      ok: true,
      detail: `${title.slice(0, 55)} [${card.status ?? "?"}] → ${spec.category}/${spec.file} (${(markdown.length / 1024).toFixed(0)} KB, ${articles.length} հոդված)`,
    };
  } catch (err) {
    return { ok: false, detail: `${spec.category}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main() {
  console.log("Building local corpus from live ARLIS…\n");
  const results: Array<{ ok: boolean; detail: string }> = [];
  for (const spec of ACTS) {
    const r = await buildAct(spec);
    results.push(r);
    console.log(`${r.ok ? "✓" : "✗"} ${r.detail}`);
  }
  const ok = results.filter((x) => x.ok).length;
  console.log(`\nDone: ${ok}/${results.length} acts saved to ${OUT_ROOT}`);
  if (ok === 0) process.exit(1);
}

main();
