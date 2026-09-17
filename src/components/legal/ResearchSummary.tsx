"use client";

// src/components/legal/ResearchSummary.tsx
// Phase 4 §102 — research completeness summary line (deep mode):
// "5 իրավական հարց · 8 առաջնային աղբյուր · 4 կիրառելի նախադեպ ..."
// NO "legal correctness %" (§101) — concrete facts only.

import { useMemo } from "react";
import { FileSearch } from "lucide-react";
import type { ResearchReport } from "@/lib/legal-research/types";
import { researchSummaryLine } from "@/lib/legal-research/synthesis/legal-synthesis";

export function ResearchSummary({
  research,
  evidenceCount,
}: {
  research: ResearchReport;
  evidenceCount: number;
}) {
  const line = useMemo(() => researchSummaryLine(research), [research]);
  if (research.applicability.length === 0 && research.holdings.length === 0) return null;

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
      <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
      <p className="leading-relaxed">
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">Խորքային վերլուծություն. </span>
        {line} · {evidenceCount} աղբյուր ապացույցների փաթեթում
        {research.partial && (
          <span className="ml-1 text-amber-600 dark:text-amber-400">(մասնակի)</span>
        )}
      </p>
    </div>
  );
}
