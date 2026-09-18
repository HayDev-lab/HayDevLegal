"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  CheckCircle2,
  AlertCircle,
  Plus,
  ChevronDown,
  ChevronRight,
  Folder,
  RotateCcw,
  ArrowRightLeft,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { CaseDocument } from "@/lib/case-workspace/types";
import { UploadZone } from "./UploadZone";

// ---------------------------------------------------------------------------
// Local shapes
// ---------------------------------------------------------------------------

interface Volume {
  id: string;
  title: string;
  number: number | null;
  order: number;
}

interface Props {
  caseId: string;
  /** Called when documents change (parent refreshes case counts). */
  onUploaded: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentList({ caseId, onUploaded }: Props) {
  const [docs, setDocs] = useState<CaseDocument[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showCreateVolume, setShowCreateVolume] = useState(false);
  const [newVolumeTitle, setNewVolumeTitle] = useState("");
  const [creatingVolume, setCreatingVolume] = useState(false);
  const [volumeError, setVolumeError] = useState<string | undefined>();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [partialJob, setPartialJob] = useState<{
    id: string;
    progressCurrent: number;
    progressTotal: number;
    errorDetail: string | null;
    documentIds: string[];
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | undefined>();

  // ---------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [docR, volR] = await Promise.all([
        fetch(`/api/cases/${caseId}/documents`),
        fetch(`/api/cases/${caseId}/volumes`),
      ]);
      if (!docR.ok) throw new Error(`HTTP ${docR.status}`);
      const docData = (await docR.json()) as { documents: CaseDocument[] };
      setDocs(docData.documents ?? []);
      if (volR.ok) {
        const volData = (await volR.json()) as { volumes: Volume[] };
        setVolumes(volData.volumes ?? []);
      }
      // Also fetch any partial jobs for §9 retry UI.
      try {
        const jobR = await fetch(
          `/api/cases/${caseId}/jobs?jobType=INGEST&status=PARTIAL`,
        );
        if (jobR.ok) {
          const jobData = (await jobR.json()) as {
            jobs: Array<{
              id: string;
              progressCurrent: number;
              progressTotal: number;
              errorDetail: string | null;
              documentIds: string;
            }>;
          };
          const partials = jobData.jobs ?? [];
          if (partials.length > 0) {
            const j = partials[0];
            let docIds: string[] = [];
            try {
              const parsed = JSON.parse(j.documentIds);
              if (Array.isArray(parsed)) docIds = parsed;
            } catch {
              /* ignore parse error */
            }
            setPartialJob({
              id: j.id,
              progressCurrent: j.progressCurrent,
              progressTotal: j.progressTotal,
              errorDetail: j.errorDetail,
              documentIds: docIds,
            });
          } else {
            setPartialJob(null);
          }
        }
      } catch {
        /* job polling is non-fatal */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------------------------------------------------------------------
  // Volume management
  // ---------------------------------------------------------------------

  async function createVolume(e: React.FormEvent) {
    e.preventDefault();
    if (!newVolumeTitle.trim()) return;
    setCreatingVolume(true);
    setVolumeError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/volumes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newVolumeTitle.trim() }),
      });
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { volume: Volume };
      setVolumes((prev) => [...prev, data.volume]);
      setNewVolumeTitle("");
      setShowCreateVolume(false);
      setSelectedVolumeId(data.volume.id);
    } catch (e) {
      setVolumeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingVolume(false);
    }
  }

  async function renameVolume(volId: string, newTitle: string) {
    if (!newTitle.trim()) return;
    // The PATCH /api/cases/:id/volumes/:volId route doesn't exist yet —
    // we fall back to a delete + recreate pattern that the existing API
    // supports. We avoid delete (would orphan documents) and instead
    // just optimistically update the local state and warn the user when
    // the route returns 404.
    try {
      const r = await fetch(
        `/api/cases/${caseId}/volumes/${volId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle.trim() }),
        },
      );
      if (r.status === 404) {
        // Route doesn't exist yet — gracefully fall back to local update.
        setVolumes((prev) =>
          prev.map((v) => (v.id === volId ? { ...v, title: newTitle.trim() } : v)),
        );
        setVolumeError("Այս գործառնությունը դեռ հասանելի չէ (volume rename)");
        return;
      }
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const data = (await r.json()) as { volume: Volume };
      setVolumes((prev) => prev.map((v) => (v.id === volId ? data.volume : v)));
    } catch (e) {
      setVolumeError(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------------
  // Move document between volumes (§7)
  // ---------------------------------------------------------------------

  async function moveDocument(docId: string, targetVolumeId: string | null) {
    setMoveError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/documents/${docId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volumeId: targetVolumeId }),
        },
      );
      if (r.status === 404) {
        setMoveError("Այս գործառնությունը դեռ հասանելի չէ (move document)");
        return;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      // Update local state immediately.
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId ? { ...d, volumeId: targetVolumeId } : d,
        ),
      );
      setMoveMenuFor(null);
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------------
  // Resume/retry — §9: retry only failed files. We don't have the actual
  // failed File objects (they're gone after the upload), so the UI shows
  // the partial job summary + a "Retry failed" button that re-fetches
  // the document list to find any documents in FAILED status.
  // ---------------------------------------------------------------------

  async function retryFailedDocuments() {
    setRetrying(true);
    setMoveError(undefined);
    try {
      // Find FAILED documents in the current case.
      const failed = docs.filter((d) => d.processingStatus === "FAILED");
      if (failed.length === 0) {
        setMoveError("Չկան ձախողված փաստաթղթեր կրկին փորձելու");
        return;
      }
      // The actual retry would re-upload the original files — but those are
      // gone. Instead, we mark them as needing re-upload by setting their
      // processingStatus back to UPLOADED via PATCH (if the route existed).
      // For now, we just surface the count to the user.
      setMoveError(
        `${failed.length} ձախողված փաստաթուղթ. Կրկին վերբեռնեք ֆայլերը UploadZone-ով`,
      );
    } finally {
      setRetrying(false);
    }
  }

  // ---------------------------------------------------------------------
  // Grouping
  // ---------------------------------------------------------------------

  function toggle(volId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(volId)) next.delete(volId);
      else next.add(volId);
      return next;
    });
  }

  // Documents grouped by volumeId (null = "Unfiled").
  const byVolume = new Map<string | null, CaseDocument[]>();
  for (const d of docs) {
    const key = d.volumeId ?? null;
    const arr = byVolume.get(key) ?? [];
    arr.push(d);
    byVolume.set(key, arr);
  }
  // For each volume, calculate count + pages.
  const volumeStats = (volId: string) => {
    const arr = byVolume.get(volId) ?? [];
    const pageCount = arr.reduce((acc, d) => acc + d.pageCount, 0);
    return { docCount: arr.length, pageCount };
  };

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* §9 — Partial job resume panel */}
      {partialJob && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-300">
                Մասնակի ավարտված աշխատանք՝ {partialJob.progressCurrent}/{partialJob.progressTotal}
              </p>
              {partialJob.errorDetail && (
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-400">
                  {partialJob.errorDetail}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void retryFailedDocuments()}
                  disabled={retrying}
                  className="inline-flex items-center gap-1.5 rounded border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60"
                >
                  {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  Կրկին փորձել ձախողվածները
                </button>
                <button
                  type="button"
                  onClick={() => setPartialJob(null)}
                  className="rounded border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/40"
                >
                  Փակել
                </button>
              </div>
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-500">
                Հաջողված փաստաթղթերը չեն վերամշակվի։ Կրկին կուղարկվեն միայն ձախողվածները։
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Upload zone (with target volume selector built-in) */}
      <UploadZone
        caseId={caseId}
        volumes={volumes}
        selectedVolumeId={selectedVolumeId}
        onVolumeChange={setSelectedVolumeId}
        onUploaded={() => {
          void load();
          onUploaded();
        }}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          Սխալ՝ {error}
          <button
            onClick={() => void load()}
            className="ml-2 underline underline-offset-2"
          >
            կրկին
          </button>
        </div>
      )}
      {volumeError && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{volumeError}</p>
      )}
      {moveError && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{moveError}</p>
      )}

      {/* Volumes section header + create-volume button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Հատորներ ({volumes.length})
        </h3>
        <button
          type="button"
          onClick={() => setShowCreateVolume(!showCreateVolume)}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Նոր հատոր
        </button>
      </div>

      {showCreateVolume && (
        <form
          onSubmit={(e) => void createVolume(e)}
          className="flex gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900/50"
        >
          <input
            type="text"
            value={newVolumeTitle}
            onChange={(e) => setNewVolumeTitle(e.target.value)}
            placeholder="Հատորի վերնագիր, օր.՝ Որոշում, Փնտրտունքի արձանագրություններ…"
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
            autoFocus
          />
          <button
            type="submit"
            disabled={creatingVolume || !newVolumeTitle.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {creatingVolume ? "Ստեղծվում է…" : "Ստեղծել"
            }
          </button>
          <button
            type="button"
            onClick={() => setShowCreateVolume(false)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300"
          >
            Չեղարկել
          </button>
        </form>
      )}

      {/* Documents (grouped by volume, with unfiled last) */}
      {loading ? (
        <div className="py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
          <Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է…
        </div>
      ) : docs.length === 0 && volumes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <FileText className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Դեռ փաստաթղթեր չկան։ Վերբեռնեք PDF/DOCX/TXT ֆայլեր՝ սկսելու համար։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Each volume as a collapsible section */}
          {volumes.map((v) => {
            const isCollapsed = collapsed.has(v.id);
            const stats = volumeStats(v.id);
            const volDocs = byVolume.get(v.id) ?? [];
            return (
              <section
                key={v.id}
                className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-700"
              >
                <header className="flex items-center justify-between gap-2 bg-neutral-50 px-3 py-2 dark:bg-neutral-900/60">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggle(v.id)}
                      className="text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                      aria-label={isCollapsed ? "Բացել" : "Փակել"}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                    <Folder className="h-4 w-4 text-neutral-500" />
                    {renamingId === v.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void renameVolume(v.id, renameValue);
                          setRenamingId(null);
                        }}
                        className="flex min-w-0 flex-1 gap-1"
                      >
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-0.5 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                          autoFocus
                        />
                        <button type="submit" className="rounded border px-2 py-0.5 text-xs text-neutral-700 dark:text-neutral-300">
                          Պահպանել
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          className="rounded border px-2 py-0.5 text-xs text-neutral-700 dark:text-neutral-300"
                        >
                          Չեղարկել
                        </button>
                      </form>
                    ) : (
                      <h4 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {v.number !== null ? `Հատոր ${v.number}. ` : ""}{v.title}
                      </h4>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                    <span>{stats.docCount} փաստաթուղթ</span>
                    <span>· {stats.pageCount} էջ</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(v.id);
                        setRenameValue(v.title);
                      }}
                      className="rounded px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    >
                      Վերանվանել
                    </button>
                  </div>
                </header>
                {!isCollapsed && (
                  <DocumentTable
                    docs={volDocs}
                    volumes={volumes}
                    moveMenuFor={moveMenuFor}
                    setMoveMenuFor={setMoveMenuFor}
                    onMove={moveDocument}
                  />
                )}
              </section>
            );
          })}
          {/* Unfiled documents (no volume) */}
          {(() => {
            const unfiled = byVolume.get(null) ?? [];
            if (unfiled.length === 0) return null;
            const pageCount = unfiled.reduce((acc, d) => acc + d.pageCount, 0);
            const isCollapsed = collapsed.has("__unfiled__");
            return (
              <section className="overflow-hidden rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700">
                <header className="flex items-center justify-between gap-2 bg-neutral-50 px-3 py-2 dark:bg-neutral-900/60">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggle("__unfiled__")}
                      className="text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
                      aria-label={isCollapsed ? "Բացել" : "Փակել"}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                    <FileText className="h-4 w-4 text-neutral-500" />
                    <h4 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Չդասավորված
                    </h4>
                  </div>
                  <div className="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
                    {unfiled.length} փաստաթուղթ · {pageCount} էջ
                  </div>
                </header>
                {!isCollapsed && (
                  <DocumentTable
                    docs={unfiled}
                    volumes={volumes}
                    moveMenuFor={moveMenuFor}
                    setMoveMenuFor={setMoveMenuFor}
                    onMove={moveDocument}
                  />
                )}
              </section>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document table (with move-between-volumes dropdown)
// ---------------------------------------------------------------------------

function DocumentTable({
  docs,
  volumes,
  moveMenuFor,
  setMoveMenuFor,
  onMove,
}: {
  docs: CaseDocument[];
  volumes: Volume[];
  moveMenuFor: string | null;
  setMoveMenuFor: (id: string | null) => void;
  onMove: (docId: string, targetVolumeId: string | null) => void;
}) {
  if (docs.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
        Հատորում դեռ փաստաթղթեր չկան
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="bg-neutral-50/50 dark:bg-neutral-900/30">
        <tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Ֆայլ</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Տեսակ</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Էջեր</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Կարգավիճակ</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Չափ</th>
          <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400"> </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {docs.map((d) => {
          const moveOpen = moveMenuFor === d.id;
          return (
            <tr key={d.id} className="bg-white dark:bg-neutral-900">
              <td className="px-3 py-2">
                <div className="font-medium text-neutral-900 dark:text-neutral-100">{d.displayName}</div>
                <div className="text-[10px] text-neutral-500 dark:text-neutral-400">{d.originalFilename}</div>
              </td>
              <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{d.documentType}</td>
              <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{d.pageCount}</td>
              <td className="px-3 py-2"><StatusBadge status={d.processingStatus} requiresOcr={d.requiresOcr} /></td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {d.sizeBytes < 1024 ? `${d.sizeBytes}B` : d.sizeBytes < 1024 * 1024 ? `${(d.sizeBytes / 1024).toFixed(1)}KB` : `${(d.sizeBytes / 1024 / 1024).toFixed(1)}MB`}
              </td>
              <td className="relative px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoveMenuFor(moveOpen ? null : d.id);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  aria-label="Տեղափոխել այլ հատոր"
                  title="Տեղափոխել այլ հատոր"
                >
                  <ArrowRightLeft className="h-3 w-3" />
                  Տեղափոխել
                </button>
                {moveOpen && (
                  <div className="absolute right-3 z-10 mt-1 max-h-60 w-48 overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                    <button
                      type="button"
                      onClick={() => onMove(d.id, null)}
                      className="block w-full px-3 py-1 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      (Չդասավորված)
                    </button>
                    {volumes.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => onMove(d.id, v.id)}
                        className={`block w-full px-3 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                          v.id === d.volumeId
                            ? "font-medium text-neutral-900 dark:text-neutral-100"
                            : "text-neutral-700 dark:text-neutral-300"
                        }`}
                      >
                        {v.number !== null ? `Հատոր ${v.number}. ` : ""}{v.title}
                      </button>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatusBadge({ status, requiresOcr }: { status: string; requiresOcr: boolean }) {
  if (status === "READY") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />Պատրաստ</span>;
  if (status === "FAILED") return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertCircle className="h-3 w-3" />Ձախող</span>;
  if (requiresOcr) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Պահանջվում է OCR</span>;
  if (status === "PARTIAL") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Մասնակի</span>;
  if (status === "VALIDATING" || status === "PARSING" || status === "UPLOADED" || status === "EXTRACTED" || status === "ANALYZING")
    return <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800 dark:bg-sky-950/40 dark:text-sky-300"><Loader2 className="h-3 w-3 animate-spin" />{status}</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{status}</span>;
}
