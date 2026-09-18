"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  RotateCcw,
  Trash2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueStatus =
  | "QUEUED"
  | "UPLOADING"
  | "VALIDATING"
  | "PARSING"
  | "READY"
  | "DUPLICATE"
  | "FAILED";

export interface QueueItem {
  /** Stable local id (randomUUID at intake time). */
  id: string;
  file: File;
  status: QueueStatus;
  /** Human-readable reason when status === "FAILED" or rejected at intake. */
  error?: string;
  /** True when server flagged the sha256 as already-processed. */
  duplicate: boolean;
  /** Persisted document id once the server returns it. */
  documentId?: string;
  /** Page count from server once READY/DUPLICATE. */
  pageCount?: number;
  /** True when the file was rejected at intake (wrong extension / size). */
  rejected: boolean;
}

interface UploadResponse {
  filename: string;
  documentId: string;
  status: string;
  duplicate: boolean;
  pageCount: number;
  requiresOcr: boolean;
  errorDetail?: string;
}

interface Props {
  caseId: string;
  /** Volumes available in this case (already ordered). */
  volumes: Array<{ id: string; title: string; number: number | null }>;
  /** Currently selected target volume (null = "no volume / unfiled"). */
  selectedVolumeId: string | null;
  /** Called when the user changes the target volume. */
  onVolumeChange: (id: string | null) => void;
  /** Called after a successful upload batch (parent refreshes doc list). */
  onUploaded: () => void;
  /** Set true while polling is in progress (so the parent can show real-time progress §8). */
  onPollingChange?: (polling: boolean) => void;
}

// ---------------------------------------------------------------------------
// Allowed-upload rules (mirror src/lib/case-workspace/config.ts — single
// source of truth lives server-side; this client list is just for early
// rejection BEFORE the wasted POST).
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".doc", ".txt"] as const;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
]);
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function isAllowed(file: File): { ok: boolean; reason?: string } {
  const ext = fileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return {
      ok: false,
      reason: `Չթույլատրված տեսակ (${ext || "без расширения"}). Թույլատրվում են՝ PDF, DOCX, TXT, DOC`,
    };
  }
  // If the browser knows the MIME type, also verify it (defense-in-depth).
  if (file.type && file.type.length > 0 && !ALLOWED_MIME.has(file.type)) {
    return {
      ok: false,
      reason: `Չթույլատրված MIME (${file.type})`,
    };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      reason: `Չափազանց մեծ (${(file.size / 1024 / 1024).toFixed(1)}MB > 50MB)`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UploadZone({
  caseId,
  volumes,
  selectedVolumeId,
  onVolumeChange,
  onUploaded,
  onPollingChange,
}: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [polling, setPolling] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  // Files currently being POSTed (id set) — for retry guard.
  const inFlight = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------
  // Intake (validate + queue)
  // ---------------------------------------------------------------------

  const intake = useCallback((files: FileList | File[]) => {
    const next: QueueItem[] = [];
    for (const file of Array.from(files)) {
      const check = isAllowed(file);
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      next.push({
        id,
        file,
        status: check.ok ? "QUEUED" : "FAILED",
        error: check.ok ? undefined : check.reason,
        duplicate: false,
        rejected: !check.ok,
      });
    }
    if (next.length === 0) return;
    setItems((prev) => [...prev, ...next]);
  }, []);

  // ---------------------------------------------------------------------
  // Upload a single file (called from a queue runner or from retry)
  // ---------------------------------------------------------------------

  const uploadOne = useCallback(
    async (item: QueueItem) => {
      if (inFlight.current.has(item.id)) return;
      inFlight.current.add(item.id);
      // Set UPLOADING.
      setItems((prev) =>
        prev.map((p) => (p.id === item.id ? { ...p, status: "UPLOADING", error: undefined } : p)),
      );
      try {
        const fd = new FormData();
        fd.append("files", item.file);
        if (selectedVolumeId) fd.append("volumeId", selectedVolumeId);
        const r = await fetch(`/api/cases/${caseId}/documents`, {
          method: "POST",
          body: fd,
        });
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try {
            const err = (await r.json()) as { error?: string; detail?: string };
            msg = err.error ?? err.detail ?? msg;
          } catch {
            /* ignore parse error */
          }
          setItems((prev) =>
            prev.map((p) =>
              p.id === item.id ? { ...p, status: "FAILED", error: msg } : p,
            ),
          );
          return;
        }
        const data = (await r.json()) as { results: UploadResponse[] };
        // We sent exactly one file, so results[0] is the match.
        const res = data.results.find((x) => x.filename === item.file.name) ?? data.results[0];
        if (!res) {
          setItems((prev) =>
            prev.map((p) =>
              p.id === item.id ? { ...p, status: "FAILED", error: "Server returned no result" } : p,
            ),
          );
          return;
        }
        // Map server status to queue status.
        // Possible server-side ProcessingStatus values: UPLOADED | VALIDATING |
        // PARSING | EXTRACTED | ANALYZING | READY | PARTIAL | FAILED.
        let nextStatus: QueueStatus;
        if (res.duplicate) nextStatus = "DUPLICATE";
        else if (res.status === "READY") nextStatus = "READY";
        else if (res.status === "PARTIAL") nextStatus = "READY"; // partial parse still usable
        else if (res.status === "FAILED") nextStatus = "FAILED";
        else nextStatus = "READY"; // treat anything non-FAILED as ready for UI purposes
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? {
                  ...p,
                  status: nextStatus,
                  duplicate: res.duplicate,
                  documentId: res.documentId || undefined,
                  pageCount: res.pageCount,
                  error:
                    nextStatus === "FAILED"
                      ? res.errorDetail ?? "Չհաջողվեց մշակել"
                      : undefined,
                }
              : p,
          ),
        );
        onUploaded();
      } catch (e) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, status: "FAILED", error: e instanceof Error ? e.message : String(e) }
              : p,
          ),
        );
      } finally {
        inFlight.current.delete(item.id);
      }
    },
    [caseId, selectedVolumeId, onUploaded],
  );

  // ---------------------------------------------------------------------
  // Queue runner — kick off QUEUED items not yet uploaded, in parallel
  // bounded (3 at once). §7 incremental/resumable: failure of one file
  // never blocks the remaining.
  // ---------------------------------------------------------------------

  useEffect(() => {
    const pending = items.filter((i) => i.status === "QUEUED");
    if (pending.length === 0) return;
    // Cap concurrency to 3 — keeps large batches from saturating the socket.
    const batch = pending.slice(0, 3);
    for (const item of batch) {
      void uploadOne(item);
    }
  }, [items, uploadOne]);

  // ---------------------------------------------------------------------
  // Job polling — §8 real progress. While ANY item is UPLOADING, poll
  // /api/cases/:id/jobs?jobType=INGEST&status=RUNNING every 2s. Stops on
  // terminal state or unmount.
  // ---------------------------------------------------------------------

  useEffect(() => {
    const anyActive = items.some((i) => i.status === "UPLOADING" || i.status === "QUEUED");
    if (!anyActive) {
      if (polling) {
        setPolling(false);
        onPollingChange?.(false);
      }
      return;
    }
    if (polling) return;
    setPolling(true);
    onPollingChange?.(true);
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(
          `/api/cases/${caseId}/jobs?jobType=INGEST&status=RUNNING`,
        );
        if (!r.ok) return;
        const data = (await r.json()) as {
          jobs: Array<{
            id: string;
            status: string;
            progressCurrent: number;
            progressTotal: number;
          }>;
        };
        // The current ingestion pipeline uses ingestDocument (not ingestBatch)
        // so no INGEST job is typically created by the single-file POST path.
        // The poll is harmless when no jobs are RUNNING — it just no-ops.
        // If a background job IS found, the queue display already reflects
        // per-file state; we don't override it here.
        void data;
      } catch {
        /* network errors are non-fatal during polling */
      } finally {
        if (!cancelled) {
          timeout = setTimeout(tick, 2000) as unknown as number;
        }
      }
    };
    let timeout = setTimeout(tick, 2000) as unknown as number;
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      setPolling(false);
      onPollingChange?.(false);
    };
    // The dependency is the boolean "any item is in-flight" — recomputed
    // from the items array on every render. We omit `polling`, `caseId`,
    // and `onPollingChange` from the dependency array deliberately: the
    // boolean expression above is the only signal that should start/stop
    // the polling loop, and we don't want to reset the loop on every
    // state change.
  }, [items.some((i) => i.status === "UPLOADING" || i.status === "QUEUED")]);

  // ---------------------------------------------------------------------
  // Drag handlers
  // ---------------------------------------------------------------------

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    if (e.dataTransfer?.files) intake(e.dataTransfer.files);
  }
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) setDragOver(false);
  }

  // ---------------------------------------------------------------------
  // Retry + clear
  // ---------------------------------------------------------------------

  function retry(item: QueueItem) {
    setItems((prev) =>
      prev.map((p) =>
        p.id === item.id
          ? {
              ...p,
              status: "QUEUED",
              error: undefined,
              rejected: false,
              duplicate: false,
            }
          : p,
      ),
    );
  }
  function clearCompleted() {
    setItems((prev) =>
      prev.filter((i) => !(i.status === "READY" || i.status === "DUPLICATE")),
    );
  }
  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  // ---------------------------------------------------------------------
  // Batch summary
  // ---------------------------------------------------------------------

  const summary = items.reduce(
    (acc, i) => {
      if (i.status === "READY" && !i.duplicate) acc.new += 1;
      else if (i.status === "DUPLICATE" || i.duplicate) acc.dup += 1;
      else if (i.status === "FAILED") acc.failed += 1;
      else acc.active += 1;
      return acc;
    },
    { new: 0, dup: 0, failed: 0, active: 0 },
  );
  const showSummary = items.length > 0 && (summary.new + summary.dup + summary.failed) > 0;
  const completedCount = summary.new + summary.dup + summary.failed;

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {/* Target volume selector */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <span>Թիրակ՝ հատոր՝</span>
        <select
          value={selectedVolumeId ?? ""}
          onChange={(e) => onVolumeChange(e.target.value || null)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          aria-label="Թիրակի հատոր"
        >
          <option value="">(Չդասավորված)</option>
          {volumes.map((v) => (
            <option key={v.id} value={v.id}>
              {v.number !== null ? `Հատոր ${v.number}. ` : ""}{v.title}
            </option>
          ))}
        </select>
      </div>

      {/* Drop area */}
      <div
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={(e) => e.preventDefault()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
            : "border-neutral-300 bg-neutral-50 hover:border-neutral-400 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/50 dark:hover:border-neutral-600 dark:hover:bg-neutral-900"
        }`}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.doc"
          onChange={(e) => {
            if (e.target.files) intake(e.target.files);
            // Reset the input value so the same file can be re-selected.
            e.target.value = "";
          }}
          className="hidden"
          aria-label="Ֆայլ ընտրել"
        />
        <Upload
          className={`h-8 w-8 ${dragOver ? "text-amber-600" : "text-neutral-400"}`}
        />
        <p className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          Քաշեք և գցեք ֆայլերը այստեղ
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          կամ սեղմեք՝ ընտրելու · PDF, DOCX, TXT, DOC · մինչև 50MB մեկ ֆայլ
        </p>
        {polling && (
          <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            ստուգվում են ֆոնային աշխատանքները…
          </p>
        )}
      </div>

      {/* Batch summary */}
      {showSummary && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-neutral-100 px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
          <span>
            <strong>{completedCount}</strong>/{items.length} ավարտված ·{" "}
            <span className="text-emerald-700 dark:text-emerald-400">{summary.new} նոր</span>{" "}
            ·{" "}
            <span className="text-amber-700 dark:text-amber-400">{summary.dup} կրկնօրինակ</span>{" "}
            ·{" "}
            <span className="text-red-700 dark:text-red-400">{summary.failed} ձախող</span>
            {summary.active > 0 && (
              <span className="ml-1 text-neutral-500 dark:text-neutral-500">
                {" "}/ {summary.active} ընթացիկ
              </span>
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={clearCompleted}
              className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-200 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <Trash2 className="h-3 w-3" />
              Մաքրել ավարտվածները
            </button>
          </div>
        </div>
      )}

      {/* Queue list */}
      {items.length > 0 && (
        <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              onRetry={() => retry(item)}
              onRemove={() => removeItem(item.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-queue-row rendering
// ---------------------------------------------------------------------------

function QueueRow({
  item,
  onRetry,
  onRemove,
}: {
  item: QueueItem;
  onRetry: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
      <span className="shrink-0">
        <StatusIcon status={item.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-neutral-800 dark:text-neutral-200">
            {item.file.name}
          </span>
          {item.duplicate && (
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Արդեն մշակված
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
          <span>{(item.file.size / 1024).toFixed(1)}KB</span>
          {item.pageCount !== undefined && item.pageCount > 0 && (
            <span>· {item.pageCount} էջ</span>
          )}
          {item.documentId && (
            <span className="font-mono text-[10px] text-neutral-400">
              · id: {item.documentId.slice(0, 8)}…
            </span>
          )}
          {item.error && (
            <span className="text-red-700 dark:text-red-400">· {item.error}</span>
          )}
        </div>
      </div>
      <span className="shrink-0">
        <StatusLabel status={item.status} />
      </span>
      <div className="flex shrink-0 gap-1">
        {item.status === "FAILED" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            className="inline-flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <RotateCcw className="h-3 w-3" />
            Կրկին
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label="Հեռացնել"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: QueueStatus }) {
  switch (status) {
    case "READY":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
    case "DUPLICATE":
      return <FileText className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
    case "FAILED":
      return <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
    case "UPLOADING":
    case "VALIDATING":
    case "PARSING":
    case "QUEUED":
      return <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />;
    default:
      return <FileText className="h-4 w-4 text-neutral-400" />;
  }
}

function StatusLabel({ status }: { status: QueueStatus }) {
  const map: Record<QueueStatus, { text: string; cls: string }> = {
    QUEUED: { text: "Հերթում", cls: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" },
    UPLOADING: { text: "Վերբեռնվում է", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
    VALIDATING: { text: "Ստուգվում է", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
    PARSING: { text: "Վերլուծվում է", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
    READY: { text: "Պատրաստ", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" },
    DUPLICATE: { text: "Կրկնօրինակ", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
    FAILED: { text: "Ձախող", cls: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300" },
  };
  const { text, cls } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {text}
    </span>
  );
}
