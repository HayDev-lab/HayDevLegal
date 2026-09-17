"use client";

import { useState, useMemo } from "react";
import { ExternalLink, FileText, Scale, Gavel, Landmark, Globe, ChevronRight, Filter, BookOpen, ShieldAlert, ShieldCheck, Search } from "lucide-react";
import type { LegalSource, SourceLabel } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

type SearchResultsProps = {
  results: LegalSource[];
  query: string;
  /** Phase 3 §63-§64 — open the interactive source-confirmation dialog. */
  onRequireConfirm?: (source: LegalSource) => void;
};

const STATUS_IN_FORCE = ["գործունակ", "գործում է", "գործող", "գործում"];
const STATUS_NOT_IN_FORCE = ["չի գործունակ", "չի գործում", "ուժը կորցրել է", "պատմական"];

const ALL_LABELS: SourceLabel[] = [
  "Օրենսդրություն",
  "Վճռաբեկ դատարան",
  "Սահմանադրական դատարան",
  "ՄԻԵՎԴ",
  "Իրավական ակտ",
];

function statusTone(status?: string): {
  label: string;
  className: string;
  dot: string;
} {
  if (!status) return { label: "—", className: "", dot: "bg-neutral-300 dark:bg-neutral-600" };
  const s = status.toLowerCase();
  if (STATUS_IN_FORCE.some((k) => s.includes(k))) {
    return {
      label: status,
      className: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-400 dark:bg-emerald-950/30 dark:border-emerald-900/50",
      dot: "bg-emerald-500",
    };
  }
  if (STATUS_NOT_IN_FORCE.some((k) => s.includes(k))) {
    return {
      label: status,
      className: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-900/50",
      dot: "bg-amber-500",
    };
  }
  return {
    label: status,
    className: "text-neutral-700 bg-neutral-50 border-neutral-200 dark:text-neutral-300 dark:bg-neutral-800 dark:border-neutral-700",
    dot: "bg-neutral-400 dark:bg-neutral-500",
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

/** Phase 3 §51 — user-facing access status labels. */
function accessTone(source: LegalSource): { label: string; className: string } | null {
  if (source.fullTextVerified) {
    return {
      label: "Պաշտոնական ամբողջական տեքստ",
      className: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-400 dark:bg-emerald-950/30 dark:border-emerald-900/50",
    };
  }
  if (source.accessState === "CAPTCHA_REQUIRED") {
    return {
      label: "Պահանջվում է աղբյուրի հաստատում",
      className: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-400 dark:bg-amber-950/30 dark:border-amber-900/50",
    };
  }
  if (source.resolvedVia === "OTHER_OFFICIAL_SOURCE" || source.resolvedVia === "WEB_DISCOVERY") {
    return {
      label: "Գտնվել է այլ պաշտոնական աղբյուրում",
      className: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-400 dark:bg-blue-950/30 dark:border-blue-900/50",
    };
  }
  if (source.metadataVerified) {
    return {
      label: "Միայն մետատվյալներ",
      className: "text-neutral-600 bg-neutral-50 border-neutral-200 dark:text-neutral-400 dark:bg-neutral-800 dark:border-neutral-700",
    };
  }
  return null;
}

function ResultCard({
  source,
  index,
  onRequireConfirm,
}: {
  source: LegalSource;
  index: number;
  onRequireConfirm?: (source: LegalSource) => void;
}) {
  const status = statusTone(source.status);
  const url = source.canonicalUrl || "";
  const host = (() => {
    try {
      return url ? new URL(url).host.replace(/^www\./, "") : "arlis.am";
    } catch {
      return "arlis.am";
    }
  })();
  // Source badge derives from the canonical URL host (§26): the user must
  // always see WHICH source the document came from.
  const sourceBadge = /arlis\.am/.test(host)
    ? "ARLIS"
    : /datalex\.am/.test(host)
      ? "DATALEX"
      : /concourt\.am/.test(host)
        ? "ՍԴ"
        : /hudoc|echr/.test(host)
          ? "ՄԻԵՎԴ"
          : host || "ԱՂԲՅՈՒՐ";
  const urlPath = (() => {
    try {
      return url ? new URL(url).pathname : "";
    } catch {
      return "";
    }
  })();

  return (
    <article
      className="enter-legal group relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 transition-all hover:border-neutral-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700 sm:p-5"
      style={{ animationDelay: `${Math.min(index, 4) * 60}ms` }}
    >
      {/* Left accent bar */}
      <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-neutral-300 to-transparent transition-all group-hover:from-neutral-900 group-hover:to-neutral-400 dark:from-neutral-700 dark:group-hover:from-white dark:group-hover:to-neutral-400" />

      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white dark:bg-white dark:text-neutral-900">
            {index + 1}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* Source badge row */}
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-2 py-0.5 font-semibold tracking-wide text-white dark:bg-white dark:text-neutral-900">
              {sourceBadge}
            </span>
            {source.sourceLabel && (
              <span className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                {labelIcon(source.sourceLabel)}
                {source.sourceLabel}
              </span>
            )}
            {source.article && (
              <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
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
            {/* Phase 3 §51 — access status (full text / metadata / confirmation). */}
            {(() => {
              const tone = accessTone(source);
              if (!tone) return null;
              const Icon = source.fullTextVerified
                ? ShieldCheck
                : source.accessState === "CAPTCHA_REQUIRED"
                  ? ShieldAlert
                  : source.resolvedVia === "OTHER_OFFICIAL_SOURCE" || source.resolvedVia === "WEB_DISCOVERY"
                    ? Search
                    : FileText;
              return (
                <span
                  className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium", tone.className)}
                  title="Տեքստի հասանելիություն"
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {tone.label}
                </span>
              );
            })()}
          </div>

          {/* Title — clickable, opens real ARLIS page */}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[15px] font-medium leading-snug text-neutral-900 hover:text-neutral-700 hover:underline decoration-neutral-300 underline-offset-2 dark:text-neutral-100 dark:hover:text-white dark:decoration-neutral-600"
            >
              <span className="sr-only">Աղբյուր {source.id}՝ </span>
              {source.title}
            </a>
          ) : (
            <h3 className="text-[15px] font-medium leading-snug text-neutral-900 dark:text-neutral-100">
              {source.title}
            </h3>
          )}

          {/* Excerpt */}
          {source.excerpt && (
            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {source.excerpt.split("\n").slice(0, 3).join(" · ")}
            </p>
          )}

          {/* Full retrieved article text (collapsible) */}
          {source.fullRetrievedText && (
            <details className="group/details mt-2">
              <summary className="cursor-pointer list-none text-xs font-medium text-neutral-500 hover:text-neutral-700 inline-flex items-center gap-1 dark:text-neutral-400 dark:hover:text-neutral-200">
                <ChevronRight className="h-3 w-3 transition-transform group-open/details:rotate-90" aria-hidden />
                Ընթացիկ տեքստ
              </summary>
              <div className="scroll-legal mt-2 max-h-64 overflow-y-auto rounded-md border border-neutral-100 bg-neutral-50/60 p-3 text-xs leading-relaxed text-neutral-700 whitespace-pre-wrap dark:border-neutral-800 dark:bg-neutral-800/40 dark:text-neutral-300">
                {source.fullRetrievedText}
              </div>
            </details>
          )}

          {/* URL line */}
          {url && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                <span className="text-neutral-500 dark:text-neutral-400">{host}</span>
                <span className="text-neutral-400 dark:text-neutral-600">{urlPath}</span>
              </span>
            </div>
          )}

          {/* Metadata row */}
          {(source.actNumber || source.adoptionDate || source.effectiveDate) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              {source.actNumber && (
                <span>Ակտի համար՝ <span className="text-neutral-600 dark:text-neutral-300">{source.actNumber}</span></span>
              )}
              {source.adoptionDate && (
                <span>Ընդունված՝ <span className="text-neutral-600 dark:text-neutral-300">{source.adoptionDate}</span></span>
              )}
              {source.effectiveDate && (
                <span>Ուժի մեջ՝ <span className="text-neutral-600 dark:text-neutral-300">{source.effectiveDate}</span></span>
              )}
              {source.relevanceScore > 0 && (
                <span>Համապատասխանություն՝ <span className="text-neutral-600 dark:text-neutral-300">{Math.round(source.relevanceScore * 100)}%</span></span>
              )}
            </div>
          )}

          {/* Action row: deep-link to full act + article anchor (spec §4, suggestion g) */}
          {url && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                <BookOpen className="h-3 w-3" aria-hidden />
                Բացել սկզբնաղբյուրը
                <ExternalLink className="h-2.5 w-2.5 opacity-50" aria-hidden />
              </a>
              {source.article && url && (
                <a
                  href={`${url}#article-${source.article}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  title={`Հոդված ${source.article} — բացել ARLIS-ում`}
                >
                  <ChevronRight className="h-3 w-3" aria-hidden />
                  Հոդված {source.article}
                </a>
              )}
              {source.caseNumber && (
                <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                  {source.caseNumber}
                </span>
              )}
              {/* Phase 3 §63-§64 — interactive unlock of the gated full text. */}
              {source.accessState === "CAPTCHA_REQUIRED" && source.documentRef && onRequireConfirm && (
                <button
                  type="button"
                  onClick={() => onRequireConfirm(source)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-900/40"
                >
                  <ShieldAlert className="h-3 w-3" aria-hidden />
                  Բացել ամբողջական տեքստը
                </button>
              )}
              {source.resolvedViaUrl && source.fullTextVerified && (
                <a
                  href={source.resolvedViaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
                  title="Ամբողջական տեքստի այլ պաշտոնական աղբյուր"
                >
                  <Search className="h-3 w-3" aria-hidden />
                  Տեքստի աղբյուրը
                  <ExternalLink className="h-2.5 w-2.5 opacity-50" aria-hidden />
                </a>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-neutral-300 dark:text-neutral-600">
                {host}
              </span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function SearchResults({ results, query, onRequireConfirm }: SearchResultsProps) {
  const [activeFilter, setActiveFilter] = useState<SourceLabel | "all">("all");

  // Compute which labels are present in the results
  const availableLabels = useMemo(() => {
    const set = new Set<SourceLabel>();
    for (const r of results) {
      if (r.sourceLabel) set.add(r.sourceLabel);
    }
    return ALL_LABELS.filter((l) => set.has(l));
  }, [results]);

  const filteredResults = useMemo(() => {
    if (activeFilter === "all") return results;
    return results.filter((r) => r.sourceLabel === activeFilter);
  }, [results, activeFilter]);

  if (results.length === 0) return null;

  const hasFilters = availableLabels.length > 1;

  return (
    <section aria-label="ARLIS աղբյուրներ" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Գտնվել են համապատասխան իրավական աղբյուրներ
        </h2>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          {activeFilter === "all" ? results.length : filteredResults.length} արդյունք
          {activeFilter !== "all" && ` (ընդհանուր ${results.length})`}
        </span>
      </div>

      {/* Source-type filter chips (spec §50) */}
      {hasFilters && (
        <div className="enter-slide-up flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
            <Filter className="h-3 w-3" aria-hidden />
            Ֆիլտր՝
          </span>
          <button
            type="button"
            onClick={() => setActiveFilter("all")}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
              activeFilter === "all"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700",
            )}
          >
            Բոլորը ({results.length})
          </button>
          {availableLabels.map((label) => {
            const count = results.filter((r) => r.sourceLabel === label).length;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setActiveFilter(label)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                  activeFilter === label
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700",
                )}
              >
                {labelIcon(label)}
                {label} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="space-y-3">
        {filteredResults.map((r, i) => (
          <ResultCard
            key={`${r.actId ?? r.canonicalUrl ?? i}-${i}`}
            source={r}
            index={results.indexOf(r)}
            onRequireConfirm={onRequireConfirm}
          />
        ))}
      </div>
      {filteredResults.length === 0 && activeFilter !== "all" && (
        <p className="rounded-lg border border-dashed border-neutral-300 bg-white p-4 text-center text-sm text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-500">
          Ընտրված տեսակով արդյունք չկա։
        </p>
      )}
      <p className="sr-only">
        Որոնման հարցում՝ {query}. Վերևում ներկայացված են {results.length} հիմնական իրավական աղբյուրները ARLIS-ից։
      </p>
    </section>
  );
}
