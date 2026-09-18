"use client";

import { Search, AlertTriangle, FileQuestion, Loader2, Scale, Sparkles, FileText, ShieldAlert } from "lucide-react";

export function SearchingState({ query }: { query: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 sm:p-5">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-neutral-400 dark:text-neutral-500" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            Որոնում եմ ARLIS-ում...
          </p>
          <p className="mt-0.5 text-xs text-neutral-400 truncate dark:text-neutral-500">
            Հարցում՝ {query}
          </p>
        </div>
      </div>
      {/* Skeleton result cards */}
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 sm:p-5"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="flex items-start gap-3">
            <div className="shimmer-legal h-6 w-6 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="flex gap-2">
                <div className="shimmer-legal h-4 w-12 rounded" />
                <div className="shimmer-legal h-4 w-20 rounded" />
              </div>
              <div className="shimmer-legal h-4 w-3/4 rounded" />
              <div className="shimmer-legal h-3 w-full rounded" />
              <div className="shimmer-legal h-3 w-5/6 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/20 sm:p-5">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500 dark:text-red-400" aria-hidden />
      <div className="flex-1">
        <p className="text-sm font-medium text-red-800 dark:text-red-300">
          {message ?? "ARLIS-ի որոնումը ժամանակավորապես անհասանելի է։"}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Կրկին փորձել
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
        <FileQuestion className="h-6 w-6 text-neutral-400 dark:text-neutral-500" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          Հարցմանը համապատասխան վստահելի աղբյուր չի գտնվել։
        </p>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          Փորձեք նշել օրենքի անվանումը կամ հոդվածը (օրինակ՝ «ՔԴՕ 108 հոդված»)։
        </p>
      </div>
      <p className="sr-only">Որոնման հարցում՝ {query}</p>
    </div>
  );
}

export function HomeHero() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-3.5 py-1.5 text-xs font-medium text-neutral-600 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        <Search className="h-3 w-3 text-neutral-500 dark:text-neutral-400" aria-hidden />
        ARLIS · Հայաստանի իրավական տեղեկատվության համակարգ
      </div>
      <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
        Հայկական{" "}
        <span className="bg-gradient-to-r from-neutral-500 to-neutral-700 bg-clip-text text-transparent dark:from-neutral-400 dark:to-neutral-300">
          իրավական
        </span>{" "}
        որոնում
      </h1>
      <p className="mt-3 max-w-xl text-sm text-neutral-600 dark:text-neutral-300 sm:text-base">
        Գտեք օրենսդրություն, դատական նախադեպեր և սահմանադրական դատարանի որոշումներ
        ARLIS-ում՝ ստացեք AI վերլուծություն՝ հղումներով դեպի սկզբնաղբյուր։
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span className="inline-flex items-center gap-1.5">
          <Scale className="h-3.5 w-3.5" aria-hidden />
          Իրական ARLIS աղբյուրներ
        </span>
        <span className="hidden sm:inline text-neutral-300 dark:text-neutral-600">·</span>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          AI վերլուծություն հղումներով
        </span>
        <span className="hidden sm:inline text-neutral-300 dark:text-neutral-600">·</span>
        <span className="inline-flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Հայերեն իրավական տերմիններ
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §98 — Total AI failure banner.
//
// Rendered when the unified AiRuntime could not produce ANY AI stage result
// (all providers RATE_LIMITED / TIMEOUT / UNAVAILABLE / INVALID_SCHEMA / ERROR)
// but the deterministic retrieval + research pipeline still succeeded. The
// banner sits ABOVE the deterministic research so the user immediately sees
// that deep AI analysis is offline while the verified evidence cards remain
// visible and citable.
//
// Project styling rules: NO indigo/blue. Amber alert palette (bg-amber-50 /
// text-amber-900 / border-amber-200, with dark-mode counterparts) is used
// for the warning tone without signaling an unrecoverable error.
// ---------------------------------------------------------------------------

export function TotalAiFailureBanner() {
  return (
    <section
      role="alert"
      aria-live="polite"
      aria-label="Խորքային AI վերլուծությունը ժամանակավորապես հասանելի չէ"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">
            Խորքային AI վերլուծությունը ժամանակավորապես հասանելի չէ։
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200/90">
            Ստուգված աղբյուրները և կառուցվածքային վերլուծությունը պահպանված են։
          </p>
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300/80">
            Կարող եք շարունակել օգտվել աղբյուրներից ու վերլուծության քարտեզից կամ կրկին փորձել ստանալ վերլուծությունը մի քանի վայրկյանից։
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * §97 — smaller note for DETERMINISTIC_ONLY mode: no deep analysis was
 * performed at all (the research pipeline ran only deterministic stages).
 * Less alarming than the banner, because the user simply got the
 * deterministic-only research dossier rather than a partial AI answer.
 */
export function DeterministicOnlyNote() {
  return (
    <section
      aria-live="polite"
      aria-label="Խորը վերլուծությունը չի կատարվել"
      className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300"
    >
      <div className="flex items-start gap-2.5">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden />
        <p className="text-xs leading-relaxed">
          Խորքային AI վերլուծությունը չի իրականացվել։ Ստուգված աղբյուրներն ու որոնման արդյունքները հասանելի են։
        </p>
      </div>
    </section>
  );
}
