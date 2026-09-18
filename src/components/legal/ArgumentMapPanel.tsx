"use client";

// src/components/legal/ArgumentMapPanel.tsx
// Phase 4 §61 — "Փաստարկների քարտեզ" optional panel in deep mode.
//
//   Issue
//   ├─ Supporting authorities
//   ├─ Counter-authorities
//   ├─ Distinguishing factors
//   └─ Unresolved questions

import { useState } from "react";
import { ChevronRight, GitFork, PlusCircle, MinusCircle, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResearchReport } from "@/lib/legal-research/types";

const STRENGTH_LABELS: Record<string, string> = {
  STRONG: "ուժեղ",
  MODERATE: "միջին",
  LIMITED: "սահմանափակ",
};

const STRENGTH_TONES: Record<string, string> = {
  STRONG: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  MODERATE: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  LIMITED: "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400",
};

export function ArgumentMapPanel({ research }: { research: ResearchReport }) {
  const [open, setOpen] = useState(false);

  if (research.arguments.length === 0 && research.missingFacts.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          <GitFork className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Փաստարկների քարտեզ
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {research.completeness.issuesIdentified} հարց · {research.arguments.length} փաստարկ
        </span>
        <ChevronRight
          className={cn("ml-auto h-4 w-4 text-neutral-400 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-neutral-200/70 px-4 py-3 dark:border-neutral-700/60">
          {research.issueMap.issues.map((issue) => {
            const args = research.arguments.filter((a) => a.issueId === issue.id);
            const missing = research.missingFacts.filter((m) => m.affectedIssueIds.includes(issue.id));
            const hasContent = args.length > 0 || missing.length > 0;
            return (
              <div key={issue.id} className="rounded-lg border border-neutral-200/80 dark:border-neutral-800">
                {/* Issue header */}
                <div className="flex items-baseline gap-2 border-b border-neutral-200/60 px-3 py-2 dark:border-neutral-800">
                  <span className="text-[11px] font-semibold text-neutral-400">{issue.id}</span>
                  <span className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
                    {issue.title}
                  </span>
                  <span
                    className={cn(
                      "ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      issue.status === "SUPPORTED"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                        : issue.status === "CONTRADICTED"
                          ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                          : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
                    )}
                  >
                    {issue.status === "SUPPORTED"
                      ? "աջակցված"
                      : issue.status === "CONTRADICTED"
                        ? "հակասված"
                        : "չլուծված"}
                  </span>
                </div>

                {hasContent ? (
                  <div className="space-y-2 px-3 py-2.5">
                    {/* Supporting (§61) */}
                    {args
                      .filter((a) => a.side === "SUPPORTS_USER_POSITION")
                      .map((a) => (
                        <ArgumentRow key={a.id} argument={a} kind="support" />
                      ))}

                    {/* Counter (§48 — never hidden) */}
                    {args
                      .filter((a) => a.side === "COUNTERARGUMENT")
                      .map((a) => (
                        <ArgumentRow key={a.id} argument={a} kind="counter" />
                      ))}

                    {/* Unresolved / missing facts (§61) */}
                    {missing.map((m, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 rounded-md border border-dashed border-neutral-300 px-2.5 py-1.5 dark:border-neutral-700"
                      >
                        <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
                        <p className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                          {m.factNeeded}. <span className="text-neutral-500">{m.whyItMatters}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-2.5 text-xs text-neutral-500 dark:text-neutral-400">
                    Այս հարցի վերաբերյալ վերլուծված աղբյուր չկա։
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ArgumentRow({
  argument,
  kind,
}: {
  argument: ResearchReport["arguments"][number];
  kind: "support" | "counter";
}) {
  const Icon = kind === "support" ? PlusCircle : MinusCircle;
  const tone =
    kind === "support"
      ? "border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/40 dark:bg-emerald-950/20"
      : "border-red-200/70 bg-red-50/40 dark:border-red-900/40 dark:bg-red-950/20";
  return (
    <div className={cn("rounded-md border px-2.5 py-1.5", tone)}>
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0",
            kind === "support" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
            {argument.proposition}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                STRENGTH_TONES[argument.strength],
              )}
            >
              {STRENGTH_LABELS[argument.strength]}
            </span>
            {argument.authorities.map((a, i) => (
              <span
                key={i}
                className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              >
                {a.evidenceId}
              </span>
            ))}
          </div>
          {argument.limitations.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {argument.limitations.slice(0, 3).map((l, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                  ⚠ {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
