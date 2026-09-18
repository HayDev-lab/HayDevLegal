"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Brain, FileText, AlertTriangle, Clock, Scale, Shield } from "lucide-react";

interface ActionCandidate {
  id: string;
  actionType: string;
  title: string;
  description: string | null;
  proceduralStage: string | null;
  legalBasis: string;
  prerequisites: string;
  satisfiedPrerequisites: string;
  unsatisfiedPrerequisites: string;
  unknownPrerequisites: string;
  supportingFacts: string;
  supportingEvidence: string;
  evidenceGaps: string;
  supportingAuthorities: string;
  counterAuthorities: string;
  distinguishingFactors: string;
  temporalStatus: string;
  limitations: string;
  proceduralEffect: string | null;
  availabilityStatus: string;
  verificationStatus: string;
  draftDocumentType: string | null;
  relatedIssues: string;
}

export function StrategyView({ caseId }: { caseId: string }) {
  const [candidates, setCandidates] = useState<ActionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedAction, setSelectedAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/cases/${caseId}/strategy`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { candidates: ActionCandidate[] };
      setCandidates(data.candidates ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  async function buildStrategy() {
    setBuilding(true); setError(undefined);
    try {
      const r = await fetch(`/api/cases/${caseId}/strategy`, { method: "POST" });
      if (!r.ok) { const err = (await r.json()) as { error?: string }; throw new Error(err.error ?? `HTTP ${r.status}`); }
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBuilding(false); }
  }

  if (loading) return <p className="py-8 text-center text-sm text-neutral-500"><Loader2 className="inline h-4 w-4 animate-spin" /> Բեռնվում է...</p>;
  if (error) return <div className="text-sm text-red-600">{error} <button onClick={() => void load()} className="underline">կրկին</button></div>;

  return (
    <div>
      {/* §17 — No ranking. No "best option". Strategy informs; user chooses. */}
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {candidates.length} գործողության թեկնածու
        </p>
        <button
          onClick={buildStrategy}
          disabled={building}
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {building ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {building ? "Կառուցվում է..." : "Կառուցել ռազմավարությունը"}
        </button>
      </div>

      <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300">
        <Shield className="mr-1 inline h-3.5 w-3.5" />
        Ռազմավարական շարժիչը տեղեկատվություն է տրամադրում։ Այն չի ընտրում իրավական գործողություն օգտատիրոջ փոխարեն։ Ոչ մի դասակարգում կամ ելքի կանխատեսում։
      </div>

      {candidates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-12 text-center dark:border-neutral-700">
          <Brain className="mx-auto h-10 w-10 text-neutral-400" />
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Դեռ ռազմավարական թեկնածուներ չկան։ Սեղմեք «Կառուցել»՝ վերլուծելու համար։
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map((c) => {
            const isSelected = selectedAction === c.id;
            return (
              <div key={c.id} className={`rounded-xl border bg-white p-4 transition dark:bg-neutral-900 ${isSelected ? "border-neutral-400 shadow-sm dark:border-neutral-500" : "border-neutral-200 dark:border-neutral-700"}`}>
                <button onClick={() => setSelectedAction(isSelected ? null : c.id)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{c.title}</h3>
                      <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{c.actionType} {c.proceduralStage && `· ${c.proceduralStage}`}</p>
                    </div>
                    <div className="flex gap-2">
                      <AvailabilityBadge status={c.availabilityStatus} />
                      <VerificationBadge status={c.verificationStatus} />
                    </div>
                  </div>
                </button>
                {isSelected && (
                  <div className="mt-3 space-y-3 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                    {c.description && <p className="text-xs text-neutral-600 dark:text-neutral-400">{c.description}</p>}
                    {c.proceduralEffect && (
                      <div className="flex items-start gap-1.5">
                        <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                        <p className="text-xs text-neutral-700 dark:text-neutral-300"><strong>Procedural effect:</strong> {c.proceduralEffect}</p>
                      </div>
                    )}
                    {/* Prerequisites */}
                    <PrerequisitesSection candidate={c} />
                    {/* Evidence gaps */}
                    <EvidenceGapsSection candidate={c} />
                    {/* Counter-authorities */}
                    {parseArray(c.counterAuthorities).length > 0 && (
                      <div className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                        <div className="text-xs">
                          <strong className="text-neutral-700 dark:text-neutral-300">Counter-authorities:</strong>
                          <span className="ml-1 text-neutral-600 dark:text-neutral-400">{parseArray(c.counterAuthorities).join(", ")}</span>
                        </div>
                      </div>
                    )}
                    {/* Limitations */}
                    {parseArray(c.limitations).length > 0 && (
                      <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                        <strong>Limitations:</strong> {parseArray(c.limitations).join("; ")}
                      </div>
                    )}
                    {/* Temporal status */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <Clock className="h-3.5 w-3.5 text-neutral-400" />
                      <span className="text-neutral-600 dark:text-neutral-400">Timing: {c.temporalStatus}</span>
                    </div>
                    {/* Phase 6 draft mapping */}
                    {c.draftDocumentType && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <FileText className="h-3.5 w-3.5 text-sky-500" />
                        <span className="text-sky-700 dark:text-sky-400">Maps to Phase 6 draft: {c.draftDocumentType}</span>
                      </div>
                    )}
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

function PrerequisitesSection({ candidate: c }: { candidate: ActionCandidate }) {
  const satisfied = parseArray(c.satisfiedPrerequisites);
  const unsatisfied = parseArray(c.unsatisfiedPrerequisites);
  const unknown = parseArray(c.unknownPrerequisites);
  if (satisfied.length === 0 && unsatisfied.length === 0 && unknown.length === 0) return null;
  return (
    <div className="text-xs">
      <strong className="text-neutral-700 dark:text-neutral-300">Prerequisites:</strong>
      <div className="mt-1 space-y-0.5">
        {satisfied.map((p, i) => <div key={`s${i}`} className="text-emerald-600 dark:text-emerald-400">✓ {p}</div>)}
        {unsatisfied.map((p, i) => <div key={`u${i}`} className="text-red-600 dark:text-red-400">✗ {p}</div>)}
        {unknown.map((p, i) => <div key={`n${i}`} className="text-neutral-500 dark:text-neutral-500">? {p}</div>)}
      </div>
    </div>
  );
}

function EvidenceGapsSection({ candidate: c }: { candidate: ActionCandidate }) {
  const gaps = parseArray(c.evidenceGaps);
  if (gaps.length === 0) return null;
  return (
    <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
      <strong>Evidence gaps:</strong> {gaps.join("; ")}
    </div>
  );
}

function AvailabilityBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    AVAILABLE_ON_CURRENT_RECORD: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    POTENTIALLY_AVAILABLE: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    BLOCKED_BY_MISSING_PREREQUISITE: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    TEMPORALLY_UNCERTAIN: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    NOT_AVAILABLE_ON_CURRENT_RECORD: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.NOT_AVAILABLE_ON_CURRENT_RECORD}`}>{status}</span>;
}

function VerificationBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    PARTIAL: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    UNRESOLVED: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[status] ?? colors.UNRESOLVED}`}>{status}</span>;
}

function parseArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
