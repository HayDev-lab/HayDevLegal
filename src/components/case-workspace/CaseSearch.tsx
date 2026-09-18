"use client";

import { useState } from "react";
import { Search, Loader2 } from "lucide-react";

interface Hit { documentId: string; pageNumber: number; snippet: string; score: number; }

export function CaseSearch({ caseId }: { caseId: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setError(undefined); setSearched(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/search?q=${encodeURIComponent(query)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { hits: Hit[]; total: number };
      setHits(data.hits ?? []); setTotal(data.total ?? 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <form onSubmit={runSearch} className="mb-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Փնտրել փաստաթղթերում, էջերում, ամսաթվերում, անձանց անուններում..."
              className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-10 pr-3 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Որոնել
          </button>
        </div>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {searched && !loading && (
        <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
          {total} արդյունք
        </p>
      )}

      {hits.length > 0 && (
        <div className="space-y-2">
          {hits.map((h, i) => (
            <div key={`${h.documentId}-${h.pageNumber}-${i}`} className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400">{h.documentId.slice(0, 12)}...</span>
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400">էջ {h.pageNumber} · միավոր {h.score.toFixed(2)}</span>
              </div>
              <p className="mt-1 text-sm text-neutral-800 dark:text-neutral-200">{h.snippet}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
