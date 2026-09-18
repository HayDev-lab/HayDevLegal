"use client";

// src/components/legal/PrecedentApplicability.tsx
// Phase 4 §57-§60 — expandable "Ինչու է այս նախադեպը համապատասխան"
// section on a precedent card. Shows STRUCTURED legal analysis:
// matched issue / matched rule / similar facts / material differences /
// later authorities / verified relations. Never internal chain-of-thought.

import { useState } from "react";
import { ChevronRight, Scale, GitBranch, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResearchReport, ApplicabilityResult } from "@/lib/legal-research/types";

const CONCLUSION_LABELS: Record<ApplicabilityResult["conclusion"], string> = {
  DIRECTLY_RELEVANT: "Ուղղակիորեն առնչվող",
  RELEVANT_WITH_DISTINCTIONS: "Առնչվող՝ էական տարբերություններով",
  ANALOGICAL_ONLY: "Միայն անալոգիայի մակարդակում",
  NOT_MATERIALLY_APPLICABLE: "Նյութապես ոչ կիրառելի",
  ANALYSIS_UNAVAILABLE: "Վերլուծությունն անհասանելի է",
};

const CONCLUSION_TONES: Record<ApplicabilityResult["conclusion"], string> = {
  DIRECTLY_RELEVANT:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  RELEVANT_WITH_DISTINCTIONS:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  ANALOGICAL_ONLY:
    "border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400",
  NOT_MATERIALLY_APPLICABLE:
    "border-red-200 bg-red-50 text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  ANALYSIS_UNAVAILABLE:
    "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-500",
};

const SIGNIFICANCE_TONES: Record<string, string> = {
  MAJOR: "text-red-600 dark:text-red-400",
  MODERATE: "text-amber-600 dark:text-amber-400",
  MINOR: "text-neutral-500 dark:text-neutral-400",
};

const SIGNIFICANCE_LABELS: Record<string, string> = {
  MAJOR: "էական",
  MODERATE: "միջին",
  MINOR: "երկրորդական",
};

const RELATION_LABELS: Record<string, string> = {
  CITES: "Մեջբերում է",
  FOLLOWS: "Հետևում է",
  APPLIES: "Կիրառել է",
  DISTINGUISHES: "Տարբերակել է",
  LIMITS: "Սահմանափակել է",
  DEVELOPS: "Զարգացրել է",
  CONFLICTS_WITH: "Հակասում է",
  REFERENCES: "Հղում է կատարել",
};

function dimRow(label: string, value: string) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{label}</span>
      <span className="text-right text-xs font-medium text-neutral-800 dark:text-neutral-200">
        {value}
      </span>
    </div>
  );
}

export function PrecedentApplicability({
  evidenceId,
  research,
}: {
  evidenceId: string;
  research: ResearchReport;
}) {
  const [open, setOpen] = useState(false);

  const apps = research.applicability.filter((a) => a.precedentId === evidenceId);
  if (apps.length === 0) return null;

  const primary = apps[0];
  const holdings = research.holdings.filter((h) => h.documentId === evidenceId);
  const relations = research.relations.filter((r) => r.fromId === evidenceId || r.toId === evidenceId);
  const temporal = research.temporal.find((t) => t.evidenceId === evidenceId);
  const role = research.roles.find((r) => r.evidenceId === evidenceId);

  if (primary.metadataOnly && primary.conclusion === "ANALYSIS_UNAVAILABLE" && holdings.length === 0) {
    return null; // metadata-only card keeps its existing Phase 3 look
  }

  return (
    <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-800/30">
      {/* Header — applicability conclusion chip (§59) */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Scale className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          Ինչու՞ է այս նախադեպը {primary.conclusion === "NOT_MATERIALLY_APPLICABLE" ? "չկիրառվել" : "համապատասխան"}
        </span>
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold",
            CONCLUSION_TONES[primary.conclusion],
          )}
        >
          {CONCLUSION_LABELS[primary.conclusion]}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-neutral-200/70 px-3 py-2.5 dark:border-neutral-700/60">
          {/* Structured dimensions (§57) */}
          <div className="divide-y divide-neutral-200/60 dark:divide-neutral-700/50">
            {dimRow("Իրավական հարցի համընկնում", issueMatchLabel(primary.legalIssueMatch))}
            {dimRow("Նորմ", ruleMatchLabel(primary.ruleMatch))}
            {dimRow("Փաստական նմանություն", similarityLabel(primary.factualSimilarity))}
            {dimRow("Դատավարական դիրք", postureLabel(primary.proceduralPostureMatch))}
            {dimRow("Ժամանակային կիրառելիություն", temporalLabel(primary.temporalCompatibility))}
            {role && dimRow("Դեր հետազոտության մեջ", roleLabel(role.role))}
          </div>

          {/* Verified holding (§59) */}
          {holdings.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                Դատարանի ստուգված դիրք
              </p>
              {holdings.slice(0, 2).map((h) => (
                <div
                  key={h.id}
                  className="mb-1.5 rounded-md border border-neutral-200 bg-white p-2 text-xs leading-relaxed text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                >
                  <span className="font-medium">{h.issue}՝ </span>
                  {h.rule}
                  {h.supportingPassages[0] && (
                    <p className="mt-1 border-l-2 border-neutral-300 pl-2 text-[11px] italic text-neutral-500 dark:border-neutral-600 dark:text-neutral-400">
                      «{h.supportingPassages[0].quote.slice(0, 220)}»
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Supporting similarities (§28) */}
          {primary.supportingFactors.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" aria-hidden /> Աջակցող նմանություններ
              </p>
              <ul className="space-y-0.5">
                {primary.supportingFactors.slice(0, 4).map((s, i) => (
                  <li key={i} className="text-xs text-neutral-600 dark:text-neutral-400">
                    • {s.dimension}. {s.whyItMatters}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Distinguishing factors (§57) */}
          {primary.distinguishingFactors.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" aria-hidden /> Տարբերակիչ գործոններ
              </p>
              <ul className="space-y-1">
                {primary.distinguishingFactors.slice(0, 5).map((d, i) => (
                  <li key={i} className="text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                    <span className={cn("font-semibold", SIGNIFICANCE_TONES[d.significance])}>
                      [{SIGNIFICANCE_LABELS[d.significance]}]
                    </span>{" "}
                    {d.dimension}. Ձեր դեպքում՝ {d.userCase}; նախադեպում՝ {d.precedentCase}. {d.whyItMayMatter}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Verified relations (§60) */}
          {relations.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                <GitBranch className="h-3 w-3" aria-hidden /> Կապեր այլ աղբյուրների հետ
              </p>
              <div className="flex flex-wrap gap-1.5">
                {relations.slice(0, 4).map((r, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                    title={r.evidence.quote.slice(0, 200)}
                  >
                    {RELATION_LABELS[r.kind] ?? r.kind} → {r.fromId === evidenceId ? r.toId : r.fromId}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Later authorities (§57) */}
          {temporal && temporal.laterAuthorities.length > 0 && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              ⏰ Գոյություն ունի ավելի ուշ իրավական ակտ նույն նորմի վերաբերյալ՝{" "}
              {temporal.laterAuthorities.join(", ")}։ Ստուգեք հետագա պրակտիկան։
            </p>
          )}

          {temporal?.notes.map((n, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function issueMatchLabel(v: string): string {
  return v === "STRONG" ? "ուժեղ" : v === "PARTIAL" ? "մասնակի" : "թույլ";
}
function ruleMatchLabel(v: string): string {
  switch (v) {
    case "SAME_RULE":
      return "նույն նորմը";
    case "RELATED_RULE":
      return "առնչվող նորմ";
    case "DIFFERENT_RULE":
      return "այլ նորմ";
    default:
      return "անհայտ";
  }
}
function similarityLabel(v: string): string {
  return v === "HIGH" ? "բարձր" : v === "MEDIUM" ? "միջին" : v === "LOW" ? "ցածր" : "գնահատված չէ";
}
function postureLabel(v: string): string {
  return v === "SAME" ? "նույնը" : v === "COMPARABLE" ? "համեմատելի" : v === "DIFFERENT" ? "տարբեր" : "անհայտ";
}
function temporalLabel(v: string): string {
  switch (v) {
    case "COMPATIBLE":
      return "համատեղելի";
    case "POTENTIALLY_STALE":
      return "հնարավոր ժամկետանց";
    case "INCOMPATIBLE":
      return "անհամատեղելի";
    default:
      return "անհայտ";
  }
}
function roleLabel(v: string): string {
  switch (v) {
    case "GOVERNING_RULE":
      return "կարգավորող նորմ";
    case "INTERPRETIVE_PRECEDENT":
      return "մեկնաբանական նախադեպ";
    case "FACTUALLY_SIMILAR_PRECEDENT":
      return "փաստային նմանությամբ նախադեպ";
    case "CONSTITUTIONAL_STANDARD":
      return "սահմանադրական չափանիշ";
    case "ECHR_STANDARD":
      return "ՄԻԵՎԴ-ի չափանիշ";
    case "COUNTER_AUTHORITY":
      return "հակառակ դիրք";
    case "SECONDARY_CONTEXT":
      return "երկրորդային համատեքստ";
    default:
      return "այլ";
  }
}
