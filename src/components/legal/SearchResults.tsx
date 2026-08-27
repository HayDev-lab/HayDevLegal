"use client";

import { ExternalLink, FileText, Scale, Gavel, Landmark, Globe, ChevronRight } from "lucide-react";
import type { LegalSource, SourceLabel } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

type SearchResultsProps = {
  results: LegalSource[];
  query: string;
};

const STATUS_IN_FORCE = ["գործունակ", "գործում է"];
const STATUS_NOT_IN_FORCE = ["չի գործունակ", "չի գործում", "ուժը կորցրել է"];

function statusTone(status?: string): {
  label: string;
  className: string;
  dot: string;
} {
  if (!status) return { label: "—", className: "", dot: "bg-neutral-300" };
  const s = status.toLowerCase();
  if (STATUS_IN_FORCE.some((k) => s.includes(k))) {
    return {
      label: status,
      className: "text-emerald-700 bg-emerald-50 border-emerald-200",
      dot: "bg-emerald-500",
    };
  }
  if (STATUS_NOT_IN_FORCE.some((k) => s.includes(k))) {
    return {
      label: status,
      className: "text-amber-700 bg-amber-50 border-amber-200",
      dot: "bg-amber-500",
    };
  }
  return {
    label: status,
    className: "text-neutral-700 bg-neutral-50 border-neutral-200",
    dot: "bg-neutral-400",
  };
}

function labelIcon(label?: SourceLabel) {
  switch (label) {
    case "Վճռաբեկ դատարան":
      return <Gavel className="h-3.5 w-3.5" aria-hidden />;
    case "Սահմանադրական դատարան":
      return <Landmark className="h-3.5 w-3.5" aria-hidden />;
    case "ՄԻԵՎԴ":
      return <Globe className="h-3.5 w-3.5" aria-hidden />;
    case "Օրենսդրություն":
      return <Scale className="h-3.5 w-3.5" aria-hidden />;
    default:
      return <FileText className="h-3.5 w-3.5" aria-hidden />;
  }
}

function ResultCard({ source, index }: { source: LegalSource; index: number }) {
  const status = statusTone(source.status);
  const url = source.canonicalUrl || "";
  const host = (() => {
    try {
      return url ? new URL(url).host.replace(/^www\./, "") : "arlis.am";
    } catch {
      return "arlis.am";
    }
  })();
  const urlPath = (() => {
    try {
      return url ? new URL(url).pathname : "";
    } catch {
      return "";
    }
  })();

  return (
    <article
      className="enter-legal group relative rounded-xl border border-neutral-200 bg-white p-4 sm:p-5 transition-all hover:border-neutral-300 hover:shadow-sm"
      style={{ animationDelay: `${Math.min(index, 4) * 60}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white">
            {index + 1}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* Source badge row */}
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-0.5 font-semibold tracking-wide text-white">
              ARLIS
            </span>
            {source.sourceLabel && (
              <span className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-neutral-600">
                {labelIcon(source.sourceLabel)}
                {source.sourceLabel}
              </span>
            )}
            {source.article && (
              <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-neutral-600">
                Հոդված {source.article}
                {source.part ? ` · մաս ${source.part}` : ""}
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium",
                status.className,
              )}
              title="Կարգավիճակ"
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {status.label}
            </span>
          </div>

          {/* Title — clickable, opens real ARLIS page */}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[15px] sm:text-base font-medium leading-snug text-neutral-900 hover:text-neutral-700 hover:underline decoration-neutral-300 underline-offset-2"
            >
              <span className="sr-only">Աղբյուր {source.id}՝ </span>
              {source.title}
            </a>
          ) : (
            <h3 className="text-[15px] sm:text-base font-medium leading-snug text-neutral-900">
              {source.title}
            </h3>
          )}

          {/* Excerpt */}
          {source.excerpt && (
            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-neutral-600">
              {source.excerpt.split("\n").slice(0, 3).join(" · ")}
            </p>
          )}

          {/* Full retrieved article text (collapsible) */}
          {source.fullRetrievedText && (
            <details className="mt-2 group/details">
              <summary className="cursor-pointer list-none text-xs font-medium text-neutral-500 hover:text-neutral-700 inline-flex items-center gap-1">
                <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" aria-hidden />
                Ընթացիկ տեքստ
              </summary>
              <div className="scroll-legal mt-2 max-h-64 overflow-y-auto rounded-md border border-neutral-100 bg-neutral-50/60 p-3 text-xs leading-relaxed text-neutral-700 whitespace-pre-wrap">
                {source.fullRetrievedText}
              </div>
            </details>
          )}

          {/* URL line */}
          {url && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-neutral-400">
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                <span className="text-neutral-500">{host}</span>
                <span className="text-neutral-400">{urlPath}</span>
              </span>
            </div>
          )}

          {/* Metadata row */}
          {(source.actNumber || source.adoptionDate || source.effectiveDate) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
              {source.actNumber && (
                <span>Ակտի համար՝ <span className="text-neutral-600">{source.actNumber}</span></span>
              )}
              {source.adoptionDate && (
                <span>Ընդունված՝ <span className="text-neutral-600">{source.adoptionDate}</span></span>
              )}
              {source.effectiveDate && (
                <span>Ուժի մեջ՝ <span className="text-neutral-600">{source.effectiveDate}</span></span>
              )}
              {source.relevanceScore > 0 && (
                <span>Համապատասխանություն՝ <span className="text-neutral-600">{Math.round(source.relevanceScore * 100)}%</span></span>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function SearchResults({ results, query }: SearchResultsProps) {
  if (results.length === 0) return null;
  return (
    <section aria-label="ARLIS աղբյուրներ" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <h2 className="text-sm font-medium text-neutral-500">
          Գտնվել են համապատասխան իրավական աղբյուրներ
        </h2>
        <span className="text-xs text-neutral-400">{results.length} արդյունք</span>
      </div>
      <div className="space-y-3">
        {results.map((r, i) => (
          <ResultCard key={`${r.actId ?? r.canonicalUrl ?? i}-${i}`} source={r} index={i} />
        ))}
      </div>
      <p className="sr-only">
        Որոնման հարցում՝ {query}. Վերևում ներկայացված են {results.length} հիմնական իրավական աղբյուրները ARLIS-ից։
      </p>
    </section>
  );
}
