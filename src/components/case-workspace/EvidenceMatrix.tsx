"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Scale } from "lucide-react";

interface EvidenceLink {
  id: string;
  factId: string | null;
  evidenceRef: string;
  relation: string;
  strength: string;
}

export function EvidenceMatrix({ caseId }: { caseId: string }) {
  const [links, setLinks] = useState<EvidenceLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/evidence`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { links: EvidenceLink[] };
      setLinks(data.links ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBuilding(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST" });
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
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{links.length} կապ</p>
        <button
          onClick={rebuild}
          disabled={building}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {building ? "Կառուցվում է..." : "Կառուցել ապացույցների մատրիցան"}
        </button>
      </div>

      {links.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Scale className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Ապացույցների մատրիցան դեռ չի կառուցվել։
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Փաստ ID</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Աղբյուր</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Հարաբերություն</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Ուժգնություն</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {links.map((l) => {
                let ref: { documentId?: string; page?: number; quote?: string } = {};
                try { ref = JSON.parse(l.evidenceRef); } catch { /* */ }
                return (
                  <tr key={l.id} className="bg-white dark:bg-neutral-900">
                    <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{l.factId ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono text-neutral-700 dark:text-neutral-300">{ref.documentId?.slice(0, 12)}...</div>
                      {ref.page && <div className="text-[10px] text-neutral-500">էջ {ref.page}</div>}
                    </td>
                    <td className="px-3 py-2"><RelationBadge relation={l.relation} /></td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{l.strength}</td>
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

function RelationBadge({ relation }: { relation: string }) {
  const colors: Record<string, string> = {
    SUPPORTS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    CONTRADICTS: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    CONTEXT: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    AUTHENTICATES: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[relation] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>{relation}</span>;
}
