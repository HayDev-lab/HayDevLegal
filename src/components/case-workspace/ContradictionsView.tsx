"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";

interface Contradiction {
  id: string;
  contradictionType: string;
  significance: string;
  status: string;
  claimA: string;
  claimB: string;
  reason: string | null;
}

export function ContradictionsView({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<Contradiction[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/contradictions`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { contradictions: Contradiction[] };
      setItems(data.contradictions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBuilding(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/contradictions`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { contradictions: Contradiction[] };
      setItems(data.contradictions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBuilding(false); }
  }

  if (loading) return <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{items.length} հակասություն</p>
        <button
          onClick={rebuild}
          disabled={building}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {building ? "Հայտնաբերվում է..." : "Բացահայտել հակասությունները"}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <AlertTriangle className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Հակասություններ չեն հայտնաբերվել։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((c) => {
            let a: { proposition?: string } = {};
            let b: { proposition?: string } = {};
            try { a = JSON.parse(c.claimA); } catch { /* */ }
            try { b = JSON.parse(c.claimB); } catch { /* */ }
            return (
              <div key={c.id} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{c.contradictionType}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${c.significance === "HIGH" ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300" : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"}`}>{c.significance}</span>
                  </div>
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{c.status}</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-md bg-emerald-50 p-2 text-xs dark:bg-emerald-950/20">
                    <div className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">A</div>
                    <div className="text-neutral-800 dark:text-neutral-200">{a.proposition ?? c.claimA}</div>
                  </div>
                  <div className="rounded-md bg-red-50 p-2 text-xs dark:bg-red-950/20">
                    <div className="text-[10px] font-medium text-red-700 dark:text-red-400">B</div>
                    <div className="text-neutral-800 dark:text-neutral-200">{b.proposition ?? c.claimB}</div>
                  </div>
                </div>
                {c.reason && <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{c.reason}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
