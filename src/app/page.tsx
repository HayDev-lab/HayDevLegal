"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SearchBox } from "@/components/legal/SearchBox";
import { SearchResults } from "@/components/legal/SearchResults";
import { AgentAnswer } from "@/components/legal/AgentAnswer";
import { SearchingState, ErrorState, EmptyState } from "@/components/legal/States";
// ThemeToggle removed — dark mode only
import { DateSensitivityBanner } from "@/components/legal/DateSensitivityBanner";
import { SearchInsights } from "@/components/legal/SearchInsights";
import { SearchTracePanel } from "@/components/legal/SearchTracePanel";
import { SearchWarnings } from "@/components/legal/SearchWarnings";
import { SearchModeToggle } from "@/components/legal/SearchModeToggle";
import { SourceConfirmDialog } from "@/components/legal/SourceConfirmDialog";
import { ArgumentMapPanel } from "@/components/legal/ArgumentMapPanel";
import { ResearchSummary } from "@/components/legal/ResearchSummary";
import type { LegalSource, LegalQuery } from "@/lib/legal/types";
import type {
  FederatedSearchResponse,
  SearchMode,
  SearchTrace,
  SearchWarning,
} from "@/lib/legal-search/types";
import type { ResearchReport } from "@/lib/legal-research/types";
import { Scale, FolderOpen, Search as SearchIcon } from "lucide-react";
import { CaseWorkspace } from "@/components/case-workspace/CaseWorkspace";

type View = "home" | "searching" | "results" | "error" | "empty";

export default function Home() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("home");
  const [mode, setMode] = useState<SearchMode>("quick");
  const [results, setResults] = useState<LegalSource[]>([]);
  const [parsedQuery, setParsedQuery] = useState<LegalQuery | undefined>();
  const [trace, setTrace] = useState<SearchTrace | undefined>();
  const [warnings, setWarnings] = useState<SearchWarning[]>([]);
  const [research, setResearch] = useState<ResearchReport | undefined>();
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [retrievalMs, setRetrievalMs] = useState<number | undefined>();
  const [confirmTarget, setConfirmTarget] = useState<LegalSource | null>(null);
  const searchNonce = useRef(0);
  // Phase 5 — top-level tab: switch between Legal Search (Phase 3-4.1) and Case Workspace (Phase 5).
  const [topTab, setTopTab] = useState<"search" | "workspace">("search");

  // Hydrate from URL ?q= & mode= on first load.
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("q");
    const m = url.searchParams.get("mode") === "deep" ? "deep" : "quick";
    if (q && q.trim()) {
      setMode(m);
      setQuery(q);
      void runSearch(q, m);
    }
  }, []);

  // Keep URL in sync with query (shareable / refreshable).
  const updateUrl = useCallback((q: string, m: SearchMode) => {
    const url = new URL(window.location.href);
    if (q.trim()) {
      url.searchParams.set("q", q.trim());
      if (m === "deep") url.searchParams.set("mode", "deep");
      else url.searchParams.delete("mode");
    } else {
      url.searchParams.delete("q");
      url.searchParams.delete("mode");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  const runSearch = useCallback(
    async (q: string, m: SearchMode) => {
      const nonce = ++searchNonce.current;
      setQuery(q);
      setMode(m);
      setView("searching");
      setResults([]);
      setTrace(undefined);
      setWarnings([]);
      setResearch(undefined);
      setErrorMsg(undefined);
      setRetrievalMs(undefined);
      updateUrl(q, m);

      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, mode: m }),
        });
        if (nonce !== searchNonce.current) return; // superseded
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as FederatedSearchResponse;
        if (nonce !== searchNonce.current) return;
        setRetrievalMs(data.retrieval?.durationMs);
        setParsedQuery(data.parsed);
        setTrace(data.trace);
        setWarnings(data.warnings ?? []);
        setResearch(data.research);
        if (!data.retrieval?.ok && data.evidence?.length === 0) {
          setErrorMsg(data.retrieval?.error);
          setView("error");
          return;
        }
        setResults(data.results);
        setView(data.results.length > 0 ? "results" : "empty");
      } catch (err) {
        if (nonce !== searchNonce.current) return;
        console.error("[search] failed:", err);
        setErrorMsg(
          err instanceof Error ? err.message : "Որոնումը ժամանակավորապես անհասանելի է։",
        );
        setView("error");
      }
    },
    [updateUrl],
  );

  const onSearchBoxSubmit = useCallback(
    (q: string) => {
      void runSearch(q, mode);
    },
    [runSearch, mode],
  );

  const onModeChange = useCallback(
    (m: SearchMode) => {
      setMode(m);
      // Re-run the current search when the mode changes on a results page.
      if (query.trim()) void runSearch(query, m);
    },
    [query, runSearch],
  );

  const resetHome = useCallback(() => {
    searchNonce.current++;
    setQuery("");
    setResults([]);
    setView("home");
    setErrorMsg(undefined);
    setConfirmTarget(null);
    updateUrl("", mode);
  }, [updateUrl, mode]);

  // Phase 3 §64 — when the user confirms the source (solves the CAPTCHA in
  // our dialog), upgrade that evidence card in place: metadata -> verified
  // full text with real passages.
  const onEvidenceResolved = useCallback(
    (passages: string[], _url: string, textPreview: string) => {
      setConfirmTarget((prev) => {
        if (!prev) return null;
        const ref = prev.documentRef;
        setResults((rs) =>
          rs.map((r) =>
            r.documentRef && r.documentRef === ref
              ? {
                  ...r,
                  accessState: undefined,
                  fullTextVerified: true,
                  evidenceGrade: "PRIMARY_VERIFIED" as const,
                  excerpt: (passages[0] ?? textPreview).slice(0, 400),
                  fullRetrievedText: (passages[0] ?? textPreview).slice(0, 1200),
                }
              : r,
          ),
        );
        return null; // close the dialog
      });
    },
    [],
  );

  const isHome = view === "home";
  const modeToggle = (
    <SearchModeToggle mode={mode} onChange={onModeChange} disabled={view === "searching"} />
  );

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{
        backgroundImage: "url(/background.png)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundAttachment: "fixed",
      }}
    >
      {/* Floating tab bar — positioned at top-right, doesn't cover logo */}
      <nav className="sticky top-0 z-30 flex items-center justify-end gap-2 px-4 pt-3 pb-2">
        <button
          type="button"
          onClick={() => setTopTab("search")}
          className={`inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold backdrop-blur-md transition-all ${
            topTab === "search"
              ? "bg-gradient-to-br from-amber-300 via-amber-500 to-amber-700 text-neutral-900 shadow-lg shadow-amber-500/30 border border-amber-400"
              : "bg-black/40 text-amber-300 border border-amber-600/30 hover:bg-black/60"
          }`}
        >
          <SearchIcon className="h-4 w-4" />
          Որոնում
        </button>
        <button
          type="button"
          onClick={() => setTopTab("workspace")}
          className={`inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold backdrop-blur-md transition-all ${
            topTab === "workspace"
              ? "bg-gradient-to-br from-amber-300 via-amber-500 to-amber-700 text-neutral-900 shadow-lg shadow-amber-500/30 border border-amber-400"
              : "bg-black/40 text-amber-300 border border-amber-600/30 hover:bg-black/60"
          }`}
        >
          <FolderOpen className="h-4 w-4" />
          Գործեր
        </button>
      </nav>

      {/* Compact search bar (results view) */}
      {!isHome && topTab === "search" && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-2">
          <SearchBox
            initialQuery={query}
            onSubmit={onSearchBoxSubmit}
            size="compact"
            isLoading={view === "searching"}
            autoFocus={false}
          />
        </div>
      )}

      {/* Main */}
      <main
        className={
          topTab === "workspace"
            ? "mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6"
            : isHome
              ? "mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-8"
              : "mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6"
        }
      >
        {topTab === "workspace" ? (
          <div className="rounded-2xl bg-black/30 backdrop-blur-md border border-amber-600/20 p-4">
            <CaseWorkspace />
          </div>
        ) : isHome ? (
          <div className="flex w-full flex-col items-center gap-5">
            <div className="w-full max-w-2xl">
              <SearchBox
                initialQuery={query}
                onSubmit={onSearchBoxSubmit}
                size="hero"
                autoFocus
              />
            </div>
            {modeToggle}
            <FooterLinks />
          </div>
        ) : (
          <div className="space-y-5 rounded-2xl bg-black/20 backdrop-blur-sm border border-amber-600/10 p-4">
            {/* Query line + mode toggle */}
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-amber-400">
                <span className="text-amber-600">Հարցում՝</span>{" "}
                <span className="font-medium text-amber-300">{query}</span>
              </p>
              {modeToggle}
            </div>

            {/* Search insights (parsed query structure + stats) */}
            {view === "results" && (
              <SearchInsights
                parsed={parsedQuery}
                resultCount={results.length}
                retrievalMs={retrievalMs}
              />
            )}

            {/* Phase 4 §102 — research completeness summary (deep mode). */}
            {view === "results" && research && (
              <ResearchSummary research={research} evidenceCount={results.length} />
            )}

            {/* Search trace — retrieval activity (§25) */}
            {view === "results" && trace && <SearchTracePanel trace={trace} />}

            {view === "searching" && <SearchingState query={query} />}

            {view === "error" && (
              <ErrorState message={errorMsg} onRetry={() => runSearch(query, mode)} />
            )}

            {view === "empty" && <EmptyState query={query} />}

            {view === "results" && (
              <>
                {/* Search warnings (temporal / restricted / partial) */}
                <SearchWarnings warnings={warnings} />

                {/* Date-sensitivity banner (spec §16) — above results */}
                <DateSensitivityBanner parsed={parsedQuery} />
                {/* Phase 4 §61 — argument map panel (deep mode, below sources). */}
                {research && <ArgumentMapPanel research={research} />}
                <SearchResults
                  results={results}
                  query={query}
                  onRequireConfirm={(s) => setConfirmTarget(s)}
                  research={research}
                />
                {/* AI answer layer — always BELOW primary sources (spec §49).
                    key={query+mode} forces a clean remount on every new search so
                    the previous stream is fully torn down (no stale evidence). */}
                <div className="pt-2">
                  <AgentAnswer
                    key={`${query}|${mode}`}
                    query={query}
                    sources={results}
                    autoStart
                    warnings={warnings.map((w) => w.message)}
                    research={research}
                    dateContext={parsedQuery ? {
                      date: parsedQuery.date,
                      wantsHistorical: parsedQuery.wantsHistoricalLaw,
                      wantsCurrent: parsedQuery.wantsCurrentLaw,
                    } : undefined}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* Footer — black bg, golden text */}
      <footer className="mt-auto bg-black">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs sm:flex-row sm:px-6 sm:py-5">
          <div className="flex items-center gap-1.5">
            <Scale className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            <span className="text-amber-400">Աղբյուրներ՝ </span>
            <a
              href="https://arlis.am"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-400 hover:text-amber-300 hover:underline"
            >
              ARLIS.am
            </a>
            <span aria-hidden className="text-amber-500">·</span>
            <a
              href="https://datalex.am"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-400 hover:text-amber-300 hover:underline"
            >
              Datalex.am
            </a>
            <span aria-hidden className="text-amber-500">·</span>
            <a
              href="https://concourt.am"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-400 hover:text-amber-300 hover:underline"
            >
              Concourt.am
            </a>
          </div>
          <p className="text-center text-amber-500 sm:text-right">
            Սույն կայքը հանդիսանում է որոնողական գործիք և չի փոխարինում իրավական խորհրդատվությանը։
          </p>
        </div>
      </footer>

      {/* Phase 3 §25/§63-§64 — interactive source confirmation (CAPTCHA) */}
      {confirmTarget && (
        <SourceConfirmDialog
          source={confirmTarget}
          query={query}
          onClose={() => setConfirmTarget(null)}
          onResolved={onEvidenceResolved}
        />
      )}
    </div>
  );
}

function FooterLinks() {
  return null;
}
