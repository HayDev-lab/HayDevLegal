// src/lib/legal-search/sources/constitutional-court/adapter.ts
// Constitutional Court of Armenia adapter (concourt.am).
//
// Provides: ՀՀ Սահմանադրական դատարան decisions — number, dates, subject,
// matched passages, and the canonical PDF URL. PDFs are public, so full
// document fetch works (text extracted with pdftotext when available).

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceSearchOutcome,
  LegalSourceAdapter,
  FetchedDocument,
  SourceStatus,
} from "../../types";
import { classifyError } from "../source-adapter";
import { AUTHORITY, TIMEOUTS, SOURCE_ORIGINS } from "../../config";
import { concourtSearch, concourtFetchPdf, type CcDecision } from "./client";
import { extractMainText, truncatePassage } from "../../security/content-sanitizer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

let pdftotextAvailable: boolean | null = null;
async function pdfToText(bytes: Uint8Array): Promise<string | null> {
  if (pdftotextAvailable === false) return null;
  const dir = await mkdtemp(join(tmpdir(), "cc-pdf-"));
  try {
    const pdfPath = join(dir, "decision.pdf");
    await writeFile(pdfPath, bytes);
    const { stdout } = await execFileP("pdftotext", ["-enc", "UTF-8", pdfPath, "-"], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 12_000,
    });
    pdftotextAvailable = true;
    return stdout;
  } catch {
    pdftotextAvailable = false;
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function decisionToResult(d: CcDecision): LegalSearchResult {
  const title =
    d.title ??
    (d.number ? `Սահմանադրական դատարանի որոշում ${d.number}` : "Սահմանադրական դատարանի որոշում");
  const passage = d.passages[0] ?? "";
  return {
    sourceId: "constitutional-court",
    sourceName: "Սահմանադրական դատարան",
    sourceType: "constitutional_court",
    authority: AUTHORITY.officialConstitutionalCourt,
    title: truncatePassage(title, 220),
    url: d.pdfUrl ?? "https://concourt.am/decisions/advanced-search",
    court: "ՀՀ Սահմանադրական դատարան",
    caseNumber: d.number,
    date: d.decisionDate ?? d.publicationDate,
    temporalStatus: "unknown",
    excerpt: passage ? truncatePassage(passage, 600) : title,
    passages: d.passages.map((p) => truncatePassage(p, 1200)),
    relevance: 0,
    retrievedAt: new Date().toISOString(),
    externalId: d.pdfUrl?.split("/").pop(),
  };
}

async function search(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<{ outcome: SourceSearchOutcome; results: LegalSearchResult[] }> {
  const start = Date.now();
  const p = query.understanding.parsed;

  // Constitutional Court is relevant for constitutional standards, rights,
  // constitutionality questions, or when explicitly mentioned.
  // Also for cassation-precedent questions: the ConCourt's legal positions
  // on the Cassation Court's mandate/precedent practice are the primary
  // definitional source (live-verified: concourt.am returns decisions with
  // highlighted passages on Վճռաբեկ դատարանի լիազորություններ).
  const q = query.raw.toLowerCase();
  const wantsCc =
    /սահմանադրական|սահմանադրություն|իրավունքներ|հիմնական իրավունք|օրենքի համապատասխան|նախադեպ|վճռաբեկ/.test(q) ||
    p.actTitle?.includes("սահմանադրական") ||
    query.understanding.concepts.some((c) =>
      /նախադեպ|վճռաբեկ/.test(`${c.hy} ${(c.relatedPhrases ?? []).join(" ")}`),
    ) ||
    query.mode === "deep";

  if (!wantsCc) {
    return {
      outcome: { status: "UNSUPPORTED", detail: "հարցը սահմանադրական չէ", durationMs: 0, resultCount: 0 },
      results: [],
    };
  }

  // Search text: exact references win; otherwise keyword-style variants.
  let text: string;
  if (p.caseNumber) {
    text = p.caseNumber;
  } else {
    const hy = query.variants
      .filter((v) => v.lang === "hy")
      .sort((a, b) => a.weight - b.weight)
      .map((v) => v.text);
    text =
      hy.find((t) => t.length >= 4 && t.split(/\s+/).length <= 8 && t.length <= 90) ?? query.raw;
  }

  try {
    // Internal budget respects this adapter's timeoutMultiplier (1.9):
    // the results page is large (~1.5MB) after a CSRF bootstrap.
    const timeoutMs = Math.max(
      2_000,
      Math.min(TIMEOUTS.sourceMs * 1.9, context.deadline - Date.now()),
    );
    const { decisions } = await concourtSearch(text, {
      matchType: 1, // word-root gives the best recall for Armenian morphology
      timeoutMs,
    });

    if (decisions.length === 0) {
      return {
        outcome: { status: "EMPTY", detail: "համապատասխան որոշում չի գտնվել", durationMs: Date.now() - start, resultCount: 0 },
        results: [],
      };
    }

    const results = decisions.map(decisionToResult);
    return {
      outcome: { status: "SUCCESS", durationMs: Date.now() - start, resultCount: results.length },
      results,
    };
  } catch (err) {
    const cls = classifyError(err);
    return { outcome: { ...cls, durationMs: Date.now() - start, resultCount: 0 }, results: [] };
  }
}

async function fetchDocument(
  result: LegalSearchResult,
  context: SearchContext,
): Promise<{ status: SourceStatus; document?: FetchedDocument }> {
  try {
    if (!result.url.endsWith(".pdf")) return { status: "UNSUPPORTED" };
    const timeoutMs = Math.max(2_000, Math.min(TIMEOUTS.documentMs, context.deadline - Date.now()));
    const { bytes } = await concourtFetchPdf(result.url, timeoutMs);
    const text = await pdfToText(bytes);
    if (!text || text.trim().length < 50) {
      // PDF extraction unavailable — fall back to search passages.
      return { status: "RESTRICTED" };
    }
    const main = extractMainText(text);
    return {
      status: "SUCCESS",
      document: {
        url: result.url,
        text: main,
        kind: "pdf",
        fetchedAt: new Date().toISOString(),
        bytes: bytes.length,
      },
    };
  } catch (err) {
    const cls = classifyError(err);
    return { status: cls.status };
  }
}

export const constitutionalCourtAdapter: LegalSourceAdapter = {
  id: "constitutional-court",
  name: "Սահմանադրական դատարան",
  authority: AUTHORITY.officialConstitutionalCourt,
  sourceType: "constitutional_court",
  // concourt.am serves a large server-rendered results page (~1.5MB) after a
  // CSRF bootstrap — it needs a longer budget than the default per-source cap.
  timeoutMultiplier: 1.9,
  supports: (query) => {
    const q = query.raw.toLowerCase();
    return (
      /սահմանադրական|սահմանադրություն|իրավունքներ|հիմնական իրավունք|օրենքի համապատասխան|նախադեպ|վճռաբեկ/.test(q) ||
      query.understanding.parsed.actTitle?.includes("սահմանադրական") ||
      // Cassation-precedent questions: ConCourt legal positions on the
      // Cassation Court's mandate are the primary definitional source.
      query.understanding.concepts.some((c) =>
        /նախադեպ|վճռաբեկ/.test(`${c.hy} ${(c.relatedPhrases ?? []).join(" ")}`),
      ) ||
      query.mode === "deep"
    );
  },
  search,
  fetchDocument,
};
