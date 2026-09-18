"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { CaseWorkspace as CaseWorkspaceType, CaseType } from "@/lib/case-workspace/types";

interface Props {
  cases: CaseWorkspaceType[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
}

const CASE_TYPES: CaseType[] = [
  "CRIMINAL", "CIVIL", "ADMINISTRATIVE", "BANKRUPTCY", "CONSTITUTIONAL", "ECHR", "OTHER",
];

export function CaseList({ cases, loading, onOpen, onCreated }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [caseNumber, setCaseNumber] = useState("");
  const [caseType, setCaseType] = useState<CaseType>("OTHER");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      const r = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), caseNumber: caseNumber.trim() || undefined, caseType }),
      });
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { case: CaseWorkspaceType };
      setTitle("");
      setCaseNumber("");
      setShowCreate(false);
      onCreated(data.case.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Գործեր ({cases.length})
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          <Plus className="h-4 w-4" />
          Նոր գործ
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/50"
        >
          <h3 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Ստեղծել նոր գործ
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Վերնագիր *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="օր.՝ Քրեական գործ № ԱՍ-1234/24"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Գործի համար</label>
              <input
                type="text"
                value={caseNumber}
                onChange={(e) => setCaseNumber(e.target.value)}
                placeholder="ԱՍ-1234/24"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Գործի տեսակ</label>
            <select
              value={caseType}
              onChange={(e) => setCaseType(e.target.value as CaseType)}
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
            >
              {CASE_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </div>
          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={creating || !title.trim()}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {creating ? "Ստեղծվում է..." : "Ստեղծել"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Չեղարկել
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Բեռնվում է...</p>
      ) : cases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Դեռ գործեր չկան։ Ստեղծեք առաջին գործը՝ սկսելու համար։
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cases.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpen(c.id)}
              className="group rounded-xl border border-neutral-200 bg-white p-4 text-left transition hover:border-neutral-400 hover:shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-500"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-neutral-900 group-hover:text-neutral-700 dark:text-neutral-100 dark:group-hover:text-neutral-300">
                  {c.title}
                </h3>
                {c.status === "ARCHIVED" && (
                  <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] uppercase text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                    արխիվ
                  </span>
                )}
              </div>
              {c.caseNumber && (
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{c.caseNumber}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-neutral-500 dark:text-neutral-400">
                <span>{c.documentCount} փաստաթուղթ</span>
                <span>{c.pageCount} էջ</span>
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                  {c.caseType}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
