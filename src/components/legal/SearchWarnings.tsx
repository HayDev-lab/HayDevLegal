"use client";

// SearchWarnings — user-facing notices from the federated search:
// temporal applicability, restricted sources, partial results.

import { AlertTriangle, Clock, Globe } from "lucide-react";
import type { SearchWarning } from "@/lib/legal-search/types";
import { cn } from "@/lib/utils";

const ICONS: Record<SearchWarning["kind"], typeof AlertTriangle> = {
  temporal: Clock,
  restricted: Globe,
  conflict: AlertTriangle,
  partial: AlertTriangle,
};

const STYLES: Record<SearchWarning["kind"], string> = {
  temporal:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200",
  restricted:
    "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300",
  conflict:
    "border-red-200 bg-red-50 text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200",
  partial:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200",
};

export function SearchWarnings({ warnings }: { warnings: SearchWarning[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="space-y-2" aria-label="Որոնման զգուշացումներ">
      {warnings.slice(0, 4).map((w, i) => {
        const Icon = ICONS[w.kind] ?? AlertTriangle;
        return (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed",
              STYLES[w.kind] ?? STYLES.partial,
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-words">{w.message}</span>
          </div>
        );
      })}
    </div>
  );
}
