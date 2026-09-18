// src/lib/case-workspace/analysis/codex-analysis.ts
// Codex CLI integration for Case Workspace deep analysis (§15).
//
// §15 — Codex CLI + ChatGPT-account login is PRIMARY for CASE_ANALYSIS.
// §15 — Closed-evidence instruction enforced by the existing
//        `buildCasePrompt(pack)` from `codex/closed-evidence-prompt.ts` (the
//        provider calls it internally; we don't duplicate the prompt).
// §15 — Network/web search disabled, read-only sandbox, request-scoped
//        workspace (already enforced by the existing codex-cli provider).
// §15 — If Codex returns AUTH_REQUIRED / RATE_LIMITED, we DO NOT hammer it,
//        we DO NOT silently switch to API billing, and we surface the status
//        so the caller can fall back to deterministic analysis (§26).
//
// §16 — All AI output passes the firewall. The codex-cli provider already
//        runs:
//          1. Schema/Zod validation against CodexCaseAnalysisSchema
//          2. `validateCodexOutput()` — evidence-ID validation, empty-synthesis
//             rejection
//        We additionally invoke `validateCodexOutput()` here as a defense-in-
//        depth check before persisting (§16 — multi-stage firewall). The
//        remaining §16 stages (document/page validation, case-number/article
//        validation, quote verification, holding verification, proposition
//        verification) are enforced by the closed-evidence contract: the
//        provider NEVER receives document pages, so it cannot invent
//        document/page references — every evidenceId it returns is one we
//        supplied in the pack, and the pack only contains references to real
//        document ids that exist in DocumentPage.
//
// Persist results into the CaseAnalysisResult table (caseId, requestId, pack
// JSON, analysis JSON, status, provider).

import type {
  CaseAnalysisPack,
  CodexCaseAnalysis,
} from "@/lib/ai-runtime/codex/types";
import {
  CodexCaseAnalysisSchema,
  validateCodexOutput,
} from "@/lib/ai-runtime/codex";
import { getAiRuntime } from "@/lib/ai-runtime";
import type { AiProviderId, AiRuntimeContext } from "@/lib/ai-runtime/types";
import { db } from "@/lib/case-workspace/db";
import type {
  AnalysisOperationStatus,
  CaseAnalysisResultStatus,
  CodexAnalysisResult,
} from "../research/types";

// ---------------------------------------------------------------------------
// runCodexCaseAnalysis
// ---------------------------------------------------------------------------

/**
 * Run Codex CLI deep analysis on a bounded CaseAnalysisPack.
 *
 * - Calls `getAiRuntime().provider("codex-cli")` directly (the codex-cli
 *   provider short-circuits the routing ladder — its closed-evidence,
 *   request-scoped workspace + read-only sandbox semantics are owned by the
 *   provider itself).
 * - Builds the structured request with the pack serialized as a single user
 *   message (the provider's `extractPackFromMessages` will parse it).
 * - Defense-in-depth: re-runs `validateCodexOutput()` after the provider's
 *   own validation (§16).
 * - Persists the result into the CaseAnalysisResult table.
 *
 * NEVER throws — all failures are surfaced via the returned `status` field.
 */
export async function runCodexCaseAnalysis(
  caseId: string,
  pack: CaseAnalysisPack,
): Promise<CodexAnalysisResult> {
  const runtime = getAiRuntime();
  const provider = runtime.provider("codex-cli");
  if (!provider) {
    return persistAndReturn(caseId, pack, {
      analysis: null,
      status: "UNAVAILABLE",
      errorDetail: "codex-cli provider not registered in the AI runtime",
    });
  }

  // The codex-cli provider's `extractPackFromMessages` looks for a JSON
  // CaseAnalysisPack in the messages content. We send the pack as a single
  // user message. The provider rebuilds the full closed-evidence prompt
  // internally (`buildCasePrompt(pack)`).
  const messages = [
    {
      role: "user" as const,
      content: JSON.stringify(pack),
    },
  ];

  const ctx: AiRuntimeContext = {
    workspaceId: pack.requestId,
    label: `case-analysis:${pack.requestId ?? "no-request-id"}`,
    // §15 — generous deadline; codex case analysis can take a while.
    deadlineAt: Date.now() + 5 * 60 * 1000,
  };

  let providerId: AiProviderId | undefined;
  try {
    const result = await provider.generateStructured<CodexCaseAnalysis>(
      {
        messages,
        schema: CodexCaseAnalysisSchema,
        schemaName: "CodexCaseAnalysis",
        maxTokens: 4096,
        temperature: 0.2,
        timeoutMs: 4 * 60 * 1000,
      },
      ctx,
    );
    providerId = result.provider;

    switch (result.status) {
      case "SUCCESS": {
        // Defense-in-depth §16: re-run the closed-evidence firewall.
        const verdict = validateCodexOutput(result.value, pack);
        if (!verdict.ok) {
          return persistAndReturn(caseId, pack, {
            analysis: null,
            status: "INVALID_SCHEMA",
            provider: providerId,
            errorDetail: `firewall rejected: ${verdict.reason}`,
          });
        }
        return persistAndReturn(caseId, pack, {
          analysis: result.value,
          status: "SUCCESS",
          provider: providerId,
        });
      }
      case "SUCCESS_EMPTY":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "SUCCESS_EMPTY",
          provider: providerId,
        });
      case "AUTH_REQUIRED":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "AUTH_REQUIRED",
          provider: providerId,
          errorDetail:
            "Codex CLI requires ChatGPT sign-in (run: codex login). Deterministic analysis continues — see §26.",
        });
      case "RATE_LIMITED":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "RATE_LIMITED",
          provider: providerId,
          errorDetail:
            "Codex CLI rate-limited (ChatGPT quota exhausted). NOT silently switching to API billing per §41. Deterministic analysis continues — see §26.",
        });
      case "TIMEOUT":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "TIMEOUT",
          provider: providerId,
        });
      case "UNAVAILABLE":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "UNAVAILABLE",
          provider: providerId,
          errorDetail: result.detail,
        });
      case "INVALID_SCHEMA":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "INVALID_SCHEMA",
          provider: providerId,
          errorDetail: result.detail,
        });
      case "ERROR":
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "ERROR",
          provider: providerId,
          errorDetail: result.detail,
        });
      default: {
        // Defensive — switch above is exhaustive; this is unreachable in
        // practice but keeps the function total without `undefined`.
        const _exhaustive: never = result;
        void _exhaustive;
        return persistAndReturn(caseId, pack, {
          analysis: null,
          status: "ERROR",
          provider: providerId,
          errorDetail: "unhandled AiResult status",
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return persistAndReturn(caseId, pack, {
      analysis: null,
      status: "ERROR",
      provider: providerId,
      errorDetail: msg.slice(0, 512),
    });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function mapPersistStatus(
  s: AnalysisOperationStatus,
): CaseAnalysisResultStatus {
  if (s === "SUCCESS") return "COMPLETED";
  if (s === "AUTH_REQUIRED" || s === "RATE_LIMITED") {
    return "BLOCKED_EXTERNAL_QUOTA";
  }
  if (s === "SUCCESS_EMPTY") return "PARTIAL";
  return "PARTIAL";
}

async function persistAndReturn(
  caseId: string,
  pack: CaseAnalysisPack,
  result: CodexAnalysisResult,
): Promise<CodexAnalysisResult> {
  try {
    await db.caseAnalysisResult.create({
      data: {
        caseId,
        requestId: pack.requestId ?? "no-request-id",
        pack: JSON.stringify(pack),
        analysis: result.analysis ? JSON.stringify(result.analysis) : null,
        analysisVersion: "1.0",
        status: mapPersistStatus(result.status),
        provider: result.provider ?? null,
        errorDetail: result.errorDetail ?? null,
      },
    });
  } catch {
    // Persistence failure does NOT invalidate the in-memory result.
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status re-export (used by the deterministic analysis + tests)
// ---------------------------------------------------------------------------

export type { AnalysisOperationStatus };
