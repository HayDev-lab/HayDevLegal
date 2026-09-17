// src/lib/local-laws/loader.ts
// Curated local corpus loader (spec §6-§7).
//
// Reads the structured Markdown snapshot under legal-data/am/<category>/<act>.md
// (built by scripts/build-local-laws.ts from the live ARLIS) and turns it into
// an in-memory article index with provenance frontmatter preserved.
//
// The corpus is a CURATED SNAPSHOT — never the absolute truth. Every result
// carries the ARLIS canonicalUrl + retrievedAt so date-sensitive answers can
// cross-check the official online source. There is NO RAG database and NO
// vector store: retrieval is deterministic lexical + concept matching.
//
// Loading is lazy (first search), memoized per directory, and fail-closed:
// a missing or unreadable corpus yields an EMPTY corpus — never a crash.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tokenize } from "@/lib/legal/normalizer";

// ---------------------------------------------------------------------------
// Corpus model
// ---------------------------------------------------------------------------

export type LocalLawArticle = {
  /** Article number, e.g. "179". "0" = the act preface (Նախաբան). */
  num: string;
  /** Article heading title (may be empty). */
  title: string;
  /** Full article body (plain text). */
  body: string;
  /** Lowercased body for phrase containment checks. */
  bodyLower: string;
  /** First ~300 chars of the body, cleaned for excerpts. */
  excerpt: string;
  /** Index of the owning act in corpus.acts. */
  actIdx: number;
  /** Lowercased title text (heading line). */
  titleLower: string;
};

export type LocalLawAct = {
  /** Corpus category (= directory name), e.g. "criminal-code". */
  category: string;
  /** ARLIS numeric act id from provenance frontmatter. */
  actId: string;
  /** Act number when ARLIS exposed one (often "unknown"). */
  actNumber?: string;
  /** Full act title (first "# " heading). */
  title: string;
  /** Clean curated short title for result rendering. */
  shortTitle: string;
  /** Status label from frontmatter, e.g. "Գործում է". */
  status?: string;
  /** When the snapshot was taken from ARLIS (ISO). */
  retrievedAt?: string;
  /** Canonical ARLIS URL of the act. */
  canonicalUrl: string;
  /** Articles sorted by number; preface kept as num "0". */
  articles: LocalLawArticle[];
  /** Fast exact-number lookup. */
  byNum: Map<string, LocalLawArticle>;
  /** Lowercased short title + aliases for act resolution. */
  searchText: string;
};

export type LocalLawCorpus = {
  acts: LocalLawAct[];
  /** Flat article list for the inverted indexes below. */
  flat: LocalLawArticle[];
  /** exact body word form -> article indices. */
  bodyIndex: Map<string, number[]>;
  /** 5-char prefix of body tokens (len>=6) -> article indices (inflection fallback). */
  bodyPrefixIndex: Map<string, number[]>;
  /** exact title word form -> article indices. */
  titleIndex: Map<string, number[]>;
  stats: {
    acts: number;
    articles: number;
    bytes: number;
    loadedAt: string;
    dir: string;
  };
};

// ---------------------------------------------------------------------------
// Curated metadata per category (deterministic, no guessing from messy H1s)
// ---------------------------------------------------------------------------

type CategoryMeta = {
  shortTitle: string;
  /** Extra query aliases beyond ABBREVIATIONS (word-boundary matched). */
  aliases: string[];
};

const CATEGORY_META: Record<string, CategoryMeta> = {
  constitution: {
    shortTitle: "ՀՀ Սահմանադրություն",
    aliases: ["սահմանադրություն", "սահմանադրական"],
  },
  "criminal-code": {
    shortTitle: "ՀՀ քրեական օրենսգիրք",
    aliases: ["քրեական օրենսգիրք", "քրեական օրենք"],
  },
  "criminal-procedure-code": {
    shortTitle: "ՀՀ քրեական դատավարության օրենսգիրք",
    aliases: ["քրեական դատավարության օրենսգիրք", "քրեական դատավարություն"],
  },
  "civil-code": {
    shortTitle: "ՀՀ քաղաքացիական օրենսգիրք",
    aliases: ["քաղաքացիական օրենսգիրք"],
  },
  "civil-procedure-code": {
    shortTitle: "ՀՀ քաղաքացիական դատավարության օրենսգիրք",
    aliases: ["քաղաքացիական դատավարության օրենսգիրք", "քաղաքացիական դատավարություն"],
  },
  "administrative-procedure-code": {
    shortTitle: "ՀՀ վարչական դատավարության օրենսգիրք",
    aliases: ["վարչական դատավարության օրենսգիրք", "վարչական դատավարություն"],
  },
  "administrative-offences": {
    shortTitle: "ՀՀ վարչական իրավախախտումների վերաբերյալ օրենսգիրք",
    aliases: ["վարչական իրավախախտումների"],
  },
  "judicial-code": {
    shortTitle: "ՀՀ դատական օրենսգիրք",
    aliases: ["դատական օրենսգիրք"],
  },
  bankruptcy: {
    shortTitle: "ՀՀ սնանկության մասին օրենք",
    aliases: ["սնանկության մասին", "սնանկության"],
  },
};

// ---------------------------------------------------------------------------
// Markdown parsing (structure mirrors scripts/build-local-laws.ts output)
// ---------------------------------------------------------------------------

type Frontmatter = {
  actId: string;
  actNumber?: string;
  status?: string;
  retrievedAt?: string;
  canonicalUrl: string;
};

function parseFrontmatter(md: string): { fm: Frontmatter; rest: string } {
  const fm: Frontmatter = { actId: "", canonicalUrl: "" };
  let rest = md;
  if (!md.startsWith("---")) return { fm, rest };
  const end = md.indexOf("\n---", 3);
  if (end < 0) return { fm, rest };
  const block = md.slice(3, end);
  rest = md.slice(end + 4).replace(/^\r?\n/, "");
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim().replace(/^["']|["']$/g, "");
    if (key === "actId") fm.actId = val;
    else if (key === "actNumber") fm.actNumber = val === "unknown" ? undefined : val;
    else if (key === "status") fm.status = val;
    else if (key === "retrievedAt") fm.retrievedAt = val;
    else if (key === "canonicalUrl") fm.canonicalUrl = val;
  }
  return { fm, rest };
}

const ARTICLE_HEADING = /^##\s+Հոդված\s+(\d{1,4})\s*(.*)$/;
const PREFACE_HEADING = /^##\s+Նախաբան\s*$/;
const H1 = /^#\s+(.+)$/;

type ParsedArticle = { num: string; title: string; body: string };

function parseActMarkdown(md: string): {
  title: string;
  preface: string;
  articles: ParsedArticle[];
} {
  const { rest } = parseFrontmatter(md);
  const lines = rest.split("\n");

  let title = "";
  const prefaceLines: string[] = [];
  const articles: ParsedArticle[] = [];

  let mode: "scan" | "preface" | "article" = "scan";
  let current: ParsedArticle | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (mode === "article" && current) {
      current.body = currentLines.join("\n").trim();
      if (current.body || current.title) articles.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (mode === "scan") {
      const h1 = line.match(H1);
      if (h1 && !title) {
        title = h1[1].trim();
        continue;
      }
      if (PREFACE_HEADING.test(line)) {
        mode = "preface";
        continue;
      }
      const art = line.match(ARTICLE_HEADING);
      if (art) {
        mode = "article";
        current = { num: art[1], title: art[2].trim(), body: "" };
        currentLines = [];
        continue;
      }
      continue;
    }

    if (mode === "preface") {
      const art = line.match(ARTICLE_HEADING);
      if (art) {
        mode = "article";
        current = { num: art[1], title: art[2].trim(), body: "" };
        currentLines = [];
        continue;
      }
      prefaceLines.push(line);
      continue;
    }

    // mode === "article"
    const art = line.match(ARTICLE_HEADING);
    if (art) {
      flush();
      current = { num: art[1], title: art[2].trim(), body: "" };
      currentLines = [];
      continue;
    }
    // Ignore deeper headings inside an article body (chapters etc.).
    if (/^#{3,}\s/.test(line)) continue;
    currentLines.push(line);
  }
  flush();

  // Keep the LONGEST body per article number (TOC vs body duplicates safety).
  const byNum = new Map<string, ParsedArticle>();
  for (const a of articles) {
    const prev = byNum.get(a.num);
    if (!prev || (a.title + a.body).length > (prev.title + prev.body).length) {
      byNum.set(a.num, a);
    }
  }

  const sorted = Array.from(byNum.values()).sort(
    (a, b) => Number(a.num) - Number(b.num),
  );
  return { title, preface: prefaceLines.join("\n").trim(), articles: sorted };
}

// ---------------------------------------------------------------------------
// Corpus loading (lazy, memoized per directory, fail-closed)
// ---------------------------------------------------------------------------

const DEFAULT_DIR_CANDIDATES = (): string[] => {
  const cands: string[] = [];
  if (process.env.LOCAL_LAWS_DIR) cands.push(process.env.LOCAL_LAWS_DIR);
  // dev / test: cwd is the repo root.
  cands.push(join(process.cwd(), "legal-data", "am"));
  // production standalone: cwd is .next/standalone.
  cands.push(join(process.cwd(), "..", "..", "legal-data", "am"));
  return cands;
};

const corpusCache = new Map<string, LocalLawCorpus>();
let defaultCorpus: LocalLawCorpus | null = null;

function makeExcerpt(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function loadFromDir(dir: string): Promise<LocalLawCorpus | null> {
  let categories: string[];
  try {
    categories = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }

  const acts: LocalLawAct[] = [];
  let bytes = 0;

  for (const category of categories) {
    const catDir = join(dir, category);
    let files: string[];
    try {
      files = (await readdir(catDir)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const raw = await readFile(join(catDir, file), "utf-8");
        bytes += raw.length;
        const { fm } = parseFrontmatter(raw);
        const parsed = parseActMarkdown(raw);
        if (parsed.articles.length === 0) continue;
        if (!fm.canonicalUrl) continue;

        const meta = CATEGORY_META[category] ?? {
          shortTitle: parsed.title || category,
          aliases: [] as string[],
        };

        const actIdx = acts.length;
        const articles: LocalLawArticle[] = [];
        const act: LocalLawAct = {
          category,
          actId: fm.actId || `${category}:${file}`,
          actNumber: fm.actNumber,
          title: parsed.title || meta.shortTitle,
          shortTitle: meta.shortTitle,
          status: fm.status,
          retrievedAt: fm.retrievedAt,
          canonicalUrl: fm.canonicalUrl,
          articles,
          byNum: new Map(),
          searchText: [meta.shortTitle, ...meta.aliases].join(" | ").toLowerCase(),
        };

        if (parsed.preface && parsed.preface.length > 60) {
          const pre: LocalLawArticle = {
            num: "0",
            title: "Նախաբան",
            body: parsed.preface,
            bodyLower: parsed.preface.toLowerCase(),
            excerpt: makeExcerpt(parsed.preface),
            actIdx,
            titleLower: "նախաբան",
          };
          articles.push(pre);
          act.byNum.set("0", pre);
        }

        for (const a of parsed.articles) {
          const art: LocalLawArticle = {
            num: a.num,
            title: a.title,
            body: a.body,
            bodyLower: a.body.toLowerCase(),
            excerpt: makeExcerpt(a.body),
            actIdx,
            titleLower: a.title.toLowerCase(),
          };
          articles.push(art);
          act.byNum.set(a.num, art);
        }

        acts.push(act);
      } catch {
        // Unreadable/corrupt file: skip it, keep the rest of the corpus.
      }
    }
  }

  if (acts.length === 0) return null;

  // Flat article list + inverted indexes.
  const flat: LocalLawArticle[] = [];
  for (const act of acts) {
    for (const art of act.articles) flat.push(art);
  }
  const bodyIndex = new Map<string, number[]>();
  const bodyPrefixIndex = new Map<string, number[]>();
  const titleIndex = new Map<string, number[]>();

  flat.forEach((art, idx) => {
    const bodyTokens = new Set(tokenize(art.body));
    for (const t of bodyTokens) {
      if (t.length < 3 || /^\d+$/.test(t)) continue;
      const list = bodyIndex.get(t);
      if (list) list.push(idx);
      else bodyIndex.set(t, [idx]);
      if (t.length >= 6) {
        const p = t.slice(0, 5);
        const plist = bodyPrefixIndex.get(p);
        if (plist) {
          if (plist[plist.length - 1] !== idx) plist.push(idx);
        } else {
          bodyPrefixIndex.set(p, [idx]);
        }
      }
    }
    for (const t of new Set(tokenize(art.title))) {
      if (t.length < 3 || /^\d+$/.test(t)) continue;
      const list = titleIndex.get(t);
      if (list) list.push(idx);
      else titleIndex.set(t, [idx]);
    }
  });

  return {
    acts,
    flat,
    bodyIndex,
    bodyPrefixIndex,
    titleIndex,
    stats: {
      acts: acts.length,
      articles: flat.length,
      bytes,
      loadedAt: new Date().toISOString(),
      dir,
    },
  };
}

/**
 * Load (and memoize) the local corpus.
 *
 * When LOCAL_LAWS_DIR is set it is EXCLUSIVE: an unreadable directory yields
 * an empty corpus (fail-closed) instead of silently falling back — an
 * explicit override must be honored for testing and deployment pinning.
 * Without the override the default locations are tried in order.
 */
export async function loadLocalCorpus(dirOverride?: string): Promise<LocalLawCorpus> {
  if (dirOverride !== undefined) {
    const hit = corpusCache.get(dirOverride);
    if (hit) return hit;
    const loaded = (await loadFromDir(dirOverride)) ?? emptyCorpus(dirOverride);
    corpusCache.set(dirOverride, loaded);
    return loaded;
  }
  if (defaultCorpus) return defaultCorpus;

  if (process.env.LOCAL_LAWS_DIR) {
    defaultCorpus = (await loadFromDir(process.env.LOCAL_LAWS_DIR)) ?? emptyCorpus(process.env.LOCAL_LAWS_DIR);
    return defaultCorpus;
  }

  for (const dir of DEFAULT_DIR_CANDIDATES()) {
    const loaded = await loadFromDir(dir);
    if (loaded) {
      defaultCorpus = loaded;
      return loaded;
    }
  }
  defaultCorpus = emptyCorpus("(missing)");
  return defaultCorpus;
}

function emptyCorpus(dir: string): LocalLawCorpus {
  return {
    acts: [],
    flat: [],
    bodyIndex: new Map(),
    bodyPrefixIndex: new Map(),
    titleIndex: new Map(),
    stats: { acts: 0, articles: 0, bytes: 0, loadedAt: new Date().toISOString(), dir },
  };
}

/** Drop memoized corpora (tests only). */
export function resetLocalCorpusCacheForTests(): void {
  defaultCorpus = null;
  corpusCache.clear();
}
