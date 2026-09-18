// src/lib/legal-drafting/generation/codex-drafter.ts
// Phase 6 §15 — Codex CLI+ChatGPT PRIMARY AI drafter.
//
// §15 — Codex CLI+ChatGPT is the PRIMARY transport for AI drafting:
//   - Closed evidence (the DraftingContext is the ONLY factual/legal input).
//   - Network / web disabled.
//   - Read-only sandbox.
//   - If AUTH_REQUIRED / RATE_LIMITED → status = BLOCKED_EXTERNAL_QUOTA.
//     No hammering, no silent switch to API billing.
//
// §14 — The AI may NOT introduce new factual / legal sources. It can only
// reorganize, transition, and compare what is in the closed context. The
// closed-evidence system instruction is fixed verbatim per §15.
//
// Implementation note: the existing Phase 4.1 `getAiRuntime().provider("codex-cli")`
// provider is closed-evidence-only and is currently wired to consume a
// CaseAnalysisPack-shaped input (case-analysis-pack.ts). Drafting is a
// different closed-evidence task — we hand the provider a drafting request
// whose JSON body contains the DraftingContext + the DocumentPlan and ask it
// to produce an array of DraftSection. When the provider cannot accept the
// drafting request (because it is configured for case analysis only), or when
// it is AUTH_REQUIRED / RATE_LIMITED, the drafter returns
// BLOCKED_EXTERNAL_QUOTA — the deterministic assemblers in
// `src/lib/legal-drafting/assembly/*` cover every mechanical section so the
// caller always has a usable draft (§13).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAiRuntime, extractJson } from "@/lib/ai-runtime";
import type { AiResult } from "@/lib/ai-runtime";
import {
  CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION,
  CODEX_DRAFT_MAX_TOKENS,
  CODEX_DRAFT_TIMEOUT_MS,
} from "../config";
import type {
  AiDraftTask,
  DraftingContext,
  DraftOperationResult,
  DraftSection,
  DocumentPlan,
  SectionType,
} from "../types";

// ---------------------------------------------------------------------------
// §15 — Zod schema for the AI-drafted sections (the response shape we ask
// the provider to produce). This is intentionally narrower than the full
// DraftSection interface — we only ask for the fields the AI may legitimately
// produce; the engine fills in versionId / id / reviewStatus / etc.
// ---------------------------------------------------------------------------

const AiDraftSectionSchema = z.object({
  sectionType: z.string(),
  title: z.string(),
  text: z.string(),
  sourceIds: z.array(z.string()).default([]),
  paragraphs: z.array(z.string()).optional(),
});

type AiDraftSection = z.infer<typeof AiDraftSectionSchema>;

// ---------------------------------------------------------------------------
// §15 — Build the drafting prompt handed to Codex.
// ---------------------------------------------------------------------------

function buildDraftingPrompt(
  ctx: DraftingContext,
  plan: DocumentPlan,
  task: AiDraftTask,
): string {
  // §10 — the AI sees ONLY internal source ids; the human-readable citations
  // are NOT included. The SourceIdMap is used at export time only.
  // §8 — the context is bounded; we never send the whole case.
  const sectionsWanted = plan.sections
    .filter((s) => s.required || s.sourceIds.length > 0)
    .map((s) => `- ${s.sectionType} (required=${s.required}): ${s.note}`)
    .join("\n");

  return `DRAFTING TASK: ${task}

DOCUMENT TYPE: ${plan.documentType}
GOAL: ${plan.goal || "(none)"}
PARTIES: ${plan.parties.join(", ") || "[MISSING_INFORMATION]"}
COURT: ${plan.court ?? "[MISSING_INFORMATION]"}
CASE NUMBER: ${plan.caseNumber ?? "[MISSING_INFORMATION]"}
JURISDICTION: ${plan.jurisdiction ?? "[MISSING_INFORMATION]"}

PLANNED SECTIONS:
${sectionsWanted}

CLOSED VERIFIED LEGAL RECORD (DraftingContext):
${JSON.stringify(ctx)}

INSTRUCTIONS:
${CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION}

OUTPUT: a JSON array of section objects. Each object MUST have:
  - sectionType (one of: ${plan.sections.map((s) => s.sectionType).join(", ")})
  - title (short Armenian heading)
  - text (the drafted prose — internal source ids cited inline as [F1], [CE4], [L2], [C3], [CC1], [E5], [A2])
  - sourceIds (the array of internal source ids cited in this section)
  - paragraphs (optional array of sub-paragraphs)

Do NOT invent new internal source ids — every id you cite MUST appear in the
supplied DraftingContext. Do NOT include the human-readable citations — they
are rendered at export time. If support is missing for a section, include
[SUPPORT_REQUIRED] in the text and still emit the section. If material
information is missing, include [MISSING_INFORMATION] in the text.

Output ONLY the JSON array — no prose, no markdown fences.`;
}

// ---------------------------------------------------------------------------
// §15 — Map an AiResult to a DraftOperationResult
// ---------------------------------------------------------------------------

function mapAiResult(
  result: AiResult<AiDraftSection[]>,
  draftId: string,
  versionId: string,
): DraftOperationResult {
  switch (result.status) {
    case "SUCCESS": {
      const sections = result.value.map((s) =>
        normalizeAiSection(s, draftId, versionId),
      );
      return {
        sections,
        status: "SUCCESS",
        provider: "codex-cli",
      };
    }
    case "SUCCESS_EMPTY":
      return {
        sections: [],
        status: "SUCCESS_EMPTY",
        provider: "codex-cli",
      };
    case "AUTH_REQUIRED":
      return {
        sections: [],
        status: "BLOCKED_EXTERNAL_QUOTA",
        provider: "codex-cli",
        errorDetail:
          "Codex CLI installed; ChatGPT sign-in required. Run: codex login. Deterministic assemblers cover every mechanical section — no hammering, no silent API-key billing switch (§13, §41).",
      };
    case "RATE_LIMITED":
      return {
        sections: [],
        status: "BLOCKED_EXTERNAL_QUOTA",
        provider: "codex-cli",
        errorDetail:
          "Codex CLI rate-limited (ChatGPT plan allowance exhausted). Deterministic assemblers cover every mechanical section — retry later, no silent API-key billing switch (§13, §41).",
      };
    case "TIMEOUT":
      return {
        sections: [],
        status: "TIMEOUT",
        provider: "codex-cli",
        errorDetail: "Codex CLI draft timed out.",
      };
    case "UNAVAILABLE":
      return {
        sections: [],
        // §15 — Codex unavailable (binary not on PATH / unconfigured) is NOT
        // the same as BLOCKED_EXTERNAL_QUOTA. The deterministic assemblers
        // cover everything mechanical — the caller may surface this status.
        status: "UNAVAILABLE",
        provider: "codex-cli",
        errorDetail:
          result.detail ?? "Codex CLI unavailable (binary not on PATH).",
      };
    case "INVALID_SCHEMA":
      return {
        sections: [],
        status: "INVALID_SCHEMA",
        provider: "codex-cli",
        errorDetail:
          result.detail ??
          "Codex CLI returned a payload that failed Zod validation.",
      };
    case "ERROR":
      return {
        sections: [],
        status: "ERROR",
        provider: "codex-cli",
        errorDetail: result.detail ?? "Codex CLI error.",
      };
  }
}

// ---------------------------------------------------------------------------
// §10 — Normalize an AI-produced section into the DraftSection shape.
// ---------------------------------------------------------------------------

function normalizeAiSection(
  s: AiDraftSection,
  draftId: string,
  versionId: string,
): DraftSection {
  const now = new Date();
  // §14 — strip any source id the AI may have invented that is NOT in the
  // supplied context. We don't have the context here (it was handed off in
  // the prompt); the verifier (Task B) will catch invented ids. We only
  // sanitize the shape here.
  const safeSourceIds = (s.sourceIds ?? []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  return {
    id: `${draftId}-${s.sectionType}-${randomUUID().slice(0, 8)}`,
    draftId,
    versionId,
    sectionType: s.sectionType as SectionType,
    title: s.title,
    content: {
      text: s.text,
      sourceIds: safeSourceIds,
      paragraphs: s.paragraphs,
    },
    reviewStatus: "AI_DRAFTED",
    stale: false,
    warnings: [],
    previousContent: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// §15 — draftWithCodex
// ---------------------------------------------------------------------------

/**
 * Ask the Codex CLI+ChatGPT provider to draft the AI-only sections of the
 * document. Closed evidence; network disabled; read-only.
 *
 * If AUTH_REQUIRED / RATE_LIMITED → returns status BLOCKED_EXTERNAL_QUOTA
 * (no hammering, no silent API-key billing switch — §13, §41).
 *
 * If the Codex CLI provider is unavailable (binary not on PATH / unconfigured
 * for drafting), returns status UNAVAILABLE — the caller should fall back to
 * the deterministic assemblers for every mechanical section and surface the
 * AI-only sections as NEEDS_SUPPORT.
 */
export async function draftWithCodex(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  task: AiDraftTask,
): Promise<DraftOperationResult> {
  const runtime = getAiRuntime();
  const provider = runtime.provider("codex-cli");
  if (!provider) {
    return {
      sections: [],
      status: "UNAVAILABLE",
      provider: "codex-cli",
      errorDetail:
        "Codex CLI provider not registered (Phase 4.1 ai-runtime registry).",
    };
  }

  const versionId = `version-codex-${Date.now()}`;
  const userPrompt = buildDraftingPrompt(ctx, plan, task);

  // §15 — closed-evidence system instruction is the FIRST system message.
  // The Codex CLI provider's generateStructured expects a JSON-serializable
  // request. We use a permissive schema (AiDraftSectionSchema array) so the
  // provider can either return a structured payload OR short-circuit with
  // AUTH_REQUIRED / UNAVAILABLE.
  const result = await provider.generateStructured<AiDraftSection[]>(
    {
      messages: [
        {
          role: "system",
          content: CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      schema: z.array(AiDraftSectionSchema),
      schemaName: "DraftSections",
      maxTokens: CODEX_DRAFT_MAX_TOKENS,
      timeoutMs: CODEX_DRAFT_TIMEOUT_MS,
    },
    { label: `legal-drafting:codex-drafter:${draftId}` },
  );

  return mapAiResult(result, draftId, versionId);
}

// ---------------------------------------------------------------------------
// Re-exports for downstream callers
// ---------------------------------------------------------------------------

export { extractJson, AiDraftSectionSchema };
export type { AiDraftSection };
