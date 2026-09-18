// src/lib/legal-drafting/generation/fallback-drafter.ts
// Phase 6 §15 — Fallback AI drafter (Ollama Cloud / Z-AI).
//
// §15 — "Ollama / Z-AI only according to configured fallback." The fallback
// drafter is OFF by default — the operator must explicitly enable it via
// LEGAL_DRAFT_FALLBACK_ENABLED=true. This gate prevents silent quota spend
// when the operator intends to draft via Codex CLI+ChatGPT only.
//
// The fallback drafter uses the existing `routeGenerateText` /
// `routeGenerateStructured` from the ai-runtime router (Phase 4.1). The same
// closed-evidence system instruction is used. Per §14, the AI may not
// introduce new factual / legal sources.
//
// If the fallback drafter is disabled → returns status UNAVAILABLE + a
// helpful errorDetail. If routing exhausted every provider → returns the
// last error status (mapped to BLOCKED_EXTERNAL_QUOTA for AUTH_REQUIRED /
// RATE_LIMITED — no hammering, no silent API-key billing switch).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { routeGenerateStructured, extractJson } from "@/lib/ai-runtime";
import type { AiResult, AiTaskType } from "@/lib/ai-runtime";
import {
  CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION,
  FALLBACK_DRAFTER_ENABLED,
  FALLBACK_DRAFT_MAX_TOKENS,
  FALLBACK_DRAFT_TIMEOUT_MS,
} from "../config";
import { AiDraftSectionSchema } from "./codex-drafter";
import type { AiDraftSection } from "./codex-drafter";
import type {
  AiDraftTask,
  DraftingContext,
  DraftOperationResult,
  DraftSection,
  DocumentPlan,
  SectionType,
} from "../types";

// ---------------------------------------------------------------------------
// §15 — AiDraftTask → AiTaskType (router task key)
// ---------------------------------------------------------------------------
//
// The fallback drafter uses the FINAL_ANSWER routing policy (zai →
// ollama-cloud) — these are the cheapest providers in the runtime and the
// natural fallback when Codex CLI is unavailable. We do NOT route through
// codex-cli here — the codex-drafter is the dedicated path for that.

const FALLBACK_ROUTING_TASK: AiTaskType = "FINAL_ANSWER";

// ---------------------------------------------------------------------------
// §15 — Build the drafting prompt (mirrors codex-drafter's prompt shape)
// ---------------------------------------------------------------------------

function buildFallbackPrompt(
  ctx: DraftingContext,
  plan: DocumentPlan,
  task: AiDraftTask,
): string {
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
      return { sections, status: "SUCCESS", provider: result.provider };
    }
    case "SUCCESS_EMPTY":
      return { sections: [], status: "SUCCESS_EMPTY", provider: result.provider };
    case "AUTH_REQUIRED":
      return {
        sections: [],
        status: "BLOCKED_EXTERNAL_QUOTA",
        provider: result.provider,
        errorDetail:
          "Fallback drafter provider returned AUTH_REQUIRED — operator must configure provider credentials. No hammering, no silent API-key billing switch (§13, §41).",
      };
    case "RATE_LIMITED":
      return {
        sections: [],
        status: "BLOCKED_EXTERNAL_QUOTA",
        provider: result.provider,
        errorDetail:
          "Fallback drafter provider rate-limited — no hammering, no silent API-key billing switch (§13, §41).",
      };
    case "TIMEOUT":
      return {
        sections: [],
        status: "TIMEOUT",
        provider: result.provider,
        errorDetail: "Fallback drafter timed out.",
      };
    case "UNAVAILABLE":
      return {
        sections: [],
        status: "UNAVAILABLE",
        provider: result.provider,
        errorDetail: result.detail ?? "Fallback provider unavailable.",
      };
    case "INVALID_SCHEMA":
      return {
        sections: [],
        status: "INVALID_SCHEMA",
        provider: result.provider,
        errorDetail:
          result.detail ??
          "Fallback provider returned a payload that failed Zod validation.",
      };
    case "ERROR":
      return {
        sections: [],
        status: "ERROR",
        provider: result.provider,
        errorDetail: result.detail ?? "Fallback provider error.",
      };
  }
}

// ---------------------------------------------------------------------------
// §10 — Normalize an AI-produced section into the DraftSection shape.
// (Mirrors codex-drafter.normalizeAiSection — kept here so the two drafters
// are independent and the fallback can be swapped out without affecting the
// codex path.)
// ---------------------------------------------------------------------------

function normalizeAiSection(
  s: AiDraftSection,
  draftId: string,
  versionId: string,
): DraftSection {
  const now = new Date();
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
// §15 — draftWithFallback
// ---------------------------------------------------------------------------

/**
 * Ask the fallback provider (Z-AI / Ollama Cloud) to draft the AI-only
 * sections of the document. Uses the same closed-evidence system instruction
 * as Codex.
 *
 * If the fallback drafter is disabled (FALLBACK_DRAFTER_ENABLED=false,
 * default), returns status UNAVAILABLE. The caller should then surface the
 * deterministic assemblers for every mechanical section and the AI-only
 * sections as NEEDS_SUPPORT.
 */
export async function draftWithFallback(
  draftId: string,
  ctx: DraftingContext,
  plan: DocumentPlan,
  task: AiDraftTask,
): Promise<DraftOperationResult> {
  if (!FALLBACK_DRAFTER_ENABLED) {
    return {
      sections: [],
      status: "UNAVAILABLE",
      provider: "zai",
      errorDetail:
        "Fallback drafter disabled (LEGAL_DRAFT_FALLBACK_ENABLED=false). Enable to draft AI-only sections via Z-AI / Ollama Cloud.",
    };
  }

  const versionId = `version-fallback-${Date.now()}`;
  const userPrompt = buildFallbackPrompt(ctx, plan, task);

  const result = await routeGenerateStructured<AiDraftSection[]>(
    {
      messages: [
        { role: "system", content: CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION },
        { role: "user", content: userPrompt },
      ],
      schema: z.array(AiDraftSectionSchema),
      schemaName: "DraftSections",
      maxTokens: FALLBACK_DRAFT_MAX_TOKENS,
      timeoutMs: FALLBACK_DRAFT_TIMEOUT_MS,
    },
    FALLBACK_ROUTING_TASK,
    { label: `legal-drafting:fallback-drafter:${draftId}` },
  );

  return mapAiResult(result, draftId, versionId);
}

// ---------------------------------------------------------------------------
// Re-exports for downstream callers
// ---------------------------------------------------------------------------

export { extractJson, AiDraftSectionSchema };
export type { AiDraftSection };
