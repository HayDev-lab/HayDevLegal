"use client";

import { useState } from "react";
import { ArrowLeft, FileText, Calendar, Layers, Scale, Search as SearchIcon, Brain, AlertTriangle } from "lucide-react";
import type { CaseWorkspace as CaseWorkspaceType } from "@/lib/case-workspace/types";
import { DocumentList } from "./DocumentList";
import { ChronologyView } from "./ChronologyView";
import { FactMatrix } from "./FactMatrix";
import { EvidenceMatrix } from "./EvidenceMatrix";
import { ContradictionsView } from "./ContradictionsView";
import { CaseSearch } from "./CaseSearch";
import { AnalysisView } from "./AnalysisView";
import { DraftsView } from "./DraftsView";
import { StrategyView } from "./StrategyView";

type Tab = "documents" | "chronology" | "facts" | "evidence" | "contradictions" | "search" | "analysis" | "drafts" | "strategy";

interface Props {
  case_: CaseWorkspaceType;
  onBack: () => void;
}

const TABS: Array<{ id: Tab; label: string; icon: typeof FileText }> = [
  { id: "documents", label: "Փաստաթղթեր", icon: FileText },
  { id: "chronology", label: "Ժամանակագրություն", icon: Calendar },
  { id: "facts", label: "Փաստեր", icon: Layers },
  { id: "evidence", label: "Ապացույցներ", icon: Scale },
  { id: "contradictions", label: "Հակասություններ", icon: AlertTriangle },
  { id: "search", label: "Որոնում", icon: SearchIcon },
  { id: "analysis", label: "Վերլուծություն", icon: Brain },
  { id: "drafts", label: "Փաստաթղթերի նախագիծ", icon: FileText },
  { id: "strategy", label: "Ռազմավարություն", icon: Brain },
];

export function CaseDetail({ case_: c, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("documents");
  // When documents are uploaded in the child, the parent re-fetches cases and
  // passes a fresh `c` prop — the display updates naturally without local
  // sync state (avoids the set-state-in-effect lint rule).

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        <ArrowLeft className="h-4 w-4" />
        Գործերի ցանկ
      </button>

      <header className="mb-6 border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
          {c.title}
        </h1>
        {c.caseNumber && (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Գործ № {c.caseNumber}
            {c.court && ` · ${c.court}`}
            {c.proceedingType && ` · ${c.proceedingType}`}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {c.caseType}
          </span>
          <span>{c.documentCount} փաստաթուղթ</span>
          <span>{c.pageCount} էջ</span>
          <span>Կարգավիճակ՝ {c.status === "ACTIVE" ? "Ակտիվ" : "Արխիվացված"}</span>
        </div>
      </header>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${
                active
                  ? "border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                  : "border-transparent text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="min-h-[400px]">
        {tab === "documents" && (
          <DocumentList caseId={c.id} onUploaded={onBack} />
        )}
        {tab === "chronology" && <ChronologyView caseId={c.id} />}
        {tab === "facts" && <FactMatrix caseId={c.id} />}
        {tab === "evidence" && <EvidenceMatrix caseId={c.id} />}
        {tab === "contradictions" && <ContradictionsView caseId={c.id} />}
        {tab === "search" && <CaseSearch caseId={c.id} />}
        {tab === "analysis" && <AnalysisView caseId={c.id} />}
        {tab === "drafts" && <DraftsView caseId={c.id} />}
        {tab === "strategy" && <StrategyView caseId={c.id} />}
      </div>
    </div>
  );
}
