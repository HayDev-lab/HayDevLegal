"use client";

import { useCallback, useEffect, useState } from "react";
import { Calendar, Loader2, RefreshCw } from "lucide-react";

interface ChronologyEvent {
  id: string;
  date: string | null;
  originalDateText: string | null;
  dateStatus: string;
  eventType: string;
  title: string;
  description: string | null;
  participants: string;
  evidenceRefs: string;
  verification: string;
  hasConflict: boolean;
  conflictDetail: string | null;
}

export function ChronologyView({ caseId }: { caseId: string }) {
  const [events, setEvents] = useState<ChronologyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/chronology`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { events: ChronologyEvent[] };
      setEvents(data.events ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function rebuild() {
    setBuilding(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/chronology`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { events: ChronologyEvent[] };
      setEvents(data.events ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBuilding(false); }
  }

  if (loading) return <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {events.length} իրադարձություն
          {events.some((e) => e.hasConflict) && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">· {events.filter((e) => e.hasConflict).length} կոնֆլիկտ</span>
          )}
        </p>
        <button
          onClick={rebuild}
          disabled={building}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {building ? "Կառուցվում է..." : "Կառուցել ժամանակագրությունը"}
        </button>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Calendar className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Ժամանակագրությունը դեռ չի կառուցվել։ Վերբեռնեք փաստաթղթեր, ապա սեղմեք «Կառուցել»։
          </p>
        </div>
      ) : (
        <ol className="relative border-l border-neutral-200 dark:border-neutral-700">
          {events.map((e) => (
            <li key={e.id} className="mb-4 ml-4">
              <div className={`absolute -left-1.5 h-3 w-3 rounded-full ${e.hasConflict ? "bg-amber-500" : "bg-neutral-400"}`} />
              <time className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {e.date ?? e.originalDateText ?? "(ամսաթիվը անհայտ է)"}
                <span className="ml-2 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  {e.dateStatus}
                </span>
              </time>
              <h3 className="mt-0.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{e.title}</h3>
              {e.description && <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{e.description}</p>}
              {e.hasConflict && e.conflictDetail && (
                <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">⚠ {e.conflictDetail}</p>
              )}
              <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-500">
                Ստուգում՝ {e.verification}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
