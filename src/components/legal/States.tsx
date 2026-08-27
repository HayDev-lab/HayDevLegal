"use client";

import { Search, AlertTriangle, FileQuestion, Loader2 } from "lucide-react";

export function SearchingState({ query }: { query: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-neutral-400" aria-hidden />
      <div>
        <p className="text-sm font-medium text-neutral-700">
          Որոնում եմ ARLIS-ում...
        </p>
        <p className="mt-0.5 text-xs text-neutral-400 truncate">
          Հարցում՝ {query}
        </p>
      </div>
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
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 sm:p-5">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden />
      <div className="flex-1">
        <p className="text-sm font-medium text-red-800">
          {message ?? "ARLIS-ի որոնումը ժամանակավորապես անհասանելի է։"}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
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
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100">
        <FileQuestion className="h-6 w-6 text-neutral-400" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-700">
          Հարցմանը համապատասխան վստահելի աղբյուր չի գտնվել։
        </p>
        <p className="mt-1 text-xs text-neutral-400">
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
      <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
        <Search className="h-3 w-3" aria-hidden />
        ARLIS · Հայաստանի իրավական տեղեկատվության համակարգ
      </div>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-neutral-900">
        Հայկական <span className="text-neutral-400">իրավական</span> որոնում
      </h1>
      <p className="mt-2 max-w-xl text-sm text-neutral-500">
        Գտեք օրենսդրություն, դատական նախադեպեր և սահմանադրական դատարանի որոշումներ
        ARLIS-ում՝ ստացեք AI վերլուծություն՝ հղումներով դեպի սկզբնաղբյուր։
      </p>
    </div>
  );
}
