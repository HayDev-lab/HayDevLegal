// src/lib/legal-drafting/review/change-tracking.ts
// Phase 6 — §7, §25 — Version change tracking + per-section regeneration.
//
// §7  — DraftVersion is versioned content. NEVER overwrite the only prior
//        version — always insert a new row. When MAX_DRAFT_VERSIONS (50) is
//        reached, trim the OLDEST version (never the most recent prior).
// §25 — regenerateSection updates ONE section's content without rewriting
//        the whole document. The previous content is preserved on the
//        section's `previousContent` field (audit trail).

import { db } from "@/lib/db";
import { MAX_DRAFT_VERSIONS } from "@/lib/legal-drafting/config";
import type {
  AiDraftTask,
  CreatedBy,
  DraftSection,
  DraftSectionContent,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// §7 — DraftVersion type (mirrors the Prisma DraftVersion model — the
// types.ts subagent module doesn't export a parsed DraftVersion interface
// yet, so we declare it locally and re-export it for downstream consumers).
// ---------------------------------------------------------------------------

export type DraftVersionVerificationStatus =
  | "UNVERIFIED"
  | "PARTIAL"
  | "VERIFIED"
  | "NEEDS_REVIEW";

export interface DraftVersion {
  id: string;
  draftId: string;
  version: number;
  /** Raw JSON-stringified DraftSection[] payload. */
  content: string;
  createdBy: CreatedBy;
  verificationStatus: DraftVersionVerificationStatus;
  /** Raw JSON-stringified SourceIdMap payload. */
  sourceIdMap: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// (de)serialization helpers
// ---------------------------------------------------------------------------

type PrismaDraftVersionRow = {
  id: string;
  draftId: string;
  version: number;
  content: string; // JSON DraftSection[]
  createdBy: string;
  verificationStatus: string;
  sourceIdMap: string; // JSON
  createdAt: Date;
  updatedAt: Date;
};

type PrismaDraftSectionRow = {
  id: string;
  draftId: string;
  versionId: string;
  sectionType: string;
  title: string;
  content: string;
  reviewStatus: string;
  stale: boolean;
  warnings: string;
  previousContent: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function parseContent(raw: string | null | undefined): DraftSectionContent {
  if (!raw) return { text: "", sourceIds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<DraftSectionContent>;
    return {
      text: parsed.text ?? "",
      sourceIds: Array.isArray(parsed.sourceIds) ? parsed.sourceIds : [],
      paragraphs: Array.isArray(parsed.paragraphs) ? parsed.paragraphs : undefined,
      table: parsed.table ?? undefined,
    };
  } catch {
    return { text: "", sourceIds: [] };
  }
}

function serializeContent(content: DraftSectionContent): string {
  const safe: DraftSectionContent = {
    text: content.text ?? "",
    sourceIds: Array.isArray(content.sourceIds) ? content.sourceIds : [],
  };
  if (Array.isArray(content.paragraphs)) safe.paragraphs = content.paragraphs;
  if (content.table) safe.table = content.table;
  return JSON.stringify(safe);
}

function rowToDraftSection(row: PrismaDraftSectionRow): DraftSection {
  return {
    id: row.id,
    draftId: row.draftId,
    versionId: row.versionId,
    sectionType: row.sectionType as DraftSection["sectionType"],
    title: row.title,
    content: parseContent(row.content),
    reviewStatus: row.reviewStatus as DraftSection["reviewStatus"],
    stale: row.stale,
    warnings: (() => {
      try {
        const parsed = JSON.parse(row.warnings ?? "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(
            (x): x is Record<string, unknown> =>
              typeof x === "object" && x !== null && "type" in x,
          )
          .map((x) => ({
            type: String(x.type),
            detail: typeof x.detail === "string" ? x.detail : "",
            sourceId: typeof x.sourceId === "string" ? x.sourceId : undefined,
          }));
      } catch {
        return [];
      }
    })(),
    previousContent: row.previousContent ? parseContent(row.previousContent) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToDraftVersion(row: PrismaDraftVersionRow): DraftVersion {
  return {
    id: row.id,
    draftId: row.draftId,
    version: row.version,
    content: row.content,
    createdBy: row.createdBy as DraftVersion["createdBy"],
    verificationStatus: row.verificationStatus as DraftVersion["verificationStatus"],
    sourceIdMap: row.sourceIdMap,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// §7 — createVersion
// ---------------------------------------------------------------------------

/**
 * §7 — Create a new DraftVersion row for a draft. NEVER overwrites the only
 * prior version (always inserts a new row). When MAX_DRAFT_VERSIONS=50 is
 * reached, trims the OLDEST version (never the most recent prior).
 *
 * @param draftId   the LegalDraft id
 * @param content   the serialized DraftSection[] for the new version
 * @param createdBy "SYSTEM" | "USER" | "AI"
 * @returns the new DraftVersion (parsed)
 */
export async function createVersion(
  draftId: string,
  content: string,
  createdBy: string,
): Promise<DraftVersion> {
  // Load existing versions to compute the next version number.
  const existing = (await db.draftVersion.findMany({
    where: { draftId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, createdAt: true },
  })) as Array<{ id: string; version: number; createdAt: Date }>;

  const nextVersionNumber = existing.length === 0 ? 1 : existing[0].version + 1;

  // §7 — Insert the new version (we never overwrite the only prior version).
  const created = (await db.draftVersion.create({
    data: {
      draftId,
      version: nextVersionNumber,
      content,
      createdBy,
      verificationStatus: "UNVERIFIED",
      sourceIdMap: "{}",
    },
  })) as PrismaDraftVersionRow;

  // §7 — Trim oldest when over the cap. We NEVER delete the only prior
  // version; the cap is enforced by deleting versions beyond
  // MAX_DRAFT_VERSIONS, oldest-first.
  if (existing.length + 1 > MAX_DRAFT_VERSIONS) {
    const all = (await db.draftVersion.findMany({
      where: { draftId },
      orderBy: { version: "asc" },
      select: { id: true, version: true },
    })) as Array<{ id: string; version: number }>;
    // Keep only the newest MAX_DRAFT_VERSIONS — delete the rest.
    const toDelete = all.slice(0, Math.max(0, all.length - MAX_DRAFT_VERSIONS));
    if (toDelete.length > 0) {
      await db.draftVersion.deleteMany({
        where: { id: { in: toDelete.map((v) => v.id) } },
      });
    }
  }

  return rowToDraftVersion(created);
}

// ---------------------------------------------------------------------------
// §7 — listVersions
// ---------------------------------------------------------------------------

export async function listVersions(
  draftId: string,
): Promise<DraftVersion[]> {
  const rows = (await db.draftVersion.findMany({
    where: { draftId },
    orderBy: { version: "desc" },
  })) as PrismaDraftVersionRow[];
  return rows.map(rowToDraftVersion);
}

// ---------------------------------------------------------------------------
// §7 — getVersion
// ---------------------------------------------------------------------------

export async function getVersion(
  draftId: string,
  version: number,
): Promise<DraftVersion | null> {
  const row = (await db.draftVersion.findFirst({
    where: { draftId, version },
  })) as PrismaDraftVersionRow | null;
  return row ? rowToDraftVersion(row) : null;
}

// ---------------------------------------------------------------------------
// §25 — regenerateSection
// ---------------------------------------------------------------------------

/**
 * §25 — Regenerate ONE section's content without rewriting the whole
 * document. The previous content is preserved on the section's
 * `previousContent` field (audit trail — human edits are never destroyed).
 *
 * Implementation:
 *   1. Load the section + draft.
 *   2. Try to invoke the AI drafter (Subagent A's generation module). If it
 *      is unavailable (Codex AUTH_REQUIRED / module not loaded), fall back
 *      to a deterministic skeleton marked [SUPPORT_REQUIRED] (§15).
 *   3. Update the DraftSection row in place — previousContent is set to the
 *      pre-regeneration content; reviewStatus becomes AI_DRAFTED (or
 *      NEEDS_SUPPORT in the fallback path).
 *
 * @param draftId   the LegalDraft id
 * @param sectionId the DraftSection id to regenerate
 * @param task      the AI draft task type (FULL_DOCUMENT_DRAFT, ...)
 * @returns the regenerated DraftSection (parsed)
 */
export async function regenerateSection(
  draftId: string,
  sectionId: string,
  task: AiDraftTask,
): Promise<DraftSection> {
  // Load section + draft.
  const section = (await db.draftSection.findUnique({
    where: { id: sectionId },
  })) as PrismaDraftSectionRow | null;
  if (!section) {
    throw new Error(`DraftSection ${sectionId} not found`);
  }
  if (section.draftId !== draftId) {
    throw new Error(
      `DraftSection ${sectionId} does not belong to draft ${draftId}`,
    );
  }

  const draft = (await db.legalDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      documentType: true,
      title: true,
      language: true,
      goal: true,
      contextSummary: true,
      plan: true,
    },
  })) as {
    id: string;
    documentType: string;
    title: string;
    language: string;
    goal: string | null;
    contextSummary: string;
    plan: string;
  } | null;

  if (!draft) {
    throw new Error(`LegalDraft ${draftId} not found`);
  }

  // Preserve previousContent (§25 — never destroy human edits).
  const previousContentJson = section.content;

  // Try the AI drafter. This is a dynamic import — if Subagent A's
  // generation module isn't loaded yet, or the Codex CLI is AUTH_REQUIRED /
  // RATE_LIMITED / BLOCKED_EXTERNAL_QUOTA, we fall back to a deterministic
  // skeleton marked [SUPPORT_REQUIRED] (§15).
  let newContent: DraftSectionContent;
  let newReviewStatus: DraftSection["reviewStatus"];
  let stale = false;

  const drafterResult = await invokeAiDrafter(draftId, sectionId, task).catch(
    () => null,
  );

  if (drafterResult && drafterResult.text) {
    newContent = {
      text: drafterResult.text,
      sourceIds: drafterResult.sourceIds ?? [],
      paragraphs: drafterResult.paragraphs,
      table: drafterResult.table,
    };
    newReviewStatus = "AI_DRAFTED";
  } else {
    // §15 — Fallback: deterministic skeleton with [SUPPORT_REQUIRED] /
    // [MISSING_INFORMATION] markers. The drafter is unavailable.
    newContent = buildDeterministicSkeleton(section, draft, task);
    newReviewStatus = "NEEDS_SUPPORT";
    stale = false; // needs support, not stale
  }

  // Update the section in place. previousContent is preserved.
  const updated = (await db.draftSection.update({
    where: { id: sectionId },
    data: {
      content: serializeContent(newContent),
      previousContent: previousContentJson,
      reviewStatus: newReviewStatus,
      stale,
      updatedAt: new Date(),
    },
  })) as PrismaDraftSectionRow;

  return rowToDraftSection(updated);
}

// ---------------------------------------------------------------------------
// AI drafter invocation (dynamic — graceful fallback)
// ---------------------------------------------------------------------------

interface DrafterOutput {
  text: string;
  sourceIds?: string[];
  paragraphs?: string[];
  table?: { headers: string[]; rows: string[][] };
}

/**
 * Dynamic attempt to invoke Subagent A's generation module. Returns null
 * if the module isn't loaded yet or the drafter is unavailable
 * (AUTH_REQUIRED / BLOCKED_EXTERNAL_QUOTA / etc.).
 *
 * The dynamic import path is resolved at runtime; we wrap it in try/catch
 * so a missing module doesn't crash the regenerate flow.
 */
async function invokeAiDrafter(
  _draftId: string,
  _sectionId: string,
  _task: AiDraftTask,
): Promise<DrafterOutput | null> {
  try {
    // Dynamic import via a variable so TypeScript doesn't try to resolve
    // the module path at typecheck time (Subagent A's generation module
    // may not exist yet during parallel development, and even when it does
    // exist, the Codex CLI may be AUTH_REQUIRED / BLOCKED_EXTERNAL_QUOTA).
    const modulePath = "@/lib/legal-drafting/generation";
    const mod = (await import(/* @vite-ignore */ modulePath).catch(
      () => null,
    )) as
      | {
          draftSection?: (
            draftId: string,
            sectionId: string,
            task: AiDraftTask,
          ) => Promise<DrafterOutput | null>;
        }
      | null;
    if (!mod || typeof mod.draftSection !== "function") return null;
    const out = await mod.draftSection(_draftId, _sectionId, _task);
    return out ?? null;
  } catch {
    return null;
  }
}

/**
 * §15 — Deterministic skeleton used when the AI drafter is unavailable. The
 * skeleton is intentionally minimal — it preserves the section's title and
 * structure, marks every substantive gap with [SUPPORT_REQUIRED] or
 * [MISSING_INFORMATION], and clearly states that the AI drafter is
 * unavailable. The user (or the main agent's API layer) can later re-invoke
 * regenerateSection once Codex is available.
 *
 * This skeleton NEVER invents facts, dates, names, articles, precedents, or
 * remedies (§14, §15, §18, §21).
 */
function buildDeterministicSkeleton(
  section: PrismaDraftSectionRow,
  draft: {
    id: string;
    documentType: string;
    title: string;
    language: string;
    goal: string | null;
  },
  task: AiDraftTask,
): DraftSectionContent {
  const lines: string[] = [];
  lines.push(
    `[SUPPORT_REQUIRED] AI drafter unavailable (task ${task}). Section "${section.title}" requires human or AI re-drafting from the closed DraftingContext.`,
  );
  lines.push(
    `[MISSING_INFORMATION] Draft language for this section will be produced when Codex CLI is available (§15).`,
  );
  if (draft.goal) {
    lines.push(
      `Goal: ${draft.goal} (§11 — relief derives from this goal + document type ${draft.documentType}).`,
    );
  }
  lines.push(
    `Document: ${draft.title} (${draft.documentType}, language ${draft.language}).`,
  );
  // Preserve the previously-cited source ids so re-verification can still
  // validate the section's grounding after a successful regeneration.
  const priorContent = parseContent(section.content);
  return {
    text: lines.join("\n\n"),
    sourceIds: priorContent.sourceIds ?? [],
  };
}
