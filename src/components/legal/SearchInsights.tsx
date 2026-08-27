"use client";

import { FileText, Hash, Calendar, Scale, Tag, Lightbulb } from "lucide-react";
import type { LegalQuery } from "@/lib/legal/types";

type SearchInsightsProps = {
  parsed?: LegalQuery;
  resultCount: number;
  retrievalMs?: number;
};

const QUESTION_TYPE_LABELS: Record<string, string> = {
  exact_article: "Հստակ հոդված",
  legal_rule: "Իրավական նորմ",
  case_law: "Դատական նախադեպ",
  definition: "Սահմանում",
  procedure: "Ընթացակարգ",
  unknown: "Անհայտ",
};

/**
 * Compact insights panel showing the parsed query structure + retrieval stats.
 * Helps users understand how the system interpreted their query (spec §31).
 */
export function SearchInsights({ parsed, resultCount, retrievalMs }: SearchInsightsProps) {
  if (!parsed) return null;

  const items: Array<{ icon: React.ReactNode; label: string; value: string }> = [];

  if (parsed.actTitle) {
    items.push({
      icon: <Scale className="h-3.5 w-3.5" aria-hidden />,
      label: "Ակտ",
      value: parsed.actTitle,
    });
  }
  if (parsed.article) {
    items.push({
      icon: <Hash className="h-3.5 w-3.5" aria-hidden />,
      label: "Հոդված",
      value: parsed.article + (parsed.part ? ` · մաս ${parsed.part}` : ""),
    });
  }
  if (parsed.date) {
    items.push({
      icon: <Calendar className="h-3.5 w-3.5" aria-hidden />,
      label: "Ամսաթիվ",
      value: parsed.date,
    });
  }
  if (parsed.caseNumber) {
    items.push({
      icon: <FileText className="h-3.5 w-3.5" aria-hidden />,
      label: "Գործի համար",
      value: parsed.caseNumber,
    });
  }
  if (parsed.questionType && parsed.questionType !== "unknown") {
    items.push({
      icon: <Lightbulb className="h-3.5 w-3.5" aria-hidden />,
      label: "Հարցի տեսակ",
      value: QUESTION_TYPE_LABELS[parsed.questionType] ?? parsed.questionType,
    });
  }
  if (parsed.keywords.length > 0) {
    items.push({
      icon: <Tag className="h-3.5 w-3.5" aria-hidden />,
      label: "Բանալի բառեր",
      value: parsed.keywords.slice(0, 6).join(", "),
    });
  }

  if (items.length === 0 && !retrievalMs) return null;

  return (
    <div className="enter-slide-up rounded-lg border border-neutral-200 bg-white/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/40 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-neutral-400 dark:text-neutral-500">{item.icon}</span>
            <span className="font-medium text-neutral-500 dark:text-neutral-400">{item.label}՝</span>
            <span className="max-w-[20rem] truncate text-neutral-700 dark:text-neutral-200" title={item.value}>
              {item.value}
            </span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
          <span>{resultCount} արդյունք</span>
          {typeof retrievalMs === "number" && <span>· ~{retrievalMs}ms</span>}
        </div>
      </div>
    </div>
  );
}
