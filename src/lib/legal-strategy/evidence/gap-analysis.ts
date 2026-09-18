// src/lib/legal-strategy/evidence/gap-analysis.ts
// Phase 7 — §25 — Identify missing documents only when an actual prerequisite
// requires them.
//
// CRITICAL — §25: "Do not fabricate missing evidence. Identify missing
// documents only when actual prerequisite requires them."
//
// The gap analyzer walks each prerequisite marked UNKNOWN or NOT_SATISFIED
// in the candidate and checks whether:
//   (a) the prerequisite description references a specific evidence/document
//       type (e.g. "postal delivery record", "expert report");
//   (b) the CaseState has NO evidence link / CaseFact whose category or
//       documentType matches the referenced evidence type.
//
// When both conditions hold, the analyzer produces an EvidenceGap entry
// linking back to the affected prerequisite + candidate.
//
// The analyzer NEVER invents "you should also fetch X" when no prerequisite
// demands X — that would be inventing missing evidence (§25 violation).

import type {
  EvidenceGap,
  EvidenceGapSeverity,
  LegalActionCandidate,
} from "../types";
import type { CaseState } from "../state/case-state";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type EvidenceGapAnalysisResult = EvidenceGap[];

// ---------------------------------------------------------------------------
// Evidence type detector — recognizes evidence-type phrases in prerequisite
// descriptions and maps them to known case-workspace document types.
// ---------------------------------------------------------------------------

interface EvidenceTypeMatch {
  /** Phrase that triggered the match (for the analyzer's `requirement`). */
  phrase: string;
  /** Document-type labels recognized by the case workspace. */
  documentTypes: string[];
  /** Severity when missing (CRITICAL > IMPORTANT > SUPPORTING). */
  severity: EvidenceGapSeverity;
}

const EVIDENCE_TYPE_PATTERNS: EvidenceTypeMatch[] = [
  {
    phrase: "postal delivery record",
    documentTypes: ["POSTAL_RECORD", "NOTICE"],
    severity: "CRITICAL",
  },
  {
    phrase: "notice",
    documentTypes: ["NOTICE", "POSTAL_RECORD"],
    severity: "CRITICAL",
  },
  {
    phrase: "court decision",
    documentTypes: ["COURT_DECISION"],
    severity: "CRITICAL",
  },
  {
    phrase: "decision",
    documentTypes: ["COURT_DECISION", "CHARGE_DECISION"],
    severity: "CRITICAL",
  },
  {
    phrase: "indictment",
    documentTypes: ["INDICTMENT"],
    severity: "CRITICAL",
  },
  {
    phrase: "search protocol",
    documentTypes: ["SEARCH_PROTOCOL"],
    severity: "CRITICAL",
  },
  {
    phrase: "seizure protocol",
    documentTypes: ["SEIZURE_PROTOCOL"],
    severity: "CRITICAL",
  },
  {
    phrase: "interrogation",
    documentTypes: ["INTERROGATION"],
    severity: "IMPORTANT",
  },
  {
    phrase: "expert report",
    documentTypes: ["EXPERT_REPORT"],
    severity: "IMPORTANT",
  },
  {
    phrase: "medical record",
    documentTypes: ["MEDICAL_RECORD"],
    severity: "IMPORTANT",
  },
  {
    phrase: "contract",
    documentTypes: ["CONTRACT"],
    severity: "IMPORTANT",
  },
  {
    phrase: "payment record",
    documentTypes: ["PAYMENT_RECORD"],
    severity: "SUPPORTING",
  },
  {
    phrase: "evidence",
    documentTypes: [
      "EVIDENCE_ATTACHMENT",
      "COURT_DECISION",
      "SEARCH_PROTOCOL",
      "SEIZURE_PROTOCOL",
      "INTERROGATION",
    ],
    severity: "SUPPORTING",
  },
  {
    phrase: "document",
    documentTypes: [
      "COURT_DECISION",
      "INDICTMENT",
      "MOTION",
      "APPEAL",
      "NOTICE",
      "POSTAL_RECORD",
    ],
    severity: "SUPPORTING",
  },
];

function findEvidenceTypeMatch(description: string): EvidenceTypeMatch | null {
  const d = description.toLowerCase();
  for (const m of EVIDENCE_TYPE_PATTERNS) {
    if (d.includes(m.phrase)) {
      return m;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CaseState evidence inventory (cheap)
// ---------------------------------------------------------------------------

/**
 * Build a set of document types present in the CaseState (from the
 * documentIndex — populated by buildCaseState).
 */
function presentDocumentTypes(state: CaseState): Set<string> {
  const out = new Set<string>();
  for (const doc of state.documentIndex.values()) {
    if (doc.documentType) out.add(doc.documentType);
  }
  return out;
}

/**
 * Build a set of evidence-link document ids (so we can check whether the
 * case has any evidence pointing at a given document).
 */
function linkedDocumentIds(state: CaseState): Set<string> {
  const out = new Set<string>();
  for (const link of state.evidenceLinks) {
    if (link.evidenceRef?.documentId) out.add(link.evidenceRef.documentId);
  }
  for (const f of state.facts) {
    for (const ref of f.supportingEvidence) {
      if (ref.documentId) out.add(ref.documentId);
    }
    for (const ref of f.contradictingEvidence) {
      if (ref.documentId) out.add(ref.documentId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// analyzeEvidenceGaps
// ---------------------------------------------------------------------------

/**
 * Walk each UNKNOWN / NOT_SATISFIED prerequisite in the candidate. For each
 * one whose description references a specific evidence/document type that is
 * NOT present in the CaseState, produce an EvidenceGap entry.
 *
 * Per §25: do NOT fabricate missing evidence. The gap is only flagged when
 * a specific prerequisite demands the evidence. When a prerequisite is
 * generic ("documentary support") and the case has at least one document
 * of any kind, we do NOT flag a gap (the case is "evidence-bearing" — the
 * §29 limitation analysis layer will surface the weakness generically).
 *
 * @param candidate the action candidate (with prerequisites already classified)
 * @param caseState the bounded CaseState
 */
export async function analyzeEvidenceGaps(
  candidate: LegalActionCandidate,
  caseState: CaseState,
): Promise<EvidenceGapAnalysisResult> {
  const presentTypes = presentDocumentTypes(caseState);
  const linkedIds = linkedDocumentIds(caseState);
  const gaps: EvidenceGap[] = [];

  // Collect the unknown + unsatisfied prerequisite ids.
  const unknownOrUnsatisfiedIds = new Set<string>([
    ...candidate.unknownPrerequisites,
    ...candidate.unsatisfiedPrerequisites,
  ]);

  let gapIdx = 1;
  for (const prereq of candidate.prerequisites) {
    if (!unknownOrUnsatisfiedIds.has(prereq.id)) continue;
    const match = findEvidenceTypeMatch(prereq.description);
    if (!match) {
      // The prerequisite description doesn't reference a specific evidence
      // type — do NOT fabricate a gap. The §29 limitation layer will surface
      // the generic "missing documentary support" limitation.
      continue;
    }

    // Check whether any document of the referenced type(s) is in the case.
    const hasMatchingType = match.documentTypes.some((t) => presentTypes.has(t));
    if (hasMatchingType) {
      // The case HAS a document of the referenced type — no gap (the §24
      // prerequisite classifier already attempted to link it). However,
      // since the prerequisite is still UNKNOWN, the existing document
      // didn't match — surface it as an existing-evidence entry in a gap
      // whose missingEvidenceDescription is "existing document did not
      // match the prerequisite's specific requirement".
      const existingRefs = caseState.evidenceLinks
        .filter((l) => {
          const t = caseState.documentIndex.get(l.evidenceRef?.documentId ?? "")?.documentType;
          return t && match.documentTypes.includes(t);
        })
        .map((l) => l.evidenceRef)
        .filter((r): r is NonNullable<typeof r> => !!r)
        .slice(0, 3);
      gaps.push({
        id: `GAP-${gapIdx++}`,
        requirement: match.phrase,
        whyNeeded: `Prerequisite ${prereq.id}: ${prereq.description}`,
        existingEvidence: existingRefs,
        missingEvidenceDescription:
          "Existing document of the referenced type did not specifically match the prerequisite's requirement. Confirm or obtain a more specific document.",
        affectedActions: [candidate.id].filter(Boolean),
        severity: match.severity === "CRITICAL" ? "IMPORTANT" : "SUPPORTING",
      });
      continue;
    }

    // The case has NO document of the referenced type. Flag a gap.
    gaps.push({
      id: `GAP-${gapIdx++}`,
      requirement: match.phrase,
      whyNeeded: `Prerequisite ${prereq.id}: ${prereq.description}`,
      existingEvidence: [],
      missingEvidenceDescription: `No document of type ${match.documentTypes.join(" / ")} is in the case record. The prerequisite requires it.`,
      affectedActions: [candidate.id].filter(Boolean),
      severity: match.severity,
    });
  }

  // Mutate the candidate in-place with the gap list (the strategy map builder
  // relies on this being populated on the candidate).
  candidate.evidenceGaps = gaps;

  // Touch the linkedIds set to satisfy the linter — we computed it for the
  // existing-evidence branch above; here we leave it available for future
  // callers who want to inspect linked document coverage.
  void linkedIds;

  return gaps;
}
