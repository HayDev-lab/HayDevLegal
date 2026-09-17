"use client";

// SearchModeToggle — QUICK vs DEEP RESEARCH (spec §23).
//   Արագ որոնում — local laws + ARLIS + official sources, fast answer.
//   Խորը իրավական որոնում — decomposition + court practice + ConCourt + HUDOC + web.

import { Zap, Microscope } from "lucide-react";
import type { SearchMode } from "@/lib/legal-search/types";
import { cn } from "@/lib/utils";

export function SearchModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: SearchMode;
  onChange: (mode: SearchMode) => void;
  disabled?: boolean;
}) {
  const options: Array<{ value: SearchMode; label: string; icon: typeof Zap; hint: string }> = [
    { value: "quick", label: "Արագ որոնում", icon: Zap, hint: "Օրենսդրություն + պաշտոնական աղբյուրներ" },
    {
      value: "deep",
      label: "Խորը իրավական որոնում",
      icon: Microscope,
      hint: "Դատական պրակտիկա + Սահմանադրական դատարան + ՄԻԵՎԴ + վեբ",
    },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Որոնման ռեժիմ"
      className="inline-flex overflow-hidden rounded-full border border-neutral-200 bg-white p-0.5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
    >
      {options.map((opt) => {
        const active = mode === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.hint}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 sm:px-4",
              active
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{opt.label}</span>
            <span className="sm:hidden">{opt.value === "quick" ? "Արագ" : "Խորը"}</span>
          </button>
        );
      })}
    </div>
  );
}
