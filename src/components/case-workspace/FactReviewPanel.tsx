"use client";

import { useState } from "react";
import {
  Check,
  X,
  AlertTriangle,
  RotateCcw,
  Loader2,
  History,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewStatus =
  | "UNREVIEWED"
  | "CONFIRMED"
  | "EDITED"
  | "REJECTED"
  | "USER_CONFIRMED";

export type FactStatus =
  | "VERIFIED"
  | "ALLEGED"
  | "DISPUTED"
  | "CONTRADICTED"
  | "UNKNOWN";

export type Materiality = "HIGH" | "MEDIUM" | "LOW";

export interface FactForReview {
  id: string;
  /** Current proposition (the live, editable text). */
  proposition: string;
  /** Original AI-extracted proposition (immutable; preserved server-side). */
  originalProposition?: string | null;
  category: string;
  status: FactStatus;
  materiality: Materiality;
  source: string;
  createdBy: string;
  reviewStatus: ReviewStatus;
  previousProposition?: string | null;
}

interface Props {
  caseId: string;
  fact: FactForReview;
  /** Called after any review action — parent refreshes the matrix. */
  onChanged: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FactReviewPanel({ caseId, fact, onChanged, onClose }: Props) {
  const [proposition, setProposition] = useState(fact.proposition);
  const [materiality, setMateriality] = useState<Materiality>(fact.materiality);
  const [category, setCategory] = useState(fact.category || "OTHER");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [originalEdited, setOriginalEdited] = useState(false);

  // Track whether the user edited the proposition text — drives the
  // EDITED vs CONFIRMED distinction (§13).
  const isEdited = originalEdited && proposition !== fact.proposition;

  // ---------------------------------------------------------------------
  // PATCH helper
  // ---------------------------------------------------------------------

  async function patchFact(payload: {
    proposition?: string;
    reviewStatus?: ReviewStatus;
    status?: FactStatus;
    materiality?: Materiality;
    category?: string;
  }): Promise<boolean> {
    setSubmitting(true);
    setError(undefined);
    try {
      const r = await fetch(
        `/api/cases/${caseId}/facts/${fact.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (r.status === 404) {
        setError("Այս գործառնությունը դեռ հասանելի չէ (փաստի խմբագրում)");
        return false;
      }
      if (!r.ok) {
        const err = (await r.json()) as { error?: string; detail?: string };
        throw new Error(err.error ?? err.detail ?? `HTTP ${r.status}`);
      }
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------
  // Action handlers — §13 review workflow
  // ---------------------------------------------------------------------

  async function handleConfirm() {
    const ok = await patchFact({
      proposition,
      materiality,
      category,
      // §13 — CONFIRMED ≠ VERIFIED. Manual confirmation by a human is
      // distinct from documentary verification (status remains ALLEGED
      // unless evidence upgrades it).
      reviewStatus: "CONFIRMED",
    });
    if (ok) onClose();
  }

  async function handleDispute() {
    // §13 — Dispute = USER_CONFIRMED + status = DISPUTED
    const ok = await patchFact({
      proposition,
      materiality,
      category,
      reviewStatus: "USER_CONFIRMED",
      status: "DISPUTED",
    });
    if (ok) onClose();
  }

  async function handleReject() {
    const ok = await patchFact({
      reviewStatus: "REJECTED",
    });
    if (ok) onClose();
  }

  async function handleSaveEdit() {
    const ok = await patchFact({
      proposition,
      materiality,
      category,
      // §13 — Edited proposition → reviewStatus = EDITED (audit trail).
      // The server preserves originalProposition.
      reviewStatus: "EDITED",
    });
    if (ok) onClose();
  }

  async function handleResetReview() {
    const ok = await patchFact({
      reviewStatus: "UNREVIEWED",
      status: fact.status, // keep status as-is
    });
    if (ok) onClose();
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ReviewBadge status={fact.reviewStatus} />
          <CreatedByBadge createdBy={fact.createdBy} />
          {fact.previousProposition && (
            <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400">
              <History className="h-3 w-3" /> նախկին տարբերակ պահպանված
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label="Փակել"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Original proposition (immutable — read-only display) */}
      {fact.originalProposition &&
        fact.originalProposition !== fact.proposition && (
          <div className="rounded-md bg-neutral-50 p-2 text-xs text-neutral-500 dark:bg-neutral-800/40 dark:text-neutral-400">
            <div className="text-[10px] font-medium uppercase text-neutral-400">
              Բնօրինակ տարբերակ (սերվերային անփոփոխ)
            </div>
            <p className="mt-1 italic">{fact.originalProposition}</p>
          </div>
        )}

      {/* Editable proposition */}
      <div>
        <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Փաստի ձևակերպում (ընթացիկ)
        </label>
        <textarea
          value={proposition}
          onChange={(e) => {
            setProposition(e.target.value);
            setOriginalEdited(true);
          }}
          className="h-20 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
        />
        {isEdited && (
          <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-400">
            ✓ Փոփոխված է — բնօրինակը պահպանվում է սերվերում
          </p>
        )}
      </div>

      {/* Category + Materiality */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Կատեգորիա
          </label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Կարևորություն
          </label>
          <select
            value={materiality}
            onChange={(e) => setMateriality(e.target.value as Materiality)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <option value="HIGH">ԲԱՐՁՐ</option>
            <option value="MEDIUM">ՄԻՋԵՎԱՅՐԱԿԱՆ</option>
            <option value="LOW">ՑԱԾՐ</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
          {error}
        </p>
      )}

      {/* Action buttons — §13 workflow */}
      <div className="flex flex-wrap gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-700">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting || !proposition.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Հաստատել
        </button>
        <button
          type="button"
          onClick={handleSaveEdit}
          disabled={submitting || !proposition.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Պահպանել խմբագրումը
        </button>
        <button
          type="button"
          onClick={handleDispute}
          disabled={submitting}
          className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Վիճարկել (DISPUTED)
        </button>
        <button
          type="button"
          onClick={handleReject}
          disabled={submitting}
          className="inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Մերժել
        </button>
        <button
          type="button"
          onClick={handleResetReview}
          disabled={submitting}
          className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Մաքրել review-ը
        </button>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-500">
        Հաստատումը (CONFIRMED) փաստը VERIFIED չի դարձնում — վավերացումը պահանջում է
        ապացույց։ Մերժված փաստերը թաքցվում են վերլուծության փաթեթներից։
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const map: Record<ReviewStatus, { text: string; cls: string }> = {
    UNREVIEWED: {
      text: "Չստուգված",
      cls: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    },
    CONFIRMED: {
      text: "Հաստատված",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    },
    EDITED: {
      text: "Խմբագրված",
      cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    },
    REJECTED: {
      text: "Մերժված",
      cls: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    },
    USER_CONFIRMED: {
      text: "Օգտատիրական հաստատում",
      cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    },
  };
  const { text, cls } = map[status] ?? map.UNREVIEWED;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {text}
    </span>
  );
}

export function CreatedByBadge({ createdBy }: { createdBy: string }) {
  const isUser = createdBy === "USER";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
        isUser
          ? "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300"
          : "bg-teal-100 text-teal-800 dark:bg-teal-950/40 dark:text-teal-300"
      }`}
    >
      {isUser ? "Մուտքագրված" : "AI-ի կողմից"}
    </span>
  );
}
