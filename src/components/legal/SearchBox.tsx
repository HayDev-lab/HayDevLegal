"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type SearchBoxProps = {
  initialQuery?: string;
  onSubmit: (query: string) => void;
  autoFocus?: boolean;
  size?: "hero" | "compact";
  isLoading?: boolean;
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
}: SearchBoxProps) {
  const [value, setValue] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q || isLoading) return;
    startTransition(() => onSubmit(q));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setValue("");
      setShowExamples(false);
      inputRef.current?.focus();
    }
  };

  const handleExample = (ex: string) => {
    setValue(ex);
    setShowExamples(false);
    startTransition(() => onSubmit(ex));
  };

  const isHero = size === "hero";

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} role="search" aria-label="Իրավական որոնում" className="w-full">
        <div
          className={cn(
            "group relative flex items-center gap-2 rounded-full border bg-white shadow-sm transition-all",
            "border-neutral-200 hover:border-neutral-300 hover:shadow-md",
            focused && "border-neutral-400 shadow-md ring-2 ring-neutral-100",
            isHero ? "h-14 sm:h-16 px-5" : "h-12 px-4",
          )}
        >
          <Search
            className={cn(
              "shrink-0 text-neutral-400 group-focus-within:text-neutral-600",
              isHero ? "h-5 w-5" : "h-4 w-4",
            )}
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => {
              setFocused(true);
              if (isHero) setShowExamples(true);
            }}
            onBlur={() => {
              setFocused(false);
              // delay so example click can fire
              setTimeout(() => setShowExamples(false), 180);
            }}
            onKeyDown={handleKeyDown}
            enterKeyHint="search"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Որոնման հարցում"
            placeholder="Որոնել ՀՀ օրենսդրությունում..."
            className={cn(
              "min-w-0 flex-1 bg-transparent text-neutral-900 placeholder:text-neutral-400 outline-none",
              isHero ? "text-base sm:text-lg" : "text-sm sm:text-base",
            )}
          />
          {value && !isLoading && (
            <button
              type="button"
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              aria-label="Մաքրել հարցումը"
              className="shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {isLoading && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" aria-hidden />
          )}
          <button
            type="submit"
            disabled={!value.trim() || isLoading}
            aria-label="Որոնել"
            className={cn(
              "shrink-0 rounded-full font-medium text-white transition-all",
              "bg-neutral-900 hover:bg-neutral-700 active:scale-95",
              "disabled:bg-neutral-300 disabled:cursor-not-allowed",
              isHero ? "h-10 px-5 text-sm" : "h-8 px-4 text-sm",
            )}
          >
            Որոնել
          </button>
        </div>
      </form>

      {isHero && showExamples && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-neutral-400">Օրինակներ՝</span>
          {EXAMPLES.slice(0, 4).map((ex) => (
            <button
              key={ex}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleExample(ex)}
              className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
