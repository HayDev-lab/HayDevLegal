"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Layers } from "lucide-react";

interface CaseFact {
  id: string;
  proposition: string;
  category: string;
  status: string;
  materiality: string;
  supportingEvidence: string;
  contradictingEvidence: string;
  source: string;
}

export function FactMatrix({ caseId }: { caseId: string }) {
  const [facts, setFacts] = useState<CaseFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { facts: CaseFact[] };
      setFacts(data.facts ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBuilding(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBuilding(false); }
  }

  if (loading) return <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{facts.length} փաստ</p>
        <button
          onClick={rebuild}
          disabled={building}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {building ? "Կառուցվում է..." : "Կառուցել փաստերի մատրիցան"}
        </button>
      </div>

      {facts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Layers className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Փաստերի մատրիցան դեռ չի կառուցվել։ Վերբեռնեք փաստաթղթեր, ապա սեղմեք «Կառուցել»։
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Փաստ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Կարգավիճակ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Կարևորություն</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Աղբյուր</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {facts.map((f) => {
                const sup = safeParse(f.supportingEvidence).length;
                const con = safeParse(f.contradictingEvidence).length;
                return (
                  <tr key={f.id} className="bg-white dark:bg-neutral-900">
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-900 dark:text-neutral-100">{f.proposition}</div>
                      <div className="mt-1 flex gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
                        <span className="text-emerald-600 dark:text-emerald-400">+{sup} ապացույց</span>
                        <span className="text-red-600 dark:text-red-400">-{con} հակասություն</span>
                      </div>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={f.status} /></td>
                    <td className="px-3 py-2 text-xs"><MaterialityBadge level={f.materiality} /></td>
                    <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{f.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function safeParse(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    ALLEGED: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    DISPUTED: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    CONTRADICTED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    UNKNOWN: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.UNKNOWN}`}>{status}</span>;
}

function MaterialityBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    HIGH: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    LOW: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[level] ?? colors.LOW}`}>{level}</span>;
}
