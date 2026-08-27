"use client";

import { useMemo } from "react";
import { Search, Clock, X, ArrowRight, Scale, Gavel, Landmark, Globe, FileText, BookOpen } from "lucide-react";
import type { LegalTerm, LegalTermCategory } from "@/lib/legal/legal-terms";
import { CATEGORY_META } from "@/lib/legal/legal-terms";
import type { RecentSearch } from "./useRecentSearches";
import { cn } from "@/lib/utils";

type AutocompleteProps = {
  query: string;
  suggestions: LegalTerm[];
  recent: RecentSearch[];
  activeIndex: number; // -1 = none, 0..n-1 = suggestion, then recent
  onSelectSuggestion: (term: string) => void;
  onSelectRecent: (query: string) => void;
  onRemoveRecent: (query: string) => void;
  onClearRecent: () => void;
  isActive: boolean;
};

function categoryIcon(cat: LegalTermCategory) {
  switch (cat) {
    case "օրենսգիրք":
      return <Scale className="h-3.5 w-3.5" aria-hidden />;
    case "դատական":
      return <Gavel className="h-3.5 w-3.5" aria-hidden />;
    case "կազմակերպություն":
      return <Landmark className="h-3.5 w-3.5" aria-hidden />;
    case "օրենք":
      return <BookOpen className="h-3.5 w-3.5" aria-hidden />;
    case "ընթացակարգ":
      return <FileText className="h-3.5 w-3.5" aria-hidden />;
    default:
      return <FileText className="h-3.5 w-3.5" aria-hidden />;
  }
}

/** Highlight the matched portion of a term. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) {
    // Try word-by-word highlight
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return <>{text}</>;
    // Render with each matched word highlighted
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;
    for (const w of words) {
      const i = remaining.toLowerCase().indexOf(w);
      if (i === -1) continue;
      if (i > 0) parts.push(<span key={key++}>{remaining.slice(0, i)}</span>);
      parts.push(
        <mark key={key++} className="bg-neutral-200 dark:bg-neutral-700 text-inherit rounded px-0.5">
          {remaining.slice(i, i + w.length)}
        </mark>,
      );
      remaining = remaining.slice(i + w.length);
    }
    if (remaining) parts.push(<span key={key++}>{remaining}</span>);
    return <>{parts}</>;
  }
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-neutral-200 dark:bg-neutral-700 text-inherit rounded px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function Autocomplete({
  query,
  suggestions,
  recent,
  activeIndex,
  onSelectSuggestion,
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
  isActive,
}: AutocompleteProps) {
  const hasContent = useMemo(
    () => suggestions.length > 0 || (recent.length > 0 && !query.trim()),
    [suggestions.length, recent.length, query],
  );

  if (!isActive || !hasContent) return null;

  // Compute the flat index map: suggestions first, then recent
  let runningIdx = 0;
  const suggestionStart = 0;
  const suggestionEnd = suggestions.length - 1;
  runningIdx = suggestions.length;
  const recentStart = runningIdx;

  return (
    <div
      className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      role="listbox"
      aria-label="Որոնման առաջարկներ"
    >
      {/* Suggestions section */}
      {suggestions.length > 0 && (
        <div className="max-h-[50vh] overflow-y-auto scroll-legal">
          <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            Իրավական տերմիններ
          </div>
          <ul className="pb-2">
            {suggestions.map((s, i) => {
              const isActive = activeIndex === suggestionStart + i;
              return (
                <li key={`${s.term}-${i}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSelectSuggestion(s.term)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                      isActive
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50",
                    )}
                  >
                    <span className={cn("shrink-0", CATEGORY_META[s.category].color)}>
                      {categoryIcon(s.category)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        <Highlight text={s.term} query={query} />
                      </span>
                      {s.expansion && s.term !== s.expansion && (
                        <span className="block truncate text-xs text-neutral-400 dark:text-neutral-500">
                          {s.expansion}
                        </span>
                      )}
                    </span>
                    <span className={cn("shrink-0 text-[10px] font-medium uppercase tracking-wide", CATEGORY_META[s.category].color)}>
                      {CATEGORY_META[s.category].label}
                    </span>
                    {isActive && (
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Recent searches section (only when query is empty) */}
      {!query.trim() && recent.length > 0 && (
        <div className="border-t border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              Վերջին որոնումներ
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClearRecent}
              className="text-[10px] font-medium text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
            >
              Մաքրել
            </button>
          </div>
          <ul className="pb-2">
            {recent.map((r, i) => {
              const isActive = activeIndex === recentStart + i;
              return (
                <li key={`${r.query}-${i}`}>
                  <div
                    className={cn(
                      "group flex items-center gap-3 px-4 py-2.5 transition-colors",
                      isActive
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50",
                    )}
                  >
                    <Clock className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelectRecent(r.query)}
                      className="min-w-0 flex-1 truncate text-left text-sm text-neutral-700 dark:text-neutral-300"
                    >
                      {r.query}
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onRemoveRecent(r.query)}
                      aria-label={`Հեռացնել «${r.query}»-ը`}
                      className="shrink-0 rounded p-1 text-neutral-300 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-600 group-hover:opacity-100 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Footer hint */}
      <div className="border-t border-neutral-100 bg-neutral-50/50 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-800/30">
        <div className="flex items-center justify-between text-[10px] text-neutral-400 dark:text-neutral-500">
          <span className="flex items-center gap-1">
            <Search className="h-2.5 w-2.5" aria-hidden />
            Ընտրեք առաջարկը կամ սեղմեք Enter
          </span>
          <span className="hidden sm:flex items-center gap-1">
            <kbd className="rounded border border-neutral-200 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-800">↑↓</kbd>
            <span>ընտրել</span>
            <kbd className="rounded border border-neutral-200 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-800">Esc</kbd>
            <span>փակել</span>
          </span>
        </div>
      </div>
    </div>
  );
}
