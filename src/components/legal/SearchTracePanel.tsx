"use client";

// SearchTrace — retrieval activity panel (spec §25) — v2 (Phase 3 §50-§53).
// Shows the user WHICH sources were checked and how they responded,
// INCLUDING the per-stage outcome: search / metadata / full text.
// NEVER shows internal chain-of-thought — only retrieval activity.
// Completeness is FACTUAL (documents found / metadata / verified full
// texts) — no fake confidence percentages (§53).

import { CheckCircle2, XCircle, MinusCircle, Clock, Lock, HelpCircle, ShieldAlert, FileSearch } from "lucide-react";
import type { SearchTrace as TraceData, SourceStatus, TraceStageStatus } from "@/lib/legal-search/types";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  SourceStatus,
  { icon: typeof CheckCircle2; label: string; cls: string; hint?: string }
> = {
  SUCCESS: {
    icon: CheckCircle2,
    label: "ստուգված",
    cls: "text-emerald-600 dark:text-emerald-400",
  },
  PARTIAL: {
    icon: ShieldAlert,
    label: "մասնակի (մետատվյալներ)",
    cls: "text-amber-600 dark:text-amber-400",
  },
  EMPTY: {
    icon: MinusCircle,
    label: "արդյունքներ չկան",
    cls: "text-neutral-400 dark:text-neutral-500",
  },
  TIMEOUT: {
    icon: Clock,
    label: "ժամանակը սպառվեց",
    cls: "text-amber-600 dark:text-amber-400",
  },
  RATE_LIMITED: {
    icon: Clock,
    label: "սահմանափակված է",
    cls: "text-amber-600 dark:text-amber-400",
  },
  RESTRICTED: {
    icon: Lock,
    label: "մուտքը սահմանափակված է",
    cls: "text-amber-600 dark:text-amber-400",
  },
  ERROR: { icon: XCircle, label: "անհասանելի", cls: "text-red-500 dark:text-red-400" },
  UNSUPPORTED: {
    icon: MinusCircle,
    label: "չի վերաբերում հարցին",
    cls: "text-neutral-400 dark:text-neutral-500",
  },
};

const STAGE_GLYPH: Record<TraceStageStatus, string> = {
  ok: "✓",
  partial: "△",
  restricted: "✕",
  failed: "✕",
  skipped: "—",
};

const STAGE_CLS: Record<TraceStageStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  restricted: "text-amber-600 dark:text-amber-400",
  failed: "text-red-400 dark:text-red-500",
  skipped: "text-neutral-300 dark:text-neutral-600",
};

function StageRow({ label, stage }: { label: string; stage: TraceStageStatus }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("font-mono text-[10px] font-semibold", STAGE_CLS[stage])} aria-hidden>
        {STAGE_GLYPH[stage]}
      </span>
      <span className="text-neutral-400 dark:text-neutral-500">{label}</span>
    </span>
  );
}

export function SearchTracePanel({ trace }: { trace: TraceData }) {
  const studied = trace.documentsFetched;
  const usedSources = trace.sources.filter((s) => s.status === "SUCCESS" || s.status === "PARTIAL").length;
  const c = trace.completeness;

  return (
    <details
      className="group rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      open={trace.mode === "deep"}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-xs text-neutral-600 dark:text-neutral-300 [&::-webkit-details-marker]:hidden">
        <FileSearch className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
        <span className="font-medium">Որոնումը կատարվել է</span>
        <span className="min-w-0 break-words text-neutral-400 dark:text-neutral-500">
          {trace.mode === "deep" ? "Խորը իրավական որոնում · " : "Արագ որոնում · "}
          {studied} ամբողջական տեքստ · {usedSources} աղբյուր օգտագործվել է
        </span>
        <span className="ml-auto text-neutral-300 transition-transform group-open:rotate-180 dark:text-neutral-600" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="space-y-1.5 border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
        {trace.sources.map((s) => {
          const meta = STATUS_META[s.status] ?? STATUS_META.ERROR;
          const Icon = s.status === "TIMEOUT" ? Clock : meta.icon;
          return (
            <div key={s.id} className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs">
                <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.cls)} aria-hidden />
                <span className="font-medium text-neutral-700 dark:text-neutral-200">{s.name}</span>
                <span className={cn(meta.cls)}>{meta.label}</span>
                {s.resultCount > 0 && (
                  <span className="text-neutral-400 dark:text-neutral-500">· {s.resultCount} արդյունք</span>
                )}
                {s.durationMs > 0 && (
                  <span className="text-neutral-300 dark:text-neutral-600">
                    · {s.durationMs < 1000 ? `${s.durationMs}մվ` : `${(s.durationMs / 1000).toFixed(1)}վ`}
                  </span>
                )}
                {s.status === "RESTRICTED" && s.fallbackUrl && (
                  <a
                    href={s.fallbackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 max-w-[200px] truncate break-all rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  >
                    Բացել ձեր բրաուզերով ↗
                  </a>
                )}
              </div>
              {s.stages && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-6 text-[10px]">
                  <StageRow label="որոնում" stage={s.stages.search} />
                  <StageRow label="մետատվյալներ" stage={s.stages.metadata} />
                  <StageRow label="ամբողջական տեքստ" stage={s.stages.document} />
                  {s.stages.resolutionNote && (
                    <span className="text-neutral-400 dark:text-neutral-500">· {s.stages.resolutionNote}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {c && (
          <div className="mt-2 rounded-lg border border-neutral-100 bg-neutral-50/60 px-3 py-2 text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-800/40 dark:text-neutral-400">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">Ապացույցների ծավալը՝ </span>
            գտնվել է {c.documentsFound} փաստաթուղթ · մետատվյալներով՝ {c.metadataVerified} ·
            ստուգված ամբողջական տեքստով՝ <span className="font-medium text-emerald-600 dark:text-emerald-400">{c.fullTextsVerified}</span>
            {c.resolvedViaFallback > 0 && <> · այլ աղբյուրից լուծված՝ {c.resolvedViaFallback}</>}
            {c.metadataOnly > 0 && <> · միայն մետատվյալներով՝ {c.metadataOnly}</>}
          </div>
        )}

        {(trace.subquestions?.length ?? 0) > 0 && (
          <div className="pt-2">
            <p className="mb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Հարցը բաժանվել է ենթահարցերի
            </p>
            <ol className="list-inside list-decimal space-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              {trace.subquestions!.slice(0, 7).map((q, i) => (
                <li key={i} className="leading-snug">
                  {q.length > 110 ? `${q.slice(0, 110)}…` : q}
                </li>
              ))}
            </ol>
          </div>
        )}

        {trace.expandedQueries.length > 0 && (
          <div className="pt-2">
            <p className="mb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              Որոնման տարբերակներ
            </p>
            <div className="flex flex-wrap gap-1">
              {trace.expandedQueries.slice(0, 8).map((q, i) => (
                <span
                  key={i}
                  className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {q.length > 60 ? `${q.slice(0, 60)}…` : q}
                </span>
              ))}
            </div>
          </div>
        )}
        <p className="pt-1.5 text-[10px] text-neutral-300 dark:text-neutral-600">
          Ընդհանուր ժամանակը՝ {(trace.totalDurationMs / 1000).toFixed(1)} վայրկյան ·
          անցկացված փաստաթղթերից արտահանված հատվածներ՝ {trace.passagesExtracted}
        </p>
      </div>
    </details>
  );
}
