"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, Loader2, Play, ShieldCheck, Download, ChevronRight, ArrowLeft } from "lucide-react";

interface LegalDraft {
  id: string;
  caseId: string;
  documentType: string;
  title: string;
  status: string;
  language: string;
  targetCourtOrAuthority: string | null;
  proceduralStage: string | null;
  goal: string | null;
  requestedRelief: string | null;
  filingDeadline: string | null;
  contextSummary: string;
  plan: string;
  createdAt: string;
  updatedAt: string;
}

const DOC_TYPES = [
  "MOTION", "OBJECTION", "CLAIM", "RESPONSE", "APPEAL", "CASSATION_APPEAL",
  "CONSTITUTIONAL_COMPLAINT", "ECHR_APPLICATION_SUPPORT", "LEGAL_MEMORANDUM",
  "FACTUAL_STATEMENT", "REQUEST_TO_AUTHORITY", "OTHER",
];

export function DraftsView({ caseId }: { caseId: string }) {
  const [drafts, setDrafts] = useState<LegalDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { drafts: LegalDraft[] };
      setDrafts(data.drafts ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  if (activeDraftId) {
    return <DraftDetail caseId={caseId} draftId={activeDraftId} onBack={() => { setActiveDraftId(null); void load(); }} />;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Նախագծեր ({drafts.length})
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          <Plus className="h-4 w-4" />
          Նոր նախագիծ
        </button>
      </div>

      {showCreate && <CreateDraftForm caseId={caseId} onCreated={(id) => { setShowCreate(false); setActiveDraftId(id); }} onCancel={() => setShowCreate(false)} />}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>
      ) : drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <FileText className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Դեռ նախագծեր չկան։ Ստեղծեք նոր իրավական փաստաթուղթ՝ սկսելու համար։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveDraftId(d.id)}
              className="group flex w-full items-center justify-between rounded-xl border border-neutral-200 bg-white p-4 text-left transition hover:border-neutral-400 hover:shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-500"
            >
              <div>
                <h3 className="text-sm font-semibold text-neutral-900 group-hover:text-neutral-700 dark:text-neutral-100 dark:group-hover:text-neutral-300">{d.title}</h3>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{d.documentType}</span>
                  <DraftStatusBadge status={d.status} />
                  <span>{d.language}</span>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-neutral-400" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DraftStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PLANNING: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    DRAFTING: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    VERIFYING: "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300",
    NEEDS_REVIEW: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    EXPORT_READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    ARCHIVED: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.ARCHIVED}`}>{status}</span>;
}

function CreateDraftForm({ caseId, onCreated, onCancel }: { caseId: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("MOTION");
  const [language, setLanguage] = useState("hy");
  const [goal, setGoal] = useState("");
  const [targetCourt, setTargetCourt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), documentType: docType, language, goal: goal.trim() || undefined, targetCourtOrAuthority: targetCourt.trim() || undefined }),
      });
      if (!r.ok) { const err = (await r.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${r.status}`); }
      const data = (await r.json()) as { draft: LegalDraft };
      onCreated(data.draft.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCreating(false); }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900/50">
      <h3 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100">Ստեղծել նոր իրավական փաստաթուղթ</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Վերնագիր *</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="օր.՝ Միջնորդություն ապացույցների բացառման վերաբերյալ" className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Փաստաթղթի տեսակ</label>
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100">
            {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Լեզու</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100">
            <option value="hy">Հայերեն</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Նպատակ (goal)</label>
          <input type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="օր.՝ ապացույցի բացառում" className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">Թիրախ դատարան/մարմին</label>
          <input type="text" value={targetCourt} onChange={(e) => setTargetCourt(e.target.value)} placeholder="օր.՝ Առաջին ատյանի դատարան" className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100" />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={creating || !title.trim()} className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">{creating ? "Ստեղծվում է..." : "Ստեղծել"}</button>
        <button type="button" onClick={onCancel} className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">Չեղարկել</button>
      </div>
    </form>
  );
}

function DraftDetail({ caseId, draftId, onBack }: { caseId: string; draftId: string; onBack: () => void }) {
  const [draft, setDraft] = useState<LegalDraft | null>(null);
  const [sections, setSections] = useState<Array<{ id: string; sectionType: string; title: string; content: string; reviewStatus: string; warnings: string; stale: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [genResult, setGenResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts/${draftId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { draft: LegalDraft; sections: typeof sections };
      setDraft(data.draft); setSections(data.sections ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId, draftId]);

  useEffect(() => { void load(); }, [load]);

  async function handlePlan() {
    setPlanning(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts/${draftId}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (!r.ok) { const err = (await r.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${r.status}`); }
      await load();
      setGenResult("Պլանը կառուցված է");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPlanning(false); }
  }

  async function handleGenerate(mode: "deterministic" | "auto") {
    setGenerating(true); setError(undefined); setGenResult(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts/${draftId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      if (!r.ok) { const err = (await r.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${r.status}`); }
      const data = (await r.json()) as { status: string; provider: string; errorDetail?: string };
      setGenResult(`status=${data.status} provider=${data.provider}${data.errorDetail ? ` (${data.errorDetail})` : ""}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setGenerating(false); }
  }

  async function handleVerify() {
    setVerifying(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/drafts/${draftId}/verify`, { method: "POST" });
      if (!r.ok) { const err = (await r.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${r.status}`); }
      const data = (await r.json()) as { result: { passed: boolean }; draftStatus: string };
      setGenResult(`ստուգում: ${data.result.passed ? "ԱՆցել" : "Խնդիրներ կան"} (կարգավիճակ=${data.draftStatus})`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setVerifying(false); }
  }

  if (loading || !draft) return <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>;

  return (
    <div>
      <button onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
        <ArrowLeft className="h-4 w-4" /> Նախագծերի ցանկ
      </button>

      <header className="mb-6 border-b border-neutral-200 pb-4 dark:border-neutral-800">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{draft.title}</h1>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{draft.documentType}</span>
              <DraftStatusBadge status={draft.status} />
              <span>{draft.language === "hy" ? "Հայերեն" : draft.language === "ru" ? "Русский" : "English"}</span>
              {draft.goal && <span>· Նպատակ՝ {draft.goal}</span>}
            </div>
          </div>
        </div>
      </header>

      {/* §24 — Three-pane drafting workspace (simplified) */}
      <div className="mb-6 flex flex-wrap gap-2">
        <button onClick={handlePlan} disabled={planning} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">
          {planning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} Կառուցել պլանը
        </button>
        <button onClick={() => handleGenerate("deterministic")} disabled={generating} className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Որոշունակ սեկցիաներ
        </button>
        <button onClick={() => handleGenerate("auto")} disabled={generating} className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} AI գեներացիա (Codex)
        </button>
        <button onClick={handleVerify} disabled={verifying} className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/30">
          {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Ստուգել
        </button>
        {(draft.status === "VERIFIED" || draft.status === "EXPORT_READY") && (
          <a href={`/api/cases/${caseId}/drafts/${draftId}/export?format=txt`} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">
            <Download className="h-3.5 w-3.5" /> TXT
          </a>
        )}
        {(draft.status === "VERIFIED" || draft.status === "EXPORT_READY") && (
          <a href={`/api/cases/${caseId}/drafts/${draftId}/export?format=docx`} className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800">
            <Download className="h-3.5 w-3.5" /> DOCX
          </a>
        )}
      </div>

      {genResult && <p className="mb-4 rounded-md bg-neutral-100 p-2 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{genResult}</p>}
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {/* Sections list (center pane — simplified to linear) */}
      {sections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <FileText className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Սեկցիաներ չկան։ Կառուցեք պլանը կամ գեներացրեք սեկցիաները։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sections.map((s) => {
            let content: { text?: string; sourceIds?: string[] } = {};
            try { content = JSON.parse(s.content); } catch { /* */ }
            const warnings: Array<{ type: string; detail: string }> = JSON.parse(s.warnings || "[]");
            return (
              <div key={s.id} className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{s.title}</h3>
                  <div className="flex gap-2">
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">{s.sectionType}</span>
                    <SectionReviewBadge status={s.reviewStatus} />
                    {s.stale && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">STALE</span>}
                  </div>
                </div>
                {content.text && <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">{content.text}</p>}
                {warnings.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {warnings.map((w, i) => (
                      <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400">⚠ {w.type}: {w.detail}</p>
                    ))}
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

function SectionReviewBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    UNREVIEWED: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    AI_DRAFTED: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    NEEDS_SUPPORT: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    USER_EDITED: "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300",
    REJECTED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.UNREVIEWED}`}>{status}</span>;
}
