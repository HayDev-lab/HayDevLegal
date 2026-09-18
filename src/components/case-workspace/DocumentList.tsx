"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import type { CaseDocument } from "@/lib/case-workspace/types";

interface Props {
  caseId: string;
  onUploaded: () => void;
}

export function DocumentList({ caseId, onUploaded }: Props) {
  const [docs, setDocs] = useState<CaseDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/documents`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { documents: CaseDocument[] };
      setDocs(data.documents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function handleUpload(files: FileList) {
    if (files.length === 0) return;
    setUploading(true);
    setError(undefined);
    setUploadResult(undefined);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      const r = await fetch(`/api/cases/${caseId}/documents`, { method: "POST", body: fd });
      if (!r.ok) {
        const err = (await r.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { results: Array<{ filename: string; documentId: string; status: string; duplicate: boolean; pageCount: number; requiresOcr: boolean }> };
      const ok = data.results.filter((r) => r.status === "READY").length;
      const dup = data.results.filter((r) => r.duplicate).length;
      const failed = data.results.filter((r) => r.status === "FAILED").length;
      setUploadResult(`${ok} նոր · ${dup} կրկնօրինակ · ${failed} ձախող`);
      void load();
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.doc"
          onChange={(e) => e.target.files && handleUpload(e.target.files)}
          className="hidden"
          id="doc-upload"
        />
        <label
          htmlFor="doc-upload"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading ? "Վերբեռնվում է..." : "Վերբեռնել փաստաթղթեր"}
        </label>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          PDF, DOCX, TXT · մինչև 50MB մեկ ֆայլ
        </p>
      </div>

      {uploadResult && (
        <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-400">{uploadResult}</p>
      )}
      {error && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">Բեռնվում է...</p>
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <FileText className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Դեռ փաստաթղթեր չկան։ Վերբեռնեք PDF/DOCX/TXT ֆայլեր՝ սկսելու համար։
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-700">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900/50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Ֆայլ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Տեսակ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Էջեր</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Կարգավիճակ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Չափ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {docs.map((d) => (
                <tr key={d.id} className="bg-white dark:bg-neutral-900">
                  <td className="px-3 py-2">
                    <div className="font-medium text-neutral-900 dark:text-neutral-100">{d.displayName}</div>
                    <div className="text-[10px] text-neutral-500 dark:text-neutral-400">{d.originalFilename}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{d.documentType}</td>
                  <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{d.pageCount}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={d.processingStatus} requiresOcr={d.requiresOcr} />
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {d.sizeBytes < 1024 ? `${d.sizeBytes}B` : d.sizeBytes < 1024 * 1024 ? `${(d.sizeBytes / 1024).toFixed(1)}KB` : `${(d.sizeBytes / 1024 / 1024).toFixed(1)}MB`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, requiresOcr }: { status: string; requiresOcr: boolean }) {
  if (status === "READY") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />Պատրաստ</span>;
  if (status === "FAILED") return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-800 dark:bg-red-950/40 dark:text-red-300"><AlertCircle className="h-3 w-3" />Ձախող</span>;
  if (requiresOcr) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Պահանջվում է OCR</span>;
  if (status === "PARTIAL") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">Մասնակի</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{status}</span>;
}
