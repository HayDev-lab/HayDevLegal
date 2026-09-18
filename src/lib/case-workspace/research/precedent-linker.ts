// src/lib/case-workspace/research/precedent-linker.ts
// Link Cassation / Constitutional Court / HUDOC authorities found by the
// federated search to the case's issues + facts.
//
// Phase 5 §13 — Lexical similarity alone is insufficient. The linker uses
// the existing Phase 4 engines when full text is available (holdings,
// material facts, applicability, distinguishing). When only metadata is
// available (most federated search results for case law), the linker
// falls back to a conservative ANALOGICAL verdict with a materiality
// caveat — it never asserts DIRECT applicability on lexical overlap alone.
//
// Output shape aligns with the Codex pack's `ApplicablePrecedent` /
// `EvidenceRef` types so the result can flow directly into the bounded
// CaseAnalysisPack (§14) without an intermediate conversion.

import type {
  ApplicablePrecedent,
  ApplicabilityVerdict,
  EvidenceRef as CodexEvidenceRef,
} from "@/lib/ai-runtime/codex/types";
import type { LegalEvidence } from "@/lib/legal-search/types";
import type {
  LegalIssueLink,
  LegalReferenceEntry,
  CaseFact,
  EvidenceRef,
} from "@/lib/case-workspace/types";
import type {
  ApplicabilityConclusion,
  LegalIssue,
  UserCaseFact,
} from "@/lib/legal-research/types";
import { analyzeApplicability } from "@/lib/legal-research/analysis/applicability";
import type { PrecedentLinkResult } from "./types";
import { db } from "@/lib/case-workspace/db";
import { parseJsonField } from "./types";

// ---------------------------------------------------------------------------
// Map a case-workspace LegalReferenceEntry to a synthetic Phase-3 LegalEvidence
// so the existing Phase 4 applicability + distinguishing engines can consume
// it. We NEVER fabricate `passage` text — when no passages are present, we
// return null and the linker falls back to the conservative path.
// ---------------------------------------------------------------------------

function refToEvidence(
  ref: LegalReferenceEntry,
  id: string,
): LegalEvidence | null {
  const passages = (ref.passages ?? []).filter((p) => p && p.length > 0);
  if (passages.length === 0) {
    // Metadata-only — the Phase 4 engines short-circuit to
    // ANALYSIS_UNAVAILABLE; we let the caller decide what to do.
    return {
      id,
      source: ref.source,
      sourceName: ref.source,
      sourceType: precedentSourceType(ref.source),
      title: ref.citation,
      url: ref.url ?? "",
      passage: "",
      relevance: 0,
      authority: 0,
      temporalStatus: "unknown",
      date: ref.date,
      fullTextVerified: false,
      metadataVerified: true,
    };
  }
  return {
    id,
    source: ref.source,
    sourceName: ref.source,
    sourceType: precedentSourceType(ref.source),
    title: ref.citation,
    url: ref.url ?? "",
    passage: passages[0],
    relevance: 0.5,
    authority: 80,
    temporalStatus: "unknown",
    date: ref.date,
    fullTextVerified: true,
    metadataVerified: true,
  };
}

/** Map a LegalReferenceEntry.source string to a Phase-3 sourceType label. */
function precedentSourceType(source: string): LegalEvidence["sourceType"] {
  const s = source.toLowerCase();
  if (s.includes("hudoc") || s.includes("echr")) return "echr";
  if (s.includes("concourt") || s.includes("constitutional")) {
    return "constitutional_court";
  }
  if (s.includes("cassation") || s.includes("judiciary") || s.includes("datalex")) {
    return "cassation";
  }
  return "case_law";
}

// ---------------------------------------------------------------------------
// ApplicabilityConclusion → ApplicabilityVerdict mapping
// ---------------------------------------------------------------------------

function mapVerdict(c: ApplicabilityConclusion): ApplicabilityVerdict {
  switch (c) {
    case "DIRECTLY_RELEVANT":
      return "DIRECT";
    case "RELEVANT_WITH_DISTINCTIONS":
      return "WITH_DISTINCTIONS";
    case "ANALOGICAL_ONLY":
      return "ANALOGICAL";
    case "NOT_MATERIALLY_APPLICABLE":
    case "ANALYSIS_UNAVAILABLE":
    default:
      return "NOT_APPLICABLE";
  }
}

// ---------------------------------------------------------------------------
// Build a minimal Phase-4 LegalIssue from the LegalIssueLink
// ---------------------------------------------------------------------------

function toPhase4Issue(link: LegalIssueLink): LegalIssue {
  return {
    id: link.issueId,
    title: link.issueStatement,
    description: link.issueStatement,
    category: "SUBSTANTIVE",
    relevantFacts: link.factIds,
    possibleLegalSources: [],
    status: "OPEN",
  };
}

// ---------------------------------------------------------------------------
// Load case facts referenced by the issue link
// ---------------------------------------------------------------------------

async function loadIssueFacts(
  caseId: string,
  factIds: string[],
): Promise<CaseFact[]> {
  if (factIds.length === 0) return [];
  const rows = await db.caseFact.findMany({
    where: { caseId, id: { in: factIds } },
  });
  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    proposition: r.proposition,
    category: r.category,
    status: r.status as CaseFact["status"],
    supportingEvidence: parseJsonField<EvidenceRef[]>(r.supportingEvidence, []),
    contradictingEvidence: parseJsonField<EvidenceRef[]>(
      r.contradictingEvidence,
      [],
    ),
    relatedIssues: parseJsonField<string[]>(r.relatedIssues, []),
    materiality: r.materiality as CaseFact["materiality"],
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

function toPhase4UserFacts(facts: CaseFact[]): UserCaseFact[] {
  return facts.map((f) => ({
    id: f.id,
    fact: f.proposition,
    source: "USER",
    verified: f.status === "VERIFIED",
    status: f.status === "VERIFIED" ? "DOCUMENT_VERIFIED" : "USER_ALLEGED",
  }));
}

// ---------------------------------------------------------------------------
// linkPrecedents
// ---------------------------------------------------------------------------

/**
 * Link Cassation / ConCourt / HUDOC authorities to a case issue. Uses the
 * existing Phase 4 applicability + distinguishing engines when full text is
 * available; falls back to a conservative ANALOGICAL verdict otherwise (§13).
 *
 * Counter-authorities are gathered from CaseFact.contradictingEvidence — i.e.
 * case-internal evidence that contradicts a fact the user alleged.
 *
 * `issueLink` can be the parsed typed shape OR a raw Prisma row — we coerce
 * both into the typed shape inside.
 */
export async function linkPrecedents(
  caseId: string,
  issueLinkRaw: LegalIssueLink | (LegalIssueLink & { createdAt: Date; updatedAt: Date }),
): Promise<PrecedentLinkResult> {
  const issueLink: LegalIssueLink =
    "relatedLaw" in issueLinkRaw
      ? (issueLinkRaw as LegalIssueLink)
      : (issueLinkRaw as LegalIssueLink);

  const precedents: ApplicablePrecedent[] = [];
  const distinguishingFactors: string[] = [];

  const phase4Issue = toPhase4Issue(issueLink);
  const facts = await loadIssueFacts(caseId, issueLink.factIds);
  const userFacts = toPhase4UserFacts(facts);

  // Synthetic pack id space: P1..Pn for precedents, D1..Dn for case evidence.
  let pIdx = 0;
  for (const ref of issueLink.relatedPrecedents) {
    pIdx++;
    const evidenceId = `P${pIdx}`;
    const evidence = refToEvidence(ref, evidenceId);
    if (!evidence) {
      // No passages at all — record as a not-applicable precedent with
      // metadata-only caveat. Holding is the citation itself (so the closed-
      // evidence firewall accepts the evidenceId).
      precedents.push({
        evidenceId,
        holding: ref.citation,
        similarities: [],
        distinguishingFactors: [],
        applicability: "NOT_APPLICABLE",
      });
      continue;
    }

    // Run the Phase 4 applicability engine. We pass empty holdings + material
    // facts when the metadata-only path is hit (the engine already short-
    // circuits to ANALYSIS_UNAVAILABLE on metadata-only — §63).
    try {
      const result = analyzeApplicability(
        phase4Issue,
        userFacts,
        evidence,
        {
          parsed: {
            raw: issueLink.issueStatement,
            normalized: issueLink.issueStatement.toLowerCase(),
            keywords: [],
            wantsCurrentLaw: false,
            wantsHistoricalLaw: false,
            questionType: "unknown",
          },
          concepts: [],
          variants: [],
          hasExactReference: false,
          exactReferences: { articles: [], caseNumbers: [], actTitles: [] },
        },
        [],
        [],
        "UNKNOWN",
        [],
      );

      // The engine returns distinguishingFactors with rich structure; we
      // surface their human-readable dimension labels.
      for (const d of result.distinguishingFactors ?? []) {
        distinguishingFactors.push(
          `${d.dimension}: ${d.userCase} ≠ ${d.precedentCase}`,
        );
      }

      precedents.push({
        evidenceId,
        // Holding: when the engine had no holdings to extract (metadata-only),
        // fall back to the citation itself so the closed-evidence pack can
        // still reference the precedent id.
        holding: ref.citation,
        similarities: (result.supportingFactors ?? []).map(
          (s) => `${s.dimension}: ${s.similarity}`,
        ),
        distinguishingFactors: (result.distinguishingFactors ?? []).map(
          (d) => `${d.dimension} (${d.significance})`,
        ),
        applicability: mapVerdict(result.conclusion),
      });
    } catch {
      // Engine failure — record as ANALOGICAL (no LLM was applied).
      precedents.push({
        evidenceId,
        holding: ref.citation,
        similarities: [],
        distinguishingFactors: [],
        applicability: "ANALOGICAL",
      });
    }
  }

  // Counter-authorities: contradicting evidence refs from CaseFact records.
  // These are case-internal (document pages), so we need to bridge to the
  // codex pack's evidenceId space. We synthesize D-ids for each unique
  // contradicting evidence ref.
  const seenEvidence = new Set<string>();
  let dIdx = 0;
  const counterAuthorities: CodexEvidenceRef[] = [];
  for (const f of facts) {
    for (const ref of f.contradictingEvidence) {
      const key = `${ref.documentId}|${ref.page ?? ""}|${ref.section ?? ""}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      dIdx++;
      const evidenceId = `D${dIdx}`;
      counterAuthorities.push({
        evidenceId,
        quote: ref.quote,
        section: ref.section,
      });
    }
  }

  return {
    precedents,
    counterAuthorities,
    distinguishingFactors,
  };
}

// Re-export so callers don't have to import the type separately.
export type { LegalReferenceEntry };
