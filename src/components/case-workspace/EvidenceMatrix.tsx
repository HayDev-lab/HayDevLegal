"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Scale,
  Plus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvidenceLink {
  id: string;
  factId: string | null;
  evidenceRef: string; // JSON: { documentId, page?, section?, quote? }
  relation: string; // SUPPORTS | CONTRADICTS | CONTEXT | AUTHENTICATES
  strength: string; // DIRECT | INDIRECT | CONTEXTUAL
}

interface CaseFact {
  id: string;
  proposition: string;
}

interface CaseDocument {
  id: string;
  displayName: string;
  originalFilename: string;
}

const RELATIONS = ["SUPPORTS", "CONTRADICTS", "CONTEXT", "AUTHENTICATES"] as const;
const STRENGTHS = ["DIRECT", "INDIRECT", "CONTEXTUAL"] as const;

interface Props {
  caseId: string;
}

export function EvidenceMatrix({ caseId }: Props) {
  const [links, setLinks] = useState<EvidenceLink[]>([]);
  const [facts, setFacts] = useState<CaseFact[]>([]);
  const [docs, setDocs] = useState<CaseDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [editingLink, setEditingLink] = useState<EvidenceLink | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [eR, fR, dR] = await Promise.all([
        fetch(`/api/cases/${caseId}/evidence`),
        fetch(`/api/cases/${caseId}/facts`),
        fetch(`/api/cases/${caseId}/documents`),
      ]);
      if (!eR.ok) throw new Error(`HTTP ${eR.status}`);
      const data = (await eR.json()) as { links: EvidenceLink[] };
      setLinks(data.links ?? []);
      if (fR.ok) {
        const fdata = (await fR.json()) as { facts: CaseFact[] };
        setFacts(
          (fdata.facts ?? []).map((f) => ({
            id: f.id,
            proposition:
              f.proposition.length > 80
                ? f.proposition.slice(0, 80) + "…"
                : f.proposition,
          })),
        );
      }
      if (dR.ok) {
        const ddata = (await dR.json()) as { documents: CaseDocument[] };
        setDocs(
          (ddata.documents ?? []).map((d) => ({
            id: d.id,
            displayName: d.displayName,
            originalFilename: d.originalFilename,
          })),
        );
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

  async function rebuild() {
    setBuilding(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/evidence`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD for evidence links
  // ---------------------------------------------------------------------

  async function createLink(input: {
    factId: string | null;
    documentId: string;
    page?: number;
    quote?: string;
    relation: string;
    strength: string;
  }): Promise<boolean> {
    setError(undefined);
    try {
      const evidenceRef = JSON.stringify({
        documentId: input.documentId,
        ...(input.page !== undefined ? { page: input.page } : {}),
        ...(input.quote ? { quote: input.quote } : {}),
      });
      const r = await fetch(`/api/cases/${caseId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factId: input.factId,
          evidenceRef,
          relation: input.relation,
          strength: input.strength,
        }),
      });
      if (r.status === 404 || r.status === 405) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (ապացույցի կապի ստեղծում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string; detail?: string };
        throw new Error(err.error ?? err.detail ?? `HTTP ${r.status}`);
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function editLink(
    linkId: string,
    input: { relation: string; strength: string },
  ): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/evidence/${linkId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            relation: input.relation,
            strength: input.strength,
          }),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (ապացույցի կապի խմբագրում)");
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

  async function deleteLink(linkId: string): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/evidence/${linkId}`,
        { method: "DELETE" },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (ապացույցի կապի ջնջում)");
        return false;
      }
      if (!r.ok && r.status !== 204) {
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{links.length} կապ</p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setEditingLink(null);
              setShowForm(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Ավելացնել կապ
          </button>
          <button
            onClick={rebuild}
            disabled={building}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {building ? "Կառուցվում է..." : "Կառուցել ապացույցների մատրիցան"}
          </button>
        </div>
      </div>

      {/* Add / edit form */}
      {showForm && (
        <LinkForm
          facts={facts}
          docs={docs}
          editing={editingLink}
          onSubmit={async (input) => {
            if (editingLink) {
              const ok = await editLink(editingLink.id, {
                relation: input.relation,
                strength: input.strength,
              });
              if (ok) {
                setShowForm(false);
                setEditingLink(null);
              }
            } else {
              const ok = await createLink(input);
              if (ok) setShowForm(false);
            }
          }}
          onCancel={() => {
            setShowForm(false);
            setEditingLink(null);
          }}
        />
      )}

      {/* Delete confirmation */}
      {deletingId && (
        <div className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm dark:border-red-900/50 dark:bg-red-950/30">
          <span className="text-red-900 dark:text-red-200">Ջնջե՞լ ապացույցի կապը։</span>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                const ok = await deleteLink(deletingId);
                if (ok) setDeletingId(null);
              }}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Ջնջել
            </button>
            <button
              onClick={() => setDeletingId(null)}
              className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
            >
              Չեղարկել
            </button>
          </div>
        </div>
      )}

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
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Փաստ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Աղբյուր (անփոփոխ)</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Հարաբերություն</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-neutral-600 dark:text-neutral-400">Ուժգնություն</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-neutral-600 dark:text-neutral-400"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {links.map((l) => {
                let ref: { documentId?: string; page?: number; quote?: string } = {};
                try {
                  ref = JSON.parse(l.evidenceRef);
                } catch {
                  /* */
                }
                const fact = facts.find((f) => f.id === l.factId);
                const doc = docs.find((d) => d.id === ref.documentId);
                return (
                  <tr key={l.id} className="bg-white dark:bg-neutral-900">
                    <td className="px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300" title={fact?.proposition}>
                      {fact ? (
                        <span className="line-clamp-2 max-w-xs">{fact.proposition}</span>
                      ) : (
                        <span className="text-neutral-400">-{l.factId?.slice(0, 8) ?? "—"}…</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono text-neutral-700 dark:text-neutral-300">
                        {doc?.displayName ?? ref.documentId?.slice(0, 12) ?? "-"}…
                      </div>
                      {ref.page !== undefined && <div className="text-[10px] text-neutral-500">էջ {ref.page}</div>}
                      {ref.quote && (
                        <div className="mt-0.5 max-w-xs truncate text-[10px] italic text-neutral-500" title={ref.quote}>
                          «{ref.quote}»
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2"><RelationBadge relation={l.relation} /></td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{l.strength}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => {
                            setEditingLink(l);
                            setShowForm(true);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        >
                          <Pencil className="h-3 w-3" /> Խմբագրել
                        </button>
                        <button
                          onClick={() => setDeletingId(l.id)}
                          className="inline-flex items-center gap-1 rounded border border-red-300 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="h-3 w-3" /> Ջնջել
                        </button>
                      </div>
                    </td>
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

// ---------------------------------------------------------------------------
// Link form (add + edit)
// ---------------------------------------------------------------------------

function LinkForm({
  facts,
  docs,
  editing,
  onSubmit,
  onCancel,
}: {
  facts: CaseFact[];
  docs: CaseDocument[];
  editing: EvidenceLink | null;
  onSubmit: (input: {
    factId: string | null;
    documentId: string;
    page?: number;
    quote?: string;
    relation: string;
    strength: string;
  }) => void;
  onCancel: () => void;
}) {
  // When editing, evidenceRef content is immutable — we only allow
  // relation/strength to be changed (§14).
  const editingRef: { documentId?: string; page?: number; quote?: string } = editing
    ? (() => {
        try {
          return JSON.parse(editing.evidenceRef) as typeof editingRef;
        } catch {
          return {};
        }
      })()
    : {};

  const [factId, setFactId] = useState<string>(editing?.factId ?? "");
  const [documentId, setDocumentId] = useState<string>(editingRef.documentId ?? "");
  const [page, setPage] = useState<string>(
    editingRef.page !== undefined ? String(editingRef.page) : "",
  );
  const [quote, setQuote] = useState<string>(editingRef.quote ?? "");
  const [relation, setRelation] = useState<string>(editing?.relation ?? "SUPPORTS");
  const [strength, setStrength] = useState<string>(editing?.strength ?? "DIRECT");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const pageNum = page.trim() ? Number(page) : undefined;
        onSubmit({
          factId: factId || null,
          documentId,
          page: Number.isFinite(pageNum) ? pageNum : undefined,
          quote: quote.trim() || undefined,
          relation,
          strength,
        });
      }}
      className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/20"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {editing ? "Խմբագրել ապացույցի կապը" : "Ավելացնել ապացույցի կապ"}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Fact selector */}
      <div>
        <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
          Կապված փաստ
        </label>
        <select
          value={factId}
          onChange={(e) => setFactId(e.target.value)}
          disabled={!!editing}
          className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:disabled:bg-neutral-900"
        >
          <option value="">(Չկապված փաստի)</option>
          {facts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.proposition}
            </option>
          ))}
        </select>
      </div>
      {/* Source document (immutable when editing) */}
      <div>
        <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
          Աղբյուր փաստաթուղթ {editing && "(անփոփոխ — §14)"}
        </label>
        <select
          value={documentId}
          onChange={(e) => setDocumentId(e.target.value)}
          disabled={!!editing}
          required={!editing}
          className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:disabled:bg-neutral-900"
        >
          <option value="">(ընտրել փաստաթուղթը)</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.displayName} ({d.originalFilename})
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
            Էջ {editing && "(անփոփոխ)"}
          </label>
          <input
            type="number"
            min={1}
            value={page}
            onChange={(e) => setPage(e.target.value)}
            disabled={!!editing}
            placeholder="օր.՝ 5"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:disabled:bg-neutral-900"
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
            Հարաբերություն
          </label>
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {RELATIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
            Ուժգնություն
          </label>
          <select
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {STRENGTHS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
            Մեջբերում {editing && "(անփոփոխ)"}
          </label>
          <input
            type="text"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            disabled={!!editing}
            placeholder="«...»"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:disabled:bg-neutral-900"
          />
        </div>
      </div>
      <p className="text-[10px] text-neutral-500 dark:text-neutral-500">
        §14 — աղբյուրի տեքստը/պրովենենսը անփոփոխ է։ Խմբագրման ժամանակ հնարավոր է
        փոխել միայն հարաբերությունը (relation) և ուժգնությունը (strength)։
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!editing && !documentId}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {editing ? "Պահպանել" : "Ավելացնել"}
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

function RelationBadge({ relation }: { relation: string }) {
  const colors: Record<string, string> = {
    SUPPORTS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    CONTRADICTS: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    CONTEXT: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    AUTHENTICATES: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[relation] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
      {relation}
    </span>
  );
}
