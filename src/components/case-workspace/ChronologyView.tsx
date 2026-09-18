"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Calendar,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Plus,
  ChevronRight,
  ChevronDown,
  GitMerge,
  Split,
  Check,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirror prisma schema + §15 review fields
// ---------------------------------------------------------------------------

interface ChronologyEvent {
  id: string;
  date: string | null;
  originalDateText: string | null;
  dateStatus: string;
  eventType: string;
  title: string;
  originalTitle?: string | null;
  description: string | null;
  originalDescription?: string | null;
  participants: string;
  evidenceRefs: string;
  verification: string;
  hasConflict: boolean;
  conflictDetail: string | null;
  reviewStatus?: string;
}

interface Props {
  caseId: string;
}

const EVENT_TYPES = [
  "HEARING",
  "FILING",
  "SEARCH",
  "SEIZURE",
  "INTERROGATION",
  "ARREST",
  "DECISION",
  "OTHER",
];

export function ChronologyView({ caseId }: Props) {
  const [events, setEvents] = useState<ChronologyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/chronology`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { events: ChronologyEvent[] };
      setEvents(data.events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rebuild() {
    setBuilding(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/chronology`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { events: ChronologyEvent[] };
      setEvents(data.events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  // ---------------------------------------------------------------------
  // PATCH event — §15 review fields
  // ---------------------------------------------------------------------

  async function patchEvent(
    eventId: string,
    payload: {
      title?: string;
      description?: string;
      reviewStatus?: "CONFIRMED" | "REJECTED" | "UNREVIEWED";
      evidenceRefs?: string;
    },
  ): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/chronology/${eventId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (իրադարձության խմբագրում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string; detail?: string };
        throw new Error(err.error ?? err.detail ?? `HTTP ${r.status}`);
      }
      // Optimistic local update.
      setEvents((prev) =>
        prev.map((e) => {
          if (e.id !== eventId) return e;
          return {
            ...e,
            title: payload.title ?? e.title,
            description: payload.description ?? e.description,
            evidenceRefs: payload.evidenceRefs ?? e.evidenceRefs,
            reviewStatus: payload.reviewStatus ?? e.reviewStatus,
          };
        }),
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Merge two events — §15 "Merge duplicates" action
  // Sends PATCH /api/cases/:id/chronology/:eventId with mergeTargetId in body
  // (the main agent will add the merge endpoint).
  // ---------------------------------------------------------------------

  async function mergeEvents(sourceId: string, targetId: string): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/chronology/${targetId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mergeFromId: sourceId }),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (իրադարձությունների միացում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Split bad merge — §15 "Split bad merge" — restores the source event.
  // ---------------------------------------------------------------------

  async function splitEvent(eventId: string): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/chronology/${eventId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ splitMerged: true }),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (իրադարձության տրոհում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Manual event creation — POST /api/cases/:id/chronology (server may not
  // support single-event creation yet; we fall back gracefully on 404/405).
  // ---------------------------------------------------------------------

  async function createManualEvent(input: {
    date: string; // ISO date text (originalDateText)
    eventType: string;
    title: string;
    description: string;
  }): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/chronology`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manual: true, ...input }),
      });
      if (r.status === 404 || r.status === 405) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (ձեռքով իրադարձության մուտքագրում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  if (loading) {
    return (
      <p className="py-8 text-center text-sm text-neutral-500">
        <Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է…
      </p>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
        {error}
        <button
          onClick={() => void load()}
          className="ml-2 underline underline-offset-2"
        >
          կրկին
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Similarity heuristic — two events with similar titles are candidates
  // for merging (we surface a "Merge" action when available).
  // ---------------------------------------------------------------------

  function similarEvents(i: number): string | null {
    const a = events[i];
    if (!a) return null;
    for (let j = 0; j < events.length; j++) {
      if (j === i) continue;
      const b = events[j];
      const ta = a.title.toLowerCase().trim();
      const tb = b.title.toLowerCase().trim();
      // Heuristic — same eventType + >=70% token overlap.
      if (a.eventType === b.eventType && tokenOverlap(ta, tb) >= 0.7) {
        return b.id;
      }
    }
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {events.length} իրադարձություն
          {events.some((e) => e.hasConflict) && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              · {events.filter((e) => e.hasConflict).length} կոնֆլիկտ
            </span>
          )}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowManual(!showManual)}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Ձեռքով իրադարձություն
          </button>
          <button
            onClick={rebuild}
            disabled={building}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {building ? "Կառուցվում է..." : "Կառուցել ժամանակագրությունը"}
          </button>
        </div>
      </div>

      {showManual && (
        <ManualEventForm
          onCancel={() => setShowManual(false)}
          onSubmit={async (input) => {
            const ok = await createManualEvent(input);
            if (ok) setShowManual(false);
          }}
        />
      )}

      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Calendar className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Ժամանակագրությունը դեռ չի կառուցվել։ Վերբեռնեք փաստաթղթեր, ապա սեղմեք «Կառուցել»։
          </p>
        </div>
      ) : (
        <ol className="relative border-l border-neutral-200 dark:border-neutral-700">
          {events.map((e, i) => {
            const isEditing = editingId === e.id;
            const mergeTargetId = similarEvents(i);
            const isRejected = e.reviewStatus === "REJECTED";
            const isEdited =
              e.reviewStatus === "EDITED" &&
              e.originalTitle !== undefined &&
              e.originalTitle !== null &&
              e.originalTitle !== e.title;
            return (
              <li
                key={e.id}
                className={`mb-4 ml-4 ${isRejected ? "opacity-50" : ""}`}
              >
                <div className={`absolute -left-1.5 h-3 w-3 rounded-full ${e.hasConflict ? "bg-amber-500" : isRejected ? "bg-red-400" : "bg-neutral-400"}`} />
                <time className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  {e.date ?? e.originalDateText ?? "(ամսաթիվը անհայտ է)"}
                  <span className="ml-2 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                    {e.dateStatus}
                  </span>
                  <span className="ml-2 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                    {e.eventType}
                  </span>
                  {e.reviewStatus && (
                    <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${reviewStatusClass(e.reviewStatus)}`}>
                      {e.reviewStatus}
                    </span>
                  )}
                </time>
                {isEditing ? (
                  <EventEditor
                    event={e}
                    onSave={async (title, description) => {
                      const ok = await patchEvent(e.id, {
                        title,
                        description,
                        reviewStatus: "CONFIRMED",
                      });
                      if (ok) setEditingId(null);
                    }}
                    onConfirm={async () => {
                      const ok = await patchEvent(e.id, { reviewStatus: "CONFIRMED" });
                      if (ok) setEditingId(null);
                    }}
                    onReject={async () => {
                      const ok = await patchEvent(e.id, { reviewStatus: "REJECTED" });
                      if (ok) setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <h3 className="mt-0.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      {e.title}
                    </h3>
                    {isEdited && (
                      <p className="mt-0.5 text-[11px] italic text-neutral-500 dark:text-neutral-400">
                        Բնօրինակ վերնագիր՝ {e.originalTitle}
                      </p>
                    )}
                    {e.description && (
                      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{e.description}</p>
                    )}
                    {e.hasConflict && e.conflictDetail && (
                      <p className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                        <AlertTriangle className="mr-1 inline h-3 w-3" />
                        Ամսաթվի կոնֆլիկտ՝ {e.conflictDetail}
                        <span className="ml-2 text-[10px] text-amber-700 dark:text-amber-500">
                          (ոչ մի ինքնակամ լուծում — §15)
                        </span>
                      </p>
                    )}
                    <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-500">
                      Ստուգում՝ {e.verification}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(e.id)}
                        className="inline-flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        <ChevronRight className="h-3 w-3" /> Խմբագրել
                      </button>
                      {mergeTargetId && (
                        <button
                          type="button"
                          onClick={() => void mergeEvents(e.id, mergeTargetId)}
                          className="inline-flex items-center gap-1 rounded border border-sky-300 px-1.5 py-0.5 text-[10px] text-sky-700 hover:bg-sky-100 dark:border-sky-700 dark:text-sky-400 dark:hover:bg-sky-950/40"
                          title="Կա նմանատիպ իրադարձություն — միացնել"
                        >
                          <GitMerge className="h-3 w-3" /> Միացնել կրկնօրինակի հետ
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void splitEvent(e.id)}
                        className="inline-flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        title="Տրոհել սխալ միացված իրադարձությունը"
                      >
                        <Split className="h-3 w-3" /> Տրոհել
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event inline editor
// ---------------------------------------------------------------------------

function EventEditor({
  event,
  onSave,
  onConfirm,
  onReject,
  onCancel,
}: {
  event: ChronologyEvent;
  onSave: (title: string, description: string) => void;
  onConfirm: () => void;
  onReject: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description ?? "");
  return (
    <div className="mt-1 rounded-md border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">Վերնագիր</label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="mb-2 w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        autoFocus
      />
      <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">Նկարագրություն</label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="mb-2 h-16 w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
      />
      <p className="mb-2 text-[10px] text-neutral-500 dark:text-neutral-500">
        Բնօրինակ վերնագիրն ու նկարագրությունը պահպանվում են սերվերում (originalTitle/originalDescription)։
      </p>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => onSave(title, description)}
          disabled={!title.trim()}
          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Check className="h-3 w-3" /> Պահպանել + հաստատել
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="inline-flex items-center gap-1 rounded border border-emerald-300 px-2 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400"
        >
          <Check className="h-3 w-3" /> Միայն հաստատել
        </button>
        <button
          type="button"
          onClick={onReject}
          className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-red-700"
        >
          <X className="h-3 w-3" /> Մերժել
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
        >
          Չեղարկել
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual event form
// ---------------------------------------------------------------------------

function ManualEventForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    date: string;
    eventType: string;
    title: string;
    description: string;
  }) => void;
}) {
  const [date, setDate] = useState("");
  const [eventType, setEventType] = useState("OTHER");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSubmit({
          date: date.trim(),
          eventType,
          title: title.trim(),
          description: description.trim(),
        });
      }}
      className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/20"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Մուտքագրել իրադարձություն ձեռքով
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          type="text"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          placeholder="Ամսաթիվ (օրիգինալ տեքստ, օր.՝ 2024-08-15)"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Վերնագիր"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          autoFocus
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Նկարագրություն (ոչ պարտադիր)"
        className="h-16 w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!title.trim()}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          Ավելացնել
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
        >
          Չեղարկել
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

function reviewStatusClass(status: string): string {
  switch (status) {
    case "CONFIRMED":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "EDITED":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300";
    case "REJECTED":
      return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
    case "UNREVIEWED":
    default:
      return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400";
  }
}
