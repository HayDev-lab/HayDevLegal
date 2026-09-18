// src/lib/legal-drafting/config.ts
// Phase 6 — Verified Legal Document Drafting Engine — runtime config.
//
// All env reads happen here — services read typed constants from this module,
// never `process.env` directly (mirrors the ai-runtime config pattern). This
// makes the engine injectable in tests.

// ---------------------------------------------------------------------------
// §8 — Bounded context limits
// ---------------------------------------------------------------------------

/** Max facts included in the DraftingContext (§8 — never dump the whole case). */
export const MAX_FACTS_IN_CONTEXT = 30;

/** Max chronology events included in the DraftingContext. */
export const MAX_CHRONOLOGY_IN_CONTEXT = 20;

/** Max case-internal evidence refs (just refs, NOT full document text). */
export const MAX_EVIDENCE_REFS = 30;

/** Max legislation entries (L1…). */
export const MAX_LEGISLATION = 10;

/** Max Cassation precedents (C1…). */
export const MAX_CASSATION_CASES = 10;

/** Max Constitutional Court precedents (CC1…). */
export const MAX_CONCOURT_CASES = 5;

/** Max ECHR precedents (E1…). */
export const MAX_ECHR_CASES = 5;

/** Max verbatim passages per legal authority (§14 — only quotable text). */
export const MAX_PASSAGES_PER_AUTHORITY = 3;

/** Hard character cap on the serialized DraftingContext handed to the AI. */
export const MAX_TOTAL_CONTEXT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// §7 — Draft version retention
// ---------------------------------------------------------------------------

/** Hard cap on how many DraftVersion rows a single LegalDraft may accumulate. */
export const MAX_DRAFT_VERSIONS = 50;

// ---------------------------------------------------------------------------
// §15 — Closed-evidence Codex workspace root
// ---------------------------------------------------------------------------

/**
 * Root directory under which per-draft workspaces are created when invoking
 * the Codex CLI for AI drafting. Each draft gets an isolated, request-scoped
 * subdirectory. The Codex CLI is sandboxed read-only (§15, §42).
 */
export const DRAFT_STORAGE_ROOT =
  process.env.DRAFT_STORAGE_ROOT ?? "/tmp/haydevlegal-drafts";

// ---------------------------------------------------------------------------
// §15 — Closed-evidence drafter system instruction (verbatim per §15)
// ---------------------------------------------------------------------------

/**
 * The closed-evidence system instruction handed to BOTH Codex and the
 * fallback drafters. The wording is fixed by the master prompt — do NOT
 * paraphrase. Per §15: "Codex CLI+ChatGPT is PRIMARY. Closed evidence,
 * network disabled, read-only."
 */
export const CLOSED_EVIDENCE_DRAFT_SYSTEM_INSTRUCTION = `You are drafting from a CLOSED VERIFIED LEGAL RECORD. Use only supplied facts, evidence and authorities. Do not invent facts, dates, names, case numbers, articles, quotations, precedents, procedural history or remedies. Every substantive factual proposition must reference supplied fact/evidence IDs internally. Every substantive legal proposition must reference supplied authority IDs internally. If support is missing insert [SUPPORT_REQUIRED]. If material information is missing insert [MISSING_INFORMATION].`;

// ---------------------------------------------------------------------------
// §15 — Fallback drafter routing
// ---------------------------------------------------------------------------

/**
 * Whether the fallback drafter is allowed to run at all. Disabled by default
 * — the system instructs the operator to enable it explicitly when an
 * Ollama / Z-AI provider is configured as the drafting fallback. Per §15:
 * "Ollama / Z-AI only according to configured fallback."
 */
export const FALLBACK_DRAFTER_ENABLED =
  process.env.LEGAL_DRAFT_FALLBACK_ENABLED === "1" ||
  process.env.LEGAL_DRAFT_FALLBACK_ENABLED?.toLowerCase() === "true" ||
  false;

/** Timeout (ms) for the Codex CLI draft call. */
export const CODEX_DRAFT_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_DRAFT_TIMEOUT_MS ?? "180000",
  10,
);

/** Max tokens hint for the Codex CLI draft call. */
export const CODEX_DRAFT_MAX_TOKENS = Number.parseInt(
  process.env.CODEX_DRAFT_MAX_TOKENS ?? "16000",
  10,
);

/** Timeout (ms) for the fallback drafter. */
export const FALLBACK_DRAFT_TIMEOUT_MS = Number.parseInt(
  process.env.LEGAL_DRAFT_FALLBACK_TIMEOUT_MS ?? "30000",
  10,
);

/** Max tokens hint for the fallback drafter. */
export const FALLBACK_DRAFT_MAX_TOKENS = Number.parseInt(
  process.env.LEGAL_DRAFT_FALLBACK_MAX_TOKENS ?? "4000",
  10,
);
