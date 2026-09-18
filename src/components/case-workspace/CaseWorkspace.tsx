"use client";

import { useCallback, useEffect, useState } from "react";
import { CaseList } from "./CaseList";
import { CaseDetail } from "./CaseDetail";
import type { CaseWorkspace as CaseWorkspaceType } from "@/lib/case-workspace/types";

export function CaseWorkspace() {
  const [cases, setCases] = useState<CaseWorkspaceType[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetch("/api/cases");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { cases: CaseWorkspaceType[] };
      setCases(data.cases ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const activeCase = cases.find((c) => c.id === activeCaseId) ?? null;

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-12 pt-4 sm:px-6">
      <header className="mb-6 flex flex-col gap-2 border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            Գործերի աշխատասեղան
          </h1>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            Phase 5
          </span>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Փաստաթղթերի վերլուծություն · ժամանակագրություն · փաստերի մատրիցա · ապացույցներ · հակասություններ · իրավական հետազոտություն · Codex խորքային վերլուծություն
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          Սխալ՝ {error}
          <button
            onClick={() => void loadCases()}
            className="ml-2 underline underline-offset-2"
          >
            կրկին
          </button>
        </div>
      )}

      {activeCase ? (
        <CaseDetail
          case_={activeCase}
          onBack={() => {
            setActiveCaseId(null);
            void loadCases();
          }}
        />
      ) : (
        <CaseList
          cases={cases}
          loading={loading}
          onOpen={(id) => setActiveCaseId(id)}
          onCreated={(id) => setActiveCaseId(id)}
        />
      )}
    </section>
  );
}
