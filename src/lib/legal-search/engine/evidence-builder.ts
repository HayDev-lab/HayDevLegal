// src/lib/legal-search/engine/evidence-builder.ts
// Evidence pack construction (spec §20) — v2 (Phase 3 §45-§46).
//
// The answer AI receives ONLY this structured evidence pack — retrieval
// and legal analysis are strictly separated (spec §22).
// Every item now carries:
//   - grade:            PRIMARY_VERIFIED / PRIMARY_METADATA /
//                       SECONDARY_VERIFIED / DISCOVERY_ONLY (§45)
//   - fullTextVerified: original full text retrieved AND identity-verified
//   - metadataVerified: structured metadata came from the source
//   - accessState:      CAPTCHA_REQUIRED etc. for gated documents (§22)

import { STAGES } from "../config";
import { bestPassage } from "./passage-extractor";
import { truncatePassage } from "../security/content-sanitizer";
import { temporalLabel } from "./temporal-validator";
import type { LegalSearchResult, LegalEvidence, EvidenceGrade } from "../types";

/** Official sources per §45 (see AUTHORITY in config for the hierarchy). */
const OFFICIAL_SOURCE_IDS = new Set([
  "arlis",
  "local-laws",
  "constitutional-court",
  "judiciary",
  "datalex",
  "hudoc",
]);

/** Compute the evidence grade (§45). */
export function evidenceGrade(r: LegalSearchResult): EvidenceGrade {
  const official = OFFICIAL_SOURCE_IDS.has(r.sourceId);
  const verified = !!r.fullTextVerified && !!r.fullText;
  if (official && verified) return "PRIMARY_VERIFIED";
  if (official) return "PRIMARY_METADATA";
  if (verified) return "SECONDARY_VERIFIED";
  return "DISCOVERY_ONLY";
}

/**
 * Build the E1..En evidence pack from reranked results.
 * Passages are ranked by relevance; total text stays within the budget.
 */
export function buildEvidencePack(results: LegalSearchResult[]): LegalEvidence[] {
  const pack: LegalEvidence[] = [];
  let budget = STAGES.evidenceTextBudget;

  for (const r of results) {
    if (pack.length >= STAGES.evidencePackSize) break;
    let passage = bestPassage(r);
    if (!passage || passage.length < 40) {
      // No real passage — evidence without verifiable text is weak; skip.
      continue;
    }
    passage = truncatePassage(passage, STAGES.passageMaxChars);
    if (passage.length > budget) {
      passage = truncatePassage(passage, Math.max(400, budget));
    }
    budget -= passage.length;
    if (budget <= 0 && pack.length >= 3) break;

    pack.push({
      id: `E${pack.length + 1}`,
      source: r.sourceId,
      sourceName: r.sourceName,
      sourceType: r.sourceType,
      title: truncatePassage(r.title, 200),
      court: r.court,
      caseNumber: r.caseNumber,
      actNumber: r.actNumber,
      article: r.article,
      date: r.date ?? r.adoptionDate,
      url: r.url,
      passage,
      relevance: r.relevance,
      authority: r.authority,
      temporalStatus: r.temporalStatus,
      statusLabel: r.status ?? temporalLabel(r),
      // Phase 3 §45-§46
      grade: evidenceGrade(r),
      fullTextVerified: !!r.fullTextVerified && !!r.fullText,
      metadataVerified: r.metadataVerified ?? true,
      identityVerified: r.identityVerified ?? (r.fullTextVerified ? true : undefined),
      accessState: r.accessState,
      resolvedVia: r.resolvedVia,
      resolvedViaUrl: r.resolvedViaUrl,
      resolvedViaSource: r.resolvedViaSource,
      documentRef: r.accessState === "CAPTCHA_REQUIRED" && r.externalId ? `${r.sourceId}:${r.externalId}` : undefined,
    });
  }

  return pack;
}

/**
 * Map an evidence pack back to the legacy LegalSource[] shape so the
 * existing UI components keep working during migration.
 */
export function evidenceToLegacySources(
  pack: LegalEvidence[],
): import("@/lib/legal/types").LegalSource[] {
  const labelByType: Record<LegalEvidence["sourceType"], import("@/lib/legal/types").SourceLabel> = {
    legislation: "Օրենսդրություն",
    case_law: "Իրավական ակտ",
    constitutional_court: "Սահմանադրական դատարան",
    cassation: "Վճռաբեկ դատարան",
    echr: "ՄԻԵՎԴ",
    web: "Իրավական ակտ",
    local_laws: "Օրենսդրություն",
  };

  return pack.map((e) => ({
    id: e.id, // E1..En — the UI renders these as citation ids
    source: "ARLIS" as const, // legacy field; real source is in sourceName
    title: e.title,
    canonicalUrl: e.url,
    article: e.article,
    status: e.statusLabel,
    adoptionDate: e.date,
    excerpt: truncatePassage(e.passage, 600),
    fullRetrievedText: e.passage,
    retrievedAt: new Date().toISOString(),
    relevanceScore: e.relevance,
    sourceLabel: labelByType[e.sourceType],
    // Phase 3 fields for the UI (access labels §51, resume flow §64)
    evidenceGrade: e.grade,
    fullTextVerified: e.fullTextVerified,
    metadataVerified: e.metadataVerified,
    accessState: e.accessState,
    resolvedVia: e.resolvedVia,
    documentRef: e.documentRef,
    court: e.court,
    caseNumber: e.caseNumber,
    resolvedViaUrl: e.resolvedViaUrl,
  }));
}
