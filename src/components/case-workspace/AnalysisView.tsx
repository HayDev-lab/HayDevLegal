"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  Loader2,
  Play,
  FileText,
  Eye,
} from "lucide-react";
import { PackInspector } from "./PackInspector";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalysisResult {
  id: string;
  requestId: string;
  status: string;
  provider: string | null;
  analysisVersion: string;
  errorDetail: string | null;
  createdAt: string;
}

interface Props {
  caseId: string;
}

export function AnalysisView({ caseId }: Props) {
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"auto" | "codex" | "deterministic">("auto");
  const [error, setError] = useState<string | undefined>();
  const [inspected, setInspected] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/analysis`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { results: AnalysisResult[] };
      setResults(data.results ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAnalysis(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setRunning(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), mode }),
      });
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      setQuery("");
      setInspected(false); // reset for next run
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!inspected) {
            // §19 — encourage inspection before running. Soft gate: open the
            // inspector instead of running.
            setShowInspector(true);
            return;
          }
          void runAnalysis(e);
        }}
        className="mb-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/50"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            <Brain className="h-4 w-4" />
            Գործի խորքային վերլուծություն
          </h3>
          <button
            type="button"
            onClick={() => setShowInspector(true)}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Eye className="h-3.5 w-3.5" />
            Տեսնել փաթեթը
          </button>
        </div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Վերլուծության հարց՝ օր.՝ Համեմատել մեղադրյալի գործողությունները քրեական դատավարության օրենսգրքի 108-րդ հոդվածի կիրառելիության տեսանկյունից..."
          className="mb-3 h-24 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            {(["auto", "codex", "deterministic"] as const).map((m) => (
              <label key={m} className="inline-flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name="mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="h-3 w-3"
                />
                <span className="text-neutral-600 dark:text-neutral-400">{m}</span>
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={running || !query.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            title={inspected ? undefined : "Նախ ստուգեք փաթեթը"}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Վերլուծվում է..." : inspected ? "Վերլուծել" : "Տեսնել փաթեթը նախ"}
          </button>
          {inspected && (
            <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
              ✓ Փաթեթը ստուգված է — պատրաստ է գործարկման
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-500">
          auto՝ Codex (եթե հասանելի է), այլապես deterministic վերլուծություն ·
          deterministic՝ միշտ որոշունակ վերլուծություն (առանց LLM-ի) ·
          §19 — փաթեթը ստուգեք նախքան գործարկումը (counts, ոչ chain-of-thought)
        </p>
      </form>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          {error}
          <button
            onClick={() => setError(undefined)}
            className="ml-2 underline underline-offset-2"
          >
            փակել
          </button>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-neutral-500">
          <Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է…
        </p>
      ) : results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <FileText className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            դեռ վերլուծության արդյունքներ չկան։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {results.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  {r.provider && (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {r.provider}
                    </span>
                  )}
                </div>
                <time className="text-[10px] text-neutral-500 dark:text-neutral-500">
                  {new Date(r.createdAt).toLocaleString()}
                </time>
              </div>
              <div className="text-[10px] font-mono text-neutral-500 dark:text-neutral-500">
                request_id: {r.requestId}
              </div>
              {r.errorDetail && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {r.errorDetail}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* §19 Pack inspector modal */}
      <PackInspector
        caseId={caseId}
        open={showInspector}
        onClose={() => setShowInspector(false)}
        onRun={() => {
          setInspected(true);
          // After inspection, immediately attempt the run.
          if (query.trim()) {
            void runAnalysis();
          }
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    SUCCESS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    DETERMINISTIC_ONLY: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    PARTIAL: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    PARTIAL_AI_UNAVAILABLE: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    BLOCKED_EXTERNAL_QUOTA: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    FAILED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
      {status}
    </span>
  );
}
