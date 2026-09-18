// src/lib/case-workspace/search/case-search.ts
// Full-text search over case materials — Phase 5 §13 (no RAG, no vector DB).
//
// §3 — NO RAG, NO vector DB, NO mass legal mirror. We use SQLite LIKE-based
// full-text search over:
//   - DocumentPage.originalText / DocumentPage.normalizedText (page text)
//   - CaseDocument.originalFilename + displayName (filenames)
//   - CaseEntity.canonicalName + aliases (entity names)
//   - CaseFact.proposition (fact matrix)
//   - CaseClaim.proposition (claims)
//   - ChronologyEvent.title + description (chronology)
//
// Scoring (deterministic):
//   - Exact phrase match (case-insensitive)  → base score 1.0
//   - All query tokens present               → base score 0.6
//   - Any token present                       → base score 0.2 + (matched/total)*0.3
//   - Source boost (multiplier):
//        filename 1.5, entity 1.4, fact 1.3, claim 1.2, chronology 1.1,
//        page_text 1.0
//
// FTS5: SQLite compiled with SQLITE_ENABLE_FTS5 supports the FTS5 virtual
// table. We detect availability with a one-time `PRAGMA compile_options`
// probe (cached for the process). When available, we issue a single MATCH
// query against an on-demand FTS5 mirror of the case's pages — much faster
// than LIKE for large cases. The mirror is per-request (in-memory temp
// table); we don't persist it because we don't know when the case's
// documents will change. When FTS5 isn't available, we fall back to
// LIKE-based search with the same scoring semantics.
//
// The result hits are source-aware (§17) — every hit carries the documentId
// and pageNumber so the UI can open the source page/section.

import { db } from "@/lib/case-workspace/db";
import type { CaseSearchHit, CaseSearchResult } from "../research/types";
import { parseJsonField } from "../research/types";

// ---------------------------------------------------------------------------
// FTS5 availability probe (cached per process)
// ---------------------------------------------------------------------------

let fts5Cache: boolean | null = null;

async function fts5Available(): Promise<boolean> {
  if (fts5Cache !== null) return fts5Cache;
  try {
    const rows = (await db.$queryRaw`PRAGMA compile_options`) as Array<{
      compile_options?: string;
    }>;
    fts5Cache = rows.some(
      (r) =>
        typeof r.compile_options === "string" &&
        r.compile_options.includes("ENABLE_FTS5"),
    );
  } catch {
    fts5Cache = false;
  }
  return fts5Cache;
}

// ---------------------------------------------------------------------------
// Query tokenization (Armenian / Russian / English aware)
// ---------------------------------------------------------------------------

function tokenize(query: string): string[] {
  // Split on any non-letter/digit rune. Keep tokens ≥ 2 chars to reduce
  // false positives on Armenian short function words.
  const lower = query.toLowerCase().trim();
  if (!lower) return [];
  const parts = lower.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  return parts;
}

function normalize(s: string): string {
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type HitSource = CaseSearchHit["source"];

const SOURCE_BOOST: Record<HitSource, number> = {
  filename: 1.5,
  entity: 1.4,
  fact: 1.3,
  claim: 1.2,
  chronology: 1.1,
  page_text: 1.0,
};

interface ScoredHit extends CaseSearchHit {
  _sortScore: number;
}

function scoreHit(
  source: HitSource,
  documentId: string,
  pageNumber: number,
  snippet: string,
  text: string,
  query: string,
  tokens: string[],
  label?: string,
): ScoredHit {
  const normText = normalize(text);
  const normQuery = normalize(query);
  let base = 0;
  if (normQuery.length >= 3 && normText.includes(normQuery)) {
    base = 1.0; // exact phrase
  } else if (tokens.length > 0 && tokens.every((t) => normText.includes(t))) {
    base = 0.6; // all tokens
  } else if (tokens.length > 0) {
    const matched = tokens.filter((t) => normText.includes(t)).length;
    base = 0.2 + (matched / tokens.length) * 0.3;
  }
  const score = base * (SOURCE_BOOST[source] ?? 1.0);
  return {
    documentId,
    pageNumber,
    snippet: snippet.slice(0, 200),
    score: Math.round(score * 1000) / 1000,
    source,
    label,
    _sortScore: score,
  };
}

function snippetAround(text: string, query: string, tokens: string[]): string {
  if (!text) return "";
  const normText = normalize(text);
  const normQuery = normalize(query);
  // Find a phrase match first.
  let idx = normQuery.length >= 3 ? normText.indexOf(normQuery) : -1;
  // Fall back to first matching token.
  if (idx === -1) {
    for (const t of tokens) {
      const i = normText.indexOf(t);
      if (i !== -1) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) {
    return text.slice(0, 200);
  }
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, idx + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Auxiliary search: small lists (filenames / entities / facts / claims /
// chronology). These don't benefit much from FTS5 — we always use Prisma's
// parameterized `contains` (SQL-injection-safe) and score in memory.
// ---------------------------------------------------------------------------

async function searchAuxLists(
  caseId: string,
  documents: { id: string; displayName: string; originalFilename: string }[],
  query: string,
  tokens: string[],
): Promise<ScoredHit[]> {
  const hits: ScoredHit[] = [];
  const placeholderDocId = documents[0]?.id ?? `case-${caseId}`;

  // Filenames / displayNames — always score (even no-match, so the UI can
  // sort non-matching items last).
  for (const doc of documents) {
    const text = `${doc.originalFilename} ${doc.displayName}`;
    hits.push(
      scoreHit(
        "filename",
        doc.id,
        1,
        snippetAround(text, query, tokens),
        text,
        query,
        tokens,
        doc.displayName,
      ),
    );
  }

  // Entities (canonical + aliases)
  const entities = await db.caseEntity.findMany({
    where: { caseId },
    select: { id: true, canonicalName: true, aliases: true },
  });
  for (const e of entities) {
    const aliases = parseJsonField<string[]>(e.aliases, []);
    const text = `${e.canonicalName} ${aliases.join(" ")}`;
    hits.push(
      scoreHit(
        "entity",
        placeholderDocId,
        1,
        snippetAround(text, query, tokens),
        text,
        query,
        tokens,
        e.canonicalName,
      ),
    );
  }

  // Facts
  const facts = await db.caseFact.findMany({
    where: { caseId },
    select: { id: true, proposition: true },
  });
  for (const f of facts) {
    hits.push(
      scoreHit(
        "fact",
        placeholderDocId,
        1,
        snippetAround(f.proposition, query, tokens),
        f.proposition,
        query,
        tokens,
        "fact",
      ),
    );
  }

  // Claims
  const claims = await db.caseClaim.findMany({
    where: { caseId },
    select: { id: true, proposition: true },
  });
  for (const c of claims) {
    hits.push(
      scoreHit(
        "claim",
        placeholderDocId,
        1,
        snippetAround(c.proposition, query, tokens),
        c.proposition,
        query,
        tokens,
        "claim",
      ),
    );
  }

  // Chronology
  const chronology = await db.chronologyEvent.findMany({
    where: { caseId },
    select: { id: true, title: true, description: true },
  });
  for (const ev of chronology) {
    const text = `${ev.title} ${ev.description ?? ""}`;
    hits.push(
      scoreHit(
        "chronology",
        placeholderDocId,
        1,
        snippetAround(text, query, tokens),
        text,
        query,
        tokens,
        ev.title,
      ),
    );
  }

  return hits;
}

// ---------------------------------------------------------------------------
// LIKE-based page text search (fallback path)
// ---------------------------------------------------------------------------

async function searchPagesLike(
  documents: { id: string }[],
  query: string,
  tokens: string[],
): Promise<ScoredHit[]> {
  const hits: ScoredHit[] = [];
  for (const doc of documents) {
    // Phrase match (case-insensitive ASCII; for Armenian letters the
    // default collation is sufficient). Multi-token matching happens in
    // memory in `scoreHit`.
    const where: Record<string, unknown> = {
      documentId: doc.id,
      OR: [
        { originalText: { contains: query } },
        { normalizedText: { contains: query } },
      ],
    };
    // Add per-token contains clauses so multi-token pages without the
    // exact phrase are also retrieved.
    if (tokens.length > 0) {
      for (const t of tokens) {
        (where.OR as Array<Record<string, unknown>>).push(
          { originalText: { contains: t } },
          { normalizedText: { contains: t } },
        );
      }
    }
    const pageRows = await db.documentPage.findMany({
      where,
      select: {
        pageNumber: true,
        originalText: true,
        normalizedText: true,
      },
    });
    for (const row of pageRows) {
      const text = row.normalizedText ?? row.originalText;
      hits.push(
        scoreHit(
          "page_text",
          doc.id,
          row.pageNumber,
          snippetAround(text, query, tokens),
          text,
          query,
          tokens,
        ),
      );
    }
  }
  return hits;
}

async function searchLike(
  caseId: string,
  query: string,
  tokens: string[],
  opts: {
    documentIds?: string[];
    volumeIds?: string[];
  },
): Promise<ScoredHit[]> {
  const docFilter: Record<string, unknown> = { caseId };
  if (opts.documentIds && opts.documentIds.length > 0) {
    docFilter.id = { in: opts.documentIds };
  }
  if (opts.volumeIds && opts.volumeIds.length > 0) {
    docFilter.volumeId = { in: opts.volumeIds };
  }
  const documents = await db.caseDocument.findMany({
    where: docFilter,
    select: { id: true, displayName: true, originalFilename: true },
  });

  const pageHits = await searchPagesLike(documents, query, tokens);
  const auxHits = await searchAuxLists(caseId, documents, query, tokens);
  return [...pageHits, ...auxHits];
}

// ---------------------------------------------------------------------------
// FTS5 page-text search (preferred path when available)
// ---------------------------------------------------------------------------

async function searchPagesFts5(
  caseId: string,
  documents: { id: string; displayName: string; originalFilename: string }[],
  query: string,
  tokens: string[],
): Promise<ScoredHit[]> {
  try {
    // Create an in-memory FTS5 mirror of the case's pages. The mirror is
    // per-request — we don't persist it across requests because we don't
    // know when the case's documents will change.
    await db.$executeRaw`CREATE VIRTUAL TABLE IF NOT EXISTS temp.case_fts USING fts5(documentId, pageNumber UNINDEXED, text, tokenize = 'unicode61')`;
    await db.$executeRaw`DELETE FROM temp.case_fts`;

    const docIds = documents.map((d) => d.id);
    if (docIds.length === 0) return [];

    const pages = await db.documentPage.findMany({
      where: { documentId: { in: docIds } },
      select: {
        documentId: true,
        pageNumber: true,
        originalText: true,
        normalizedText: true,
      },
    });
    for (const p of pages) {
      const text = p.normalizedText ?? p.originalText;
      if (!text) continue;
      await db.$executeRaw`INSERT INTO temp.case_fts (documentId, pageNumber, text) VALUES (${p.documentId}, ${p.pageNumber}, ${text})`;
    }

    // Phrase query (FTS5 syntax: double-quoted phrase with internal quotes
    // escaped by doubling).
    const phrase = query.replace(/"/g, '""');
    const matchRows = (await db.$queryRaw`
      SELECT documentId, pageNumber, text FROM temp.case_fts
      WHERE temp.case_fts MATCH ${'"' + phrase + '"'}
    `) as Array<{
      documentId: string;
      pageNumber: number;
      text: string;
    }>;

    const hits: ScoredHit[] = [];
    for (const row of matchRows) {
      hits.push(
        scoreHit(
          "page_text",
          row.documentId,
          row.pageNumber,
          snippetAround(row.text, query, tokens),
          row.text,
          query,
          tokens,
        ),
      );
    }
    return hits;
  } catch {
    // FTS5 mirror creation failed — fall back to LIKE for the page-text
    // component.
    return searchPagesLike(documents, query, tokens);
  }
}

async function searchFts5(
  caseId: string,
  query: string,
  tokens: string[],
  opts: {
    documentIds?: string[];
    volumeIds?: string[];
  },
): Promise<ScoredHit[]> {
  const docFilter: Record<string, unknown> = { caseId };
  if (opts.documentIds && opts.documentIds.length > 0) {
    docFilter.id = { in: opts.documentIds };
  }
  if (opts.volumeIds && opts.volumeIds.length > 0) {
    docFilter.volumeId = { in: opts.volumeIds };
  }
  const documents = await db.caseDocument.findMany({
    where: docFilter,
    select: { id: true, displayName: true, originalFilename: true },
  });

  const pageHits = await searchPagesFts5(caseId, documents, query, tokens);
  const auxHits = await searchAuxLists(caseId, documents, query, tokens);
  return [...pageHits, ...auxHits];
}

// ---------------------------------------------------------------------------
// searchCase
// ---------------------------------------------------------------------------

export interface SearchCaseOptions {
  documentIds?: string[];
  volumeIds?: string[];
  page?: number;
  pageSize?: number;
}

/**
 * Full-text search over case materials. NEVER throws — on database failure,
 * returns an empty hit list with `engine: "like"` so the UI can render a
 * "no results" state.
 *
 * Per §17 — every hit is source-aware (carries documentId + pageNumber).
 */
export async function searchCase(
  caseId: string,
  query: string,
  opts: SearchCaseOptions = {},
): Promise<CaseSearchResult> {
  const trimmed = query.trim();
  if (!trimmed || !caseId) {
    return { hits: [], total: 0, engine: "like" };
  }
  const tokens = tokenize(trimmed);

  const useFts5 = await fts5Available();
  let hits: ScoredHit[] = [];
  try {
    hits = useFts5
      ? await searchFts5(caseId, trimmed, tokens, opts)
      : await searchLike(caseId, trimmed, tokens, opts);
  } catch {
    // Best-effort: empty result on failure.
    return { hits: [], total: 0, engine: useFts5 ? "fts5" : "like" };
  }

  // De-duplicate by (documentId, pageNumber, source, snippet) — same hit
  // appearing in both original + normalized text is one logical hit.
  const seen = new Set<string>();
  const deduped: ScoredHit[] = [];
  for (const h of hits) {
    const key = `${h.documentId}|${h.pageNumber}|${h.source}|${h.snippet.slice(0, 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(h);
  }

  // Sort by score descending, then by source boost as a tiebreaker.
  deduped.sort((a, b) => {
    if (b._sortScore !== a._sortScore) return b._sortScore - a._sortScore;
    return (SOURCE_BOOST[b.source] ?? 1) - (SOURCE_BOOST[a.source] ?? 1);
  });

  const total = deduped.length;
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 25));
  const start = (page - 1) * pageSize;
  const pageHits = deduped.slice(start, start + pageSize).map((h) => {
    const { _sortScore, ...rest } = h;
    void _sortScore;
    return rest;
  });

  return {
    hits: pageHits,
    total,
    engine: useFts5 ? "fts5" : "like",
  };
}
