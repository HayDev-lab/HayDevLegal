"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, FileText, Layers, Calendar, Scale, BookOpen, Gavel, Landmark, Globe } from "lucide-react";

// ---------------------------------------------------------------------------
// §20 — Pack budget (centralised limits from §14 + §19 + §20 of the spec).
// ---------------------------------------------------------------------------

const PACK_BUDGET = {
  maxFacts: 30,
  maxChronologyEvents: 20,
  maxLegislation: 10,
  maxCassationCases: 10,
  maxConCourtCases: 5,
  maxEchrCases: 5,
  maxPassagesPerAuthority: 3,
  maxTotalChars: 50000,
} as const;

// ---------------------------------------------------------------------------
// Pack contents (preview before analysis runs)
// ---------------------------------------------------------------------------

interface PackPreview {
  factsCount: number;
  factsIncluded: number;
  chronologyCount: number;
  chronologyIncluded: number;
  evidenceRefCount: number;
  legislationCount: number;
  cassationCount: number;
  concourtCount: number;
  echrCount: number;
  estimatedTotalChars: number;
  issuesCount: number;
}

interface Props {
  caseId: string;
  open: boolean;
  onClose: () => void;
  onRun?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PackInspector({ caseId, open, onClose, onRun }: Props) {
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    (async () => {
      try {
        // Fetch facts, chronology, evidence, issues in parallel.
        const [fR, cR, eR, iR] = await Promise.all([
          fetch(`/api/cases/${caseId}/facts`),
          fetch(`/api/cases/${caseId}/chronology`),
          fetch(`/api/cases/${caseId}/evidence`),
          fetch(`/api/cases/${caseId}/issues`),
        ]);
        if (!fR.ok || !cR.ok || !eR.ok) {
          throw new Error("Չհաջողվեց բեռնել փաթեթի բաղադրիչները");
        }
        const fdata = (await fR.json()) as { facts: Array<{ status: string; supportingEvidence: string; contradictingEvidence: string }> };
        const cdata = (await cR.json()) as { events: unknown[] };
        const edata = (await eR.json()) as { links: Array<{ evidenceRef: string }> };
        const idata = iR.ok
          ? ((await iR.json()) as {
              issueLinks?: Array<{
                relatedLaw?: string;
                relatedPrecedents?: string;
              }>;
            })
          : { issueLinks: [] };

        // §14 — only VERIFIED + DISPUTED facts go into the pack by default.
        const facts = fdata.facts ?? [];
        const packFacts = facts.filter(
          (f) => f.status === "VERIFIED" || f.status === "DISPUTED",
        );
        // Cap at maxFacts (sorted server-side by materiality in the pack builder).
        const factsIncluded = Math.min(packFacts.length, PACK_BUDGET.maxFacts);

        const chronologyCount = cdata.events?.length ?? 0;
        const chronologyIncluded = Math.min(
          chronologyCount,
          PACK_BUDGET.maxChronologyEvents,
        );

        const evidenceLinks = edata.links ?? [];
        // Total evidence refs in the pack (cap by maxEvidenceItems, not listed
        // explicitly in §20 — the pack builder caps at 30 by default).
        const evidenceRefCount = Math.min(evidenceLinks.length, 30);

        // Count legislation / cassation / concourt / echr refs from issueLinks'
        // relatedLaw + relatedPrecedents JSON.
        let legislationCount = 0;
        let cassationCount = 0;
        let concourtCount = 0;
        let echrCount = 0;
        const issueLinks = idata.issueLinks ?? [];
        for (const il of issueLinks) {
          let law: Array<{ source?: string }> = [];
          let preds: Array<{ source?: string }> = [];
          try {
            const parsed = JSON.parse(il.relatedLaw ?? "[]");
            if (Array.isArray(parsed)) law = parsed;
          } catch {
            /* */
          }
          try {
            const parsed = JSON.parse(il.relatedPrecedents ?? "[]");
            if (Array.isArray(parsed)) preds = parsed;
          } catch {
            /* */
          }
          legislationCount += law.length;
          for (const p of preds) {
            const s = (p.source ?? "").toLowerCase();
            if (s.includes("hudoc") || s.includes("echr")) echrCount += 1;
            else if (s.includes("concourt") || s.includes("constitutional")) concourtCount += 1;
            else if (s.includes("cassation") || s.includes("judiciary") || s.includes("datalex")) cassationCount += 1;
          }
        }
        legislationCount = Math.min(legislationCount, PACK_BUDGET.maxLegislation);
        cassationCount = Math.min(cassationCount, PACK_BUDGET.maxCassationCases);
        concourtCount = Math.min(concourtCount, PACK_BUDGET.maxConCourtCases);
        echrCount = Math.min(echrCount, PACK_BUDGET.maxEchrCases);

        // Estimate total chars (rough — facts ~200 chars each, chronology ~150,
        // evidence refs ~120, legislation ~500 each, precedents ~600 each).
        const estimatedTotalChars =
          factsIncluded * 200 +
          chronologyIncluded * 150 +
          evidenceRefCount * 120 +
          legislationCount * 500 +
          cassationCount * 600 +
          concourtCount * 600 +
          echrCount * 600;

        if (!cancelled) {
          setPreview({
            factsCount: facts.length,
            factsIncluded,
            chronologyCount,
            chronologyIncluded,
            evidenceRefCount,
            legislationCount,
            cassationCount,
            concourtCount,
            echrCount,
            estimatedTotalChars,
            issuesCount: issueLinks.length,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-neutral-700 dark:text-neutral-300" />
            Փաթեթի տեսություն
          </DialogTitle>
          <DialogDescription>
            Ստուգեք վերլուծության փաթեթի բաղադրիչները նախքան Codex-ի գործարկումը։
            Ոչ մի chain-of-thought — միայն քանակներ և չափեր (§19)։
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Կառուցվում է փաթեթի դիտման նախադիտումը…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            {/* Budget progress bars (§20) */}
            <BudgetBar
              icon={<Layers className="h-4 w-4" />}
              label="Փաստեր (VERIFIED + DISPUTED)"
              current={preview.factsIncluded}
              total={preview.factsCount}
              max={PACK_BUDGET.maxFacts}
            />
            <BudgetBar
              icon={<Calendar className="h-4 w-4" />}
              label="Ժամանակագրական իրադարձություններ"
              current={preview.chronologyIncluded}
              total={preview.chronologyCount}
              max={PACK_BUDGET.maxChronologyEvents}
            />
            <BudgetBar
              icon={<Scale className="h-4 w-4" />}
              label="Ապացույցների հղումներ"
              current={preview.evidenceRefCount}
              total={preview.evidenceRefCount}
              max={30}
            />
            <BudgetBar
              icon={<BookOpen className="h-4 w-4" />}
              label="Օրենսդրություն"
              current={preview.legislationCount}
              total={preview.legislationCount}
              max={PACK_BUDGET.maxLegislation}
            />
            <BudgetBar
              icon={<Gavel className="h-4 w-4" />}
              label="Վճռաբեկ դատարանի նախադեպեր"
              current={preview.cassationCount}
              total={preview.cassationCount}
              max={PACK_BUDGET.maxCassationCases}
            />
            <BudgetBar
              icon={<Landmark className="h-4 w-4" />}
              label="Սահմանադրական դատարանի նախադեպեր"
              current={preview.concourtCount}
              total={preview.concourtCount}
              max={PACK_BUDGET.maxConCourtCases}
            />
            <BudgetBar
              icon={<Globe className="h-4 w-4" />}
              label="ՄԻԵԴ-ի (ECHR) նախադեպեր"
              current={preview.echrCount}
              total={preview.echrCount}
              max={PACK_BUDGET.maxEchrCases}
            />

            {/* Estimated total chars vs budget */}
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900/60">
              <div className="flex items-center justify-between">
                <span className="text-neutral-600 dark:text-neutral-400">Մոտավոր ընդհանուր նիշեր</span>
                <span className={`font-mono text-sm font-medium ${
                  preview.estimatedTotalChars > PACK_BUDGET.maxTotalChars
                    ? "text-red-700 dark:text-red-400"
                    : "text-neutral-900 dark:text-neutral-100"
                }`}>
                  {preview.estimatedTotalChars.toLocaleString()} / {PACK_BUDGET.maxTotalChars.toLocaleString()}
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className={`h-full ${preview.estimatedTotalChars > PACK_BUDGET.maxTotalChars ? "bg-red-500" : "bg-emerald-500"}`}
                  style={{
                    width: `${Math.min(100, (preview.estimatedTotalChars / PACK_BUDGET.maxTotalChars) * 100)}%`,
                  }}
                />
              </div>
              {preview.estimatedTotalChars > PACK_BUDGET.maxTotalChars && (
                <p className="mt-2 text-[11px] text-red-700 dark:text-red-400">
                  Փաթեթը գերազանցում է առավելագույն չափը — կրճատվելու է սերվերի կողմից ավտոմատ կերպով (§14, §20)։
                </p>
              )}
            </div>

            {/* §20 budget reminders */}
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-300">
              <strong>§20 սահմանափակումներ՝</strong>{" "}
              maxFacts={PACK_BUDGET.maxFacts} ·{" "}
              maxChronologyEvents={PACK_BUDGET.maxChronologyEvents} ·{" "}
              maxLegislation={PACK_BUDGET.maxLegislation} ·{" "}
              maxCassationCases={PACK_BUDGET.maxCassationCases} ·{" "}
              maxConCourtCases={PACK_BUDGET.maxConCourtCases} ·{" "}
              maxEchrCases={PACK_BUDGET.maxEchrCases} ·{" "}
              maxPassagesPerAuthority={PACK_BUDGET.maxPassagesPerAuthority} ·{" "}
              maxTotalChars={PACK_BUDGET.maxTotalChars.toLocaleString()}
            </div>

            <div className="flex justify-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-700">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300"
              >
                Փակել
              </button>
              {onRun && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onRun();
                  }}
                  className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
                >
                  Գործարկել վերլուծությունը
                </button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// BudgetBar — "3/30 facts" style progress
// ---------------------------------------------------------------------------

function BudgetBar({
  icon,
  label,
  current,
  total,
  max,
}: {
  icon: React.ReactNode;
  label: string;
  current: number;
  total: number;
  max: number;
}) {
  const pct = max === 0 ? 0 : Math.min(100, (current / max) * 100);
  const overBudget = current >= max;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-neutral-700 dark:text-neutral-300">
          {icon}
          <span>{label}</span>
        </div>
        <span className={`font-mono ${overBudget ? "text-amber-700 dark:text-amber-400" : "text-neutral-600 dark:text-neutral-400"}`}>
          {current}/{max}
          {total > current && (
            <span className="ml-1 text-[10px] text-neutral-400">
              (հասանելի {total})
            </span>
          )}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className={`h-full transition-all ${overBudget ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
