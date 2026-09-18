"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Save,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Contradiction {
  id: string;
  contradictionType: string;
  significance: string;
  status: string; // OPEN | EXPLAINED | RESOLVED
  claimA: string; // JSON
  claimB: string; // JSON
  reason: string | null;
  resolutionNote?: string | null;
  reviewedAt?: string | null;
}

interface Props {
  caseId: string;
}

const STATUS_OPTIONS = ["OPEN", "EXPLAINED", "RESOLVED"] as const;

export function ContradictionsView({ caseId }: Props) {
  const [items, setItems] = useState<Contradiction[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string>("");
  const [draftStatus, setDraftStatus] = useState<string>("OPEN");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/contradictions`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { contradictions: Contradiction[] };
      setItems(data.contradictions ?? []);
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
      const r = await fetch(`/api/cases/${caseId}/contradictions`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { contradictions: Contradiction[] };
      setItems(data.contradictions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  // ---------------------------------------------------------------------
  // PATCH — §16: resolution note + status change (OPEN → EXPLAINED → RESOLVED).
  // Never delete original conflicting sources.
  // ---------------------------------------------------------------------

  async function saveResolution(c: Contradiction) {
    setSaving(true);
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/contradictions/${c.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: draftStatus,
            resolutionNote: draftNote.trim() || null,
          }),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (հակասության լուծում)");
        return;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      setItems((prev) =>
        prev.map((p) =>
          p.id === c.id
            ? {
                ...p,
                status: draftStatus,
                resolutionNote: draftNote.trim() || null,
              }
            : p,
        ),
      );
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {items.length} հակասություն
          <span className="ml-2 text-[11px] text-neutral-500 dark:text-neutral-500">
            · {items.filter((c) => c.status === "OPEN").length} բաց ·{" "}
            {items.filter((c) => c.status === "EXPLAINED").length} բացատրված ·{" "}
            {items.filter((c) => c.status === "RESOLVED").length} լուծված
          </span>
        </p>
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
            let a: { proposition?: string; source?: { documentId?: string; page?: number } } = {};
            let b: { proposition?: string; source?: { documentId?: string; page?: number } } = {};
            try {
              a = JSON.parse(c.claimA);
            } catch {
              /* */
            }
            try {
              b = JSON.parse(c.claimB);
            } catch {
              /* */
            }
            const isEditing = editingId === c.id;
            return (
              <div
                key={c.id}
                className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-2">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      {c.contradictionType}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        c.significance === "HIGH"
                          ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                          : c.significance === "MEDIUM"
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                      }`}
                    >
                      {c.significance}
                    </span>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-md bg-emerald-50 p-2 text-xs dark:bg-emerald-950/20">
                    <div className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">A</div>
                    <div className="text-neutral-800 dark:text-neutral-200">{a.proposition ?? c.claimA}</div>
                    {a.source && (
                      <div className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-500">
                        աղբյուր՝ {a.source.documentId?.slice(0, 12) ?? "—"}…
                        {a.source.page !== undefined && ` · էջ ${a.source.page}`}
                      </div>
                    )}
                  </div>
                  <div className="rounded-md bg-red-50 p-2 text-xs dark:bg-red-950/20">
                    <div className="text-[10px] font-medium text-red-700 dark:text-red-400">B</div>
                    <div className="text-neutral-800 dark:text-neutral-200">{b.proposition ?? c.claimB}</div>
                    {b.source && (
                      <div className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-500">
                        աղբյուր՝ {b.source.documentId?.slice(0, 12) ?? "—"}…
                        {b.source.page !== undefined && ` · էջ ${b.source.page}`}
                      </div>
                    )}
                  </div>
                </div>
                {c.reason && (
                  <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <strong>Պատճառ՝</strong> {c.reason}
                  </p>
                )}

                {/* Existing resolution note (read-only when not editing) */}
                {c.resolutionNote && !isEditing && (
                  <p className="mt-2 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300">
                    <strong>Լուծման նշում՝</strong> {c.resolutionNote}
                  </p>
                )}

                {isEditing ? (
                  <div className="mt-3 space-y-2 rounded-md border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900/60">
                    <label className="block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
                      Կարգավիճակ
                    </label>
                    <select
                      value={draftStatus}
                      onChange={(e) => setDraftStatus(e.target.value)}
                      className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    <label className="block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
                      Լուծման նշում
                    </label>
                    <textarea
                      value={draftNote}
                      onChange={(e) => setDraftNote(e.target.value)}
                      placeholder="Նկարագրեք լուծումը, բացատրությունը կամ որոշումը..."
                      className="h-20 w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void saveResolution(c)}
                        disabled={saving}
                        className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Պահպանել
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
                      >
                        Չեղարկել
                      </button>
                    </div>
                    <p className="text-[10px] text-neutral-500 dark:text-neutral-500">
                      §16 — բնօրինակ աղբյուրները (A/B կողմերը) երբեք չեն ջնջվում։
                      Միայն կարգավիճակն ու լուծման նշումն են փոփոխվում։
                    </p>
                  </div>
                ) : (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(c.id);
                        setDraftStatus(c.status);
                        setDraftNote(c.resolutionNote ?? "");
                      }}
                      className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      <Save className="h-3 w-3" />
                      Խմբագրել լուծումը
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    OPEN: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    EXPLAINED: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
      {status}
    </span>
  );
}
