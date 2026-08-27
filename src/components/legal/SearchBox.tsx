"use client";

import { useState, useRef, useEffect, useTransition, useMemo, useCallback } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { suggestTerms } from "@/lib/legal/legal-terms";
import { Autocomplete } from "./Autocomplete";
import { useRecentSearches } from "./useRecentSearches";

type SearchBoxProps = {
  initialQuery?: string;
  onSubmit: (query: string) => void;
  autoFocus?: boolean;
  size?: "hero" | "compact";
  isLoading?: boolean;
  /** When true, show the autocomplete dropdown. Default true. */
  enableAutocomplete?: boolean;
};

const EXAMPLES = [
  "ՔԴՕ 108 հոդված",
  "քրեական դատավարության օրենսգիրք",
  "խափանման միջոց կալանք",
  "Վճռաբեկ դատարան՝ ձերբակալում",
  "գույքի արգելադրման կարգը",
  "պաշտպանի մասնակցության պարտադիր դեպքերը",
];

export function SearchBox({
  initialQuery = "",
  onSubmit,
  autoFocus = false,
  size = "hero",
  isLoading = false,
  enableAutocomplete = true,
}: SearchBoxProps) {
  const [value, setValue] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const [showExamples, setShowExamples] = useState(true);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();
  const { recent, addRecent, removeRecent, clearRecent } = useRecentSearches();

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  // Compute suggestions (debounced via useMemo + the value dependency)
  const suggestions = useMemo(() => {
    if (!enableAutocomplete || !focused) return [];
    return suggestTerms(value, 8);
  }, [value, focused, enableAutocomplete]);

  // Total items for keyboard nav: suggestions + (recent only when query empty)
  const totalCount = suggestions.length + (value.trim() ? 0 : recent.length);

  // Global keyboard shortcut: "/" focuses the search input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!focused) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [focused]);

  const handleSubmit = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed || isLoading) return;
      if (enableAutocomplete) addRecent(trimmed);
      setFocused(false);
      setActiveIdx(-1);
      startTransition(() => onSubmit(trimmed));
    },
    [isLoading, enableAutocomplete, addRecent, onSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape: clear or close
    if (e.key === "Escape") {
      if (value) {
        setValue("");
        setActiveIdx(-1);
      } else {
        setFocused(false);
      }
      inputRef.current?.focus();
      return;
    }
    // Arrow Down / Up for autocomplete navigation
    if (enableAutocomplete && focused && totalCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((prev) => (prev + 1) % totalCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((prev) => (prev <= 0 ? totalCount - 1 : prev - 1));
        return;
      }
      if (e.key === "Tab" && activeIdx >= 0) {
        // Fill the selected suggestion into the input
        e.preventDefault();
        if (activeIdx < suggestions.length) {
          setValue(suggestions[activeIdx].term);
        } else {
          const ri = activeIdx - suggestions.length;
          if (recent[ri]) setValue(recent[ri].query);
        }
        return;
      }
    }
    // Enter: submit selected suggestion/recent, or the typed value
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < suggestions.length) {
        handleSubmit(suggestions[activeIdx].term);
      } else if (activeIdx >= suggestions.length) {
        const ri = activeIdx - suggestions.length;
        if (recent[ri]) handleSubmit(recent[ri].query);
      } else {
        handleSubmit(value);
      }
      return;
    }
  };

  const handleExample = (ex: string) => {
    setValue(ex);
    setShowExamples(false);
    setFocused(false);
    handleSubmit(ex);
  };

  const handleSelectSuggestion = (term: string) => {
    setValue(term);
    setFocused(false);
    setActiveIdx(-1);
    handleSubmit(term);
  };

  const handleSelectRecent = (q: string) => {
    setValue(q);
    setFocused(false);
    setActiveIdx(-1);
    handleSubmit(q);
  };

  const isHero = size === "hero";
  const showDropdown = enableAutocomplete && focused && (suggestions.length > 0 || (!value.trim() && recent.length > 0));

  return (
    <div ref={containerRef} className="relative w-full">
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(value); }} role="search" aria-label="Իրավական որոնում" className="w-full">
        <div
          className={cn(
            "group relative flex items-center gap-2 rounded-full border bg-white shadow-sm transition-all",
            "border-neutral-300 hover:border-neutral-400 hover:shadow-md",
            "dark:border-neutral-600 dark:bg-neutral-900 dark:hover:border-neutral-500",
            focused && "border-neutral-500 shadow-md ring-4 ring-neutral-100 dark:border-neutral-400 dark:ring-neutral-800/50",
            isHero ? "h-14 sm:h-16 px-5" : "h-12 px-4",
          )}
        >
          <Search
            className={cn(
              "shrink-0 text-neutral-500 group-focus-within:text-neutral-700 dark:text-neutral-400 dark:group-focus-within:text-neutral-200",
              isHero ? "h-5 w-5" : "h-4 w-4",
            )}
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setActiveIdx(-1);
            }}
            onFocus={() => {
              setFocused(true);
              if (isHero) setShowExamples(true);
            }}
            onKeyDown={handleKeyDown}
            enterKeyHint="search"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Որոնման հարցում"
            aria-controls="autocomplete-listbox"
            aria-autocomplete="list"
            placeholder="Որոնել ՀՀ օրենսդրությունում..."
            className={cn(
              "min-w-0 flex-1 bg-transparent text-neutral-900 placeholder:text-neutral-500 outline-none dark:text-neutral-50 dark:placeholder:text-neutral-400",
              isHero ? "text-base sm:text-lg" : "text-sm sm:text-base",
            )}
          />
          {value && !isLoading && (
            <button
              type="button"
              onClick={() => {
                setValue("");
                setActiveIdx(-1);
                inputRef.current?.focus();
              }}
              aria-label="Մաքրել հարցումը"
              className="shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 transition-colors dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {isLoading && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400 dark:text-neutral-500" aria-hidden />
          )}
          <button
            type="submit"
            disabled={!value.trim() || isLoading}
            aria-label="Որոնել"
            className={cn(
              "shrink-0 rounded-full font-medium text-white transition-all",
              "bg-neutral-900 hover:bg-neutral-700 active:scale-95",
              "dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200",
              "disabled:bg-neutral-300 disabled:cursor-not-allowed dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500",
              isHero ? "h-10 px-6 text-sm shadow-sm" : "h-8 px-4 text-sm",
            )}
          >
            Որոնել
          </button>
        </div>
      </form>

      {/* Autocomplete dropdown */}
      {showDropdown && (
        <Autocomplete
          query={value}
          suggestions={suggestions}
          recent={recent}
          activeIndex={activeIdx}
          onSelectSuggestion={handleSelectSuggestion}
          onSelectRecent={handleSelectRecent}
          onRemoveRecent={removeRecent}
          onClearRecent={clearRecent}
          isActive={showDropdown}
        />
      )}

      {/* Keyboard shortcut hint (desktop, compact, no focus, no value) */}
      {!isHero && !focused && !value && (
        <div className="pointer-events-none absolute right-20 top-1/2 hidden -translate-y-1/2 lg:block">
          <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
            /
          </kbd>
        </div>
      )}

      {isHero && !value && !showDropdown && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Օրինակներ՝</span>
          {EXAMPLES.slice(0, 4).map((ex) => (
            <button
              key={ex}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleExample(ex)}
              className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 transition-all hover:border-neutral-900 hover:bg-neutral-900 hover:text-white dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-white dark:hover:bg-white dark:hover:text-neutral-900"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
