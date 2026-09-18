"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Layers,
  Plus,
  ChevronRight,
  ChevronDown,
  X,
} from "lucide-react";
import {
  FactReviewPanel,
  ReviewBadge,
  CreatedByBadge,
  type FactForReview,
} from "./FactReviewPanel";

// ---------------------------------------------------------------------------
// Types — mirror prisma schema + new §13 review fields
// ---------------------------------------------------------------------------

interface CaseFact {
  id: string;
  proposition: string;
  originalProposition?: string | null;
  previousProposition?: string | null;
  category: string;
  status: string;
  materiality: string;
  supportingEvidence: string; // JSON-serialized EvidenceRef[]
  contradictingEvidence: string; // JSON-serialized EvidenceRef[]
  source: string;
  createdBy?: string;
  reviewStatus?: string;
}

interface Props {
  caseId: string;
}

export function FactMatrix({ caseId }: Props) {
  const [facts, setFacts] = useState<CaseFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  // Filter visibility: hide rejected facts by default (§13).
  const [showRejected, setShowRejected] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { facts: CaseFact[] };
      setFacts(data.facts ?? []);
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
      const r = await fetch(`/api/cases/${caseId}/facts`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  }

  // ---------------------------------------------------------------------
  // Manual fact creation — §13: createdBy = USER, source = USER,
  // status = ALLEGED by default (NEVER VERIFIED — manual facts without
  // evidence must not default to VERIFIED).
  // ---------------------------------------------------------------------

  async function createManualFact(input: {
    proposition: string;
    category: string;
    materiality: string;
  }): Promise<boolean> {
    setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposition: input.proposition,
          category: input.category || "OTHER",
          materiality: input.materiality,
          // §13 — manual facts begin as ALLEGED (never VERIFIED).
          status: "ALLEGED",
          createdBy: "USER",
          source: "USER",
          reviewStatus: "USER_CONFIRMED",
        }),
      });
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (փաստի մուտքագրում)");
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

  // ---------------------------------------------------------------------
  // Filtering: rejected facts hidden by default unless user toggles.
  // ---------------------------------------------------------------------

  const visibleFacts = facts.filter((f) => {
    if (f.reviewStatus === "REJECTED" && !showRejected) return false;
    return true;
  });

  const counts = facts.reduce(
    (acc, f) => {
      const rs = f.reviewStatus ?? "UNREVIEWED";
      acc[rs] = (acc[rs] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

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
          {facts.length} փաստ
          <span className="ml-2 text-[11px] text-neutral-500 dark:text-neutral-500">
            · {counts.UNREVIEWED ?? 0} չստուգված · {counts.CONFIRMED ?? 0} հաստատված · {counts.EDITED ?? 0} խմբագրված · {counts.REJECTED ?? 0} մերժված
          </span>
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowManual(!showManual)}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Ձեռքով փաստ
          </button>
          <button
            onClick={rebuild}
            disabled={building}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {building ? "Կառուցվում է..." : "Կառուցել փաստերի մատրիցան"}
          </button>
        </div>
      </div>

      {/* Filter toggle for rejected facts */}
      {facts.some((f) => f.reviewStatus === "REJECTED") && (
        <label className="inline-flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
            className="h-3 w-3"
          />
          Ցույց տալ մերժվածները ({counts.REJECTED ?? 0})
        </label>
      )}

      {/* Manual fact entry form */}
      {showManual && (
        <ManualFactForm
          onCancel={() => setShowManual(false)}
          onSubmit={async (input) => {
            const ok = await createManualFact(input);
            if (ok) setShowManual(false);
          }}
        />
      )}

      {/* Empty state */}
      {facts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Layers className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Փաստերի մատրիցան դեռ չի կառուցվել։ Վերբեռնեք փաստաթղթեր, ապա սեղմեք «Կառուցել», կամ մուտքագրեք փաստ ձեռքով։
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleFacts.map((f) => {
            const sup = safeParse(f.supportingEvidence).length;
            const con = safeParse(f.contradictingEvidence).length;
            const isReviewing = reviewingId === f.id;
            const isRejected = f.reviewStatus === "REJECTED";
            const isEdited =
              f.reviewStatus === "EDITED" &&
              f.originalProposition !== undefined &&
              f.originalProposition !== null &&
              f.originalProposition !== f.proposition;
            return (
              <div key={f.id}>
                <button
                  type="button"
                  onClick={() => setReviewingId(isReviewing ? null : f.id)}
                  className={`w-full rounded-lg border bg-white p-3 text-left transition hover:border-neutral-400 dark:bg-neutral-900 dark:hover:border-neutral-600 ${
                    isRejected
                      ? "border-red-200 opacity-60 dark:border-red-900/40"
                      : isReviewing
                        ? "border-neutral-400 dark:border-neutral-500"
                        : "border-neutral-200 dark:border-neutral-700"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-neutral-900 dark:text-neutral-100">
                        {f.proposition}
                      </div>
                      {isEdited && (
                        <div className="mt-1 text-[11px] italic text-neutral-500 dark:text-neutral-400">
                          Բնօրինակ՝ {f.originalProposition}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
                        {f.reviewStatus && (
                          <ReviewBadge status={f.reviewStatus as FactForReview["reviewStatus"]} />
                        )}
                        {f.createdBy && <CreatedByBadge createdBy={f.createdBy} />}
                        <StatusBadge status={f.status} />
                        <MaterialityBadge level={f.materiality} />
                        <span className="text-emerald-600 dark:text-emerald-400">+{sup} ապացույց</span>
                        <span className="text-red-600 dark:text-red-400">-{con} հակասություն</span>
                        <span>{f.category}</span>
                      </div>
                    </div>
                    <span className="mt-1 shrink-0 text-neutral-400">
                      {isReviewing ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </span>
                  </div>
                </button>
                {isReviewing && (
                  <div className="mt-2">
                    <FactReviewPanel
                      caseId={caseId}
                      fact={{
                        id: f.id,
                        proposition: f.proposition,
                        originalProposition: f.originalProposition ?? null,
                        previousProposition: f.previousProposition ?? null,
                        category: f.category,
                        status: f.status as FactForReview["status"],
                        materiality: f.materiality as FactForReview["materiality"],
                        source: f.source,
                        createdBy: f.createdBy ?? "USER",
                        reviewStatus: (f.reviewStatus ?? "UNREVIEWED") as FactForReview["reviewStatus"],
                      }}
                      onChanged={() => void load()}
                      onClose={() => setReviewingId(null)}
                    />
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

// ---------------------------------------------------------------------------
// Manual fact entry form
// ---------------------------------------------------------------------------

function ManualFactForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: {
    proposition: string;
    category: string;
    materiality: string;
  }) => void;
}) {
  const [proposition, setProposition] = useState("");
  const [category, setCategory] = useState("OTHER");
  const [materiality, setMateriality] = useState("MEDIUM");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!proposition.trim()) return;
        onSubmit({ proposition: proposition.trim(), category, materiality });
      }}
      className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/20"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Մուտքագրել փաստ ձեռքով
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <textarea
        value={proposition}
        onChange={(e) => setProposition(e.target.value)}
        placeholder="Փաստի ձևակերպում, օր.՝ «Մեղադրյալը 2024-08-15-ին գտնվել է դեպքի վայրում»"
        className="h-20 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        autoFocus
      />
      <div className="grid grid-cols-2 gap-3">
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Կատեգորիա (OTHER)"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        />
        <select
          value={materiality}
          onChange={(e) => setMateriality(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        >
          <option value="HIGH">ԲԱՐՁՐ</option>
          <option value="MEDIUM">ՄԻՋԵՎԱՅՐԱԿԱՆ</option>
          <option value="LOW">ՑԱԾՐ</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!proposition.trim()}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          Ավելացնել որպես ALLEGED
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
        >
          Չեղարկել
        </button>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        §13 — ձեռքով մուտքագրված փաստերը ALLEGED կարգավիճակով են (երբեք VERIFIED չեն
        լինում առանց ապացույցի)։ Փաստը կստանա reviewStatus = USER_CONFIRMED (ձեռքով հաստատված)։
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers + badges
// ---------------------------------------------------------------------------

function safeParse(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    ALLEGED: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    DISPUTED: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    CONTRADICTED: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    UNKNOWN: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.UNKNOWN}`}>
      {status}
    </span>
  );
}

function MaterialityBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    HIGH: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    LOW: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[level] ?? colors.LOW}`}>
      {level}
    </span>
  );
}
