// src/lib/ai-runtime/codex/closed-evidence-prompt.ts
// The closed-evidence system prompt (§40) + buildCasePrompt helper.
//
// §40 mandates that codex case analysis be performed on a CLOSED evidence
// set: the model may NOT introduce cases, articles, quotations, dates, or
// factual assertions that are not present in the supplied pack. If another
// authority is needed, the model must return ADDITIONAL_RESEARCH_NEEDED
// rather than inventing that authority.
//
// `buildCasePrompt` constructs the two-message prompt (system + user) handed
// to the codex CLI. The system message is the closed-evidence directive +
// a JSON-schema description of the required CodexCaseAnalysis output. The
// user message is the serialized CaseAnalysisPack with an explicit header
// and an enumeration of every evidence id, so the model cannot plausibly
// claim it didn't know which ids are permissible.

import type { CaseAnalysisPack } from "./types";
import { allPackEvidence } from "./case-analysis-schema";

// ---------------------------------------------------------------------------
// §40 — Closed-evidence system directive (verbatim from the master prompt).
// ---------------------------------------------------------------------------

export const CLOSED_EVIDENCE_SYSTEM_PROMPT = `You are analyzing a CLOSED LEGAL EVIDENCE SET.

Use ONLY the supplied evidence.

Do not introduce:
- cases that are not present;
- article numbers not present;
- quotations not present;
- dates not present;
- factual assertions not present.

If another authority may be needed, return:
ADDITIONAL_RESEARCH_NEEDED

Do not invent that authority.

Evidence IDs are the ONLY permissible references. Every citation MUST use a supplied evidence ID.`;

// ---------------------------------------------------------------------------
// JSON schema description (human-readable, embedded in the system prompt).
// This is NOT the Zod schema — it is the textual contract the model sees.
// Keep it explicit so the model has no ambiguity about required fields and
// the permissible enum values.
// ---------------------------------------------------------------------------

const CODEX_CASE_ANALYSIS_JSON_CONTRACT = `\
Your output MUST be a single JSON object with EXACTLY this shape (Phase 4.1 Finalization §22):

{
  "issues": [
    {
      "issueId":            "<must match an issue id from the input pack>",
      "governingRules":     [ { "evidenceId": "<id>", "quote": "<verbatim from passages>", "section": "<optional>" } ],
      "applicablePrecedents": [
        {
          "evidenceId":          "<id>",
          "holding":             "<the rule the court extracted, grounded in passages>",
          "supportingEvidence":   [ { "evidenceId": "<id>", "quote": "...", "section": "<optional>" } ],
          "similarities":        [ "..." ],
          "distinguishingFactors":[ "..." ],
          "applicability":       "DIRECT" | "WITH_DISTINCTIONS" | "ANALOGICAL" | "NOT_APPLICABLE"
        }
      ],
      "counterAuthorities": [ { "evidenceId": "<id>", "quote": "...", "section": "<optional>" } ],
      "unresolvedQuestions": [ "..." ]
    }
  ],
  "argumentMap": [
    {
      "proposition":             "<claim advanced by the analysis>",
      "supportingAuthorities":   [ { "evidenceId": "<id>", "quote": "...", "section": "<optional>" } ],
      "counterAuthorities":      [ { "evidenceId": "<id>", "quote": "...", "section": "<optional>" } ],
      "limitations":             [ "..." ]
    }
  ],
  "missingMaterialFacts":     [ "<facts the pack cannot establish>" ],
  "additionalResearchNeeded": [ "<authorities that may be needed — DO NOT invent them>" ],
  "synthesis":                "<one-paragraph synthesis tying the analysis together>"
}

OUTPUT RULES (non-negotiable):
1. Output ONLY the JSON object. No prose, no markdown fences, no commentary.
2. Every "evidenceId" in the output MUST be one of the ids listed in the EVIDENCE PACK below. Unknown ids are forbidden.
3. Every "quote" MUST be a verbatim span copied from the cited evidence's "passages" array. Do not paraphrase, do not translate, do not abbreviate.
4. If an authority is needed but is not in the pack, append a short note to "additionalResearchNeeded" and DO NOT invent a citation.
5. "synthesis" MUST be non-empty. If you cannot synthesize, set synthesis to a single sentence describing why (e.g. "Insufficient closed evidence to synthesize — additional research required.") and list the gaps in "additionalResearchNeeded".
6. "applicability" values are restricted to the four enum strings above. No other values are permitted.
7. Do not introduce cases, article numbers, dates, quotations, or factual assertions that are not present in the EVIDENCE PACK.`;

// ---------------------------------------------------------------------------
// buildCasePrompt — assemble the two messages for the codex CLI.
// ---------------------------------------------------------------------------

export interface CodexPrompt {
  system: string;
  user: string;
}

export function buildCasePrompt(pack: CaseAnalysisPack): CodexPrompt {
  const evidence = allPackEvidence(pack);
  const evidenceIds = evidence.map((e) => e.id);
  const evidenceIdLine =
    evidenceIds.length > 0
      ? evidenceIds.join(", ")
      : "(none — pack is empty; the model MUST return empty arrays and a synthesis explaining the absence of evidence)";

  // Defensive clone before serialization: the caller's pack object must not
  // be mutated by prompt construction. JSON.stringify is non-mutating by
  // construction, but cloning here makes the intent explicit and resilient
  // to future changes that might touch the pack.
  const packClone: CaseAnalysisPack = {
    ...pack,
    userFacts: pack.userFacts.map((f) => ({ ...f })),
    chronology: pack.chronology?.map((c) => ({ ...c })),
    issues: pack.issues.map((i) => ({ ...i, relatedEvidence: [...i.relatedEvidence] })),
    legislation: pack.legislation.map(cloneEvidence),
    cassationCases: pack.cassationCases.map(cloneEvidence),
    constitutionalCases: pack.constitutionalCases.map(cloneEvidence),
    echrCases: pack.echrCases.map(cloneEvidence),
    otherEvidence: pack.otherEvidence.map(cloneEvidence),
    // existingResearch is treated as opaque context — pass through by reference
    // (the research layer's own types guarantee immutability of read reports).
    existingResearch: pack.existingResearch,
  };

  const packJson = JSON.stringify(packClone, null, 2);

  const system = `${CLOSED_EVIDENCE_SYSTEM_PROMPT}

---

OUTPUT CONTRACT

${CODEX_CASE_ANALYSIS_JSON_CONTRACT}

---

REMINDER: The supplied evidence ids below are the ONLY permissible "evidenceId" values in your output. Any other value will cause the entire analysis to be rejected by the verification firewall.`;

  const user = `EVIDENCE PACK:

Permissible evidence ids (the ONLY values you may use in any "evidenceId" field): ${evidenceIdLine}

---

${packJson}

---

Analyze the closed evidence set above. Produce the JSON object described in the system prompt. Every "evidenceId" you emit MUST appear in the permissible list. Every "quote" MUST be copied verbatim from the cited evidence's "passages" array.`;

  return { system, user };
}

function cloneEvidence(e: CaseAnalysisPack["legislation"][number]): CaseAnalysisPack["legislation"][number] {
  return { ...e, passages: [...e.passages] };
}
