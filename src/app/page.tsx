"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SearchBox } from "@/components/legal/SearchBox";
import { SearchResults } from "@/components/legal/SearchResults";
import { AgentAnswer } from "@/components/legal/AgentAnswer";
import { SearchingState, ErrorState, EmptyState, HomeHero } from "@/components/legal/States";
import type { LegalSource, SearchResponse } from "@/lib/legal/types";
import { Scale } from "lucide-react";

type View = "home" | "searching" | "results" | "error" | "empty";

export default function Home() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("home");
  const [results, setResults] = useState<LegalSource[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  const [retrievalMs, setRetrievalMs] = useState<number | undefined>();
  const searchNonce = useRef(0);

  // Hydrate from URL ?q= on first load.
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("q");
    if (q && q.trim()) {
      setQuery(q);
      void runSearch(q);
    }
  }, []);

  // Keep URL in sync with query (shareable / refreshable).
  const updateUrl = useCallback((q: string) => {
    const url = new URL(window.location.href);
    if (q.trim()) {
      url.searchParams.set("q", q.trim());
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  const runSearch = useCallback(
    async (q: string) => {
      const nonce = ++searchNonce.current;
      setQuery(q);
      setView("searching");
      setResults([]);
      setErrorMsg(undefined);
      setRetrievalMs(undefined);
      updateUrl(q);

      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (nonce !== searchNonce.current) return; // superseded
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as SearchResponse;
        if (nonce !== searchNonce.current) return;
        setRetrievalMs(data.retrieval?.durationMs);
        if (!data.retrieval?.ok) {
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
          err instanceof Error ? err.message : "ARLIS-ի որոնումը ժամանակավորապես անհասանելի է։",
        );
        setView("error");
      }
    },
    [updateUrl],
  );

  const onSearchBoxSubmit = useCallback(
    (q: string) => {
      void runSearch(q);
    },
    [runSearch],
  );

  const resetHome = useCallback(() => {
    searchNonce.current++;
    setQuery("");
    setResults([]);
    setView("home");
    setErrorMsg(undefined);
    updateUrl("");
  }, [updateUrl]);

  const isHome = view === "home";

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-neutral-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={resetHome}
            className="flex shrink-0 items-center gap-2 text-neutral-900 hover:opacity-80"
            aria-label="Գլխավոր"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-white">
              <Scale className="h-4 w-4" aria-hidden />
            </span>
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">
              Իրավական որոնում
            </span>
          </button>

          {/* Compact search bar (results view) */}
          {!isHome && (
            <div className="ml-auto w-full max-w-2xl">
              <SearchBox
                initialQuery={query}
                onSubmit={onSearchBoxSubmit}
                size="compact"
                isLoading={view === "searching"}
                autoFocus={false}
              />
            </div>
          )}
        </div>
      </header>

      {/* Main */}
      <main
        className={
          isHome
            ? "mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6"
            : "mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
        }
      >
        {isHome ? (
          <div className="flex w-full flex-col items-center gap-5">
            <HomeHero />
            <div className="w-full max-w-2xl">
              <SearchBox
                initialQuery={query}
                onSubmit={onSearchBoxSubmit}
                size="hero"
                autoFocus
              />
            </div>
            <FooterLinks />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Query + result count line */}
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm text-neutral-500">
                <span className="text-neutral-400">Հարցում՝</span>{" "}
                <span className="font-medium text-neutral-800">{query}</span>
              </p>
              {typeof retrievalMs === "number" && (
                <span className="font-mono text-[11px] text-neutral-300">
                  ~{retrievalMs}ms
                </span>
              )}
            </div>

            {view === "searching" && <SearchingState query={query} />}

            {view === "error" && (
              <ErrorState message={errorMsg} onRetry={() => runSearch(query)} />
            )}

            {view === "empty" && <EmptyState query={query} />}

            {view === "results" && (
              <>
                <SearchResults results={results} query={query} />
                {/* AI answer layer — always BELOW primary sources (spec §49) */}
                <div className="pt-2">
                  <AgentAnswer query={query} sources={results} autoStart />
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* Footer (sticky to bottom per UI rules) */}
      <footer className="mt-auto border-t border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-neutral-400 sm:flex-row sm:px-6">
          <div className="flex items-center gap-1.5">
            <Scale className="h-3 w-3" aria-hidden />
            <span>Տվյալների աղբյուր՝ </span>
            <a
              href="https://arlis.am"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-neutral-600 hover:text-neutral-900 hover:underline"
            >
              ARLIS.am
            </a>
          </div>
          <p className="text-center sm:text-right">
            Սույն կայքը հանդիսանում է որոնողական գործիք և չի փոխարինում իրավական խորհրդատվությանը։
          </p>
        </div>
      </footer>
    </div>
  );
}

function FooterLinks() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-neutral-400">
      <span>Աղբյուր՝ ARLIS.am</span>
      <span aria-hidden>·</span>
      <span>AI վերլուծություն՝ հղումներով</span>
      <span aria-hidden>·</span>
      <span>Չի փոխարինում իրավական խորհրդատվությանը</span>
    </div>
  );
}
