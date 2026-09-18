// src/lib/legal-drafting/review/review-model.ts
// Phase 6 — §23-§25 — Per-section review state + stale-assertion marking.
//
// §23 — Every DraftSection has an independent review status:
//        UNREVIEWED | AI_DRAFTED | VERIFIED | NEEDS_SUPPORT | USER_EDITED | REJECTED
// §24 — Inline warnings live on the section (MissingSupport, DisputedFact,
//        MetadataOnly, QuoteUnverified, StaleLaw, PrecedentWithDistinctions,
//        CounterAuthority, MissingInformation, ...).
// §25 — When a source the draft relied on changes, dependent assertions are
//        marked STALE / NEEDS_REVERIFY. HUMAN EDITS ARE NEVER DESTROYED —
//        the previous content is preserved in `previousContent`.
//
// CRITICAL — §25: "never destroy human edits; preserve previousContent".

import { db } from "@/lib/db";
import type {
  DraftSection,
  DraftSectionContent,
  ReviewStatus,
  SectionWarning,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// (de)serialization helpers — DraftSection <-> Prisma DraftSection row
// ---------------------------------------------------------------------------

type PrismaDraftSectionRow = {
  id: string;
  draftId: string;
  versionId: string;
  sectionType: string;
  title: string;
  content: string; // JSON
  reviewStatus: string;
  stale: boolean;
  warnings: string; // JSON
  previousContent: string | null; // JSON
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

function parseWarnings(raw: string | null | undefined): SectionWarning[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> =>
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
}

function rowToDraftSection(row: PrismaDraftSectionRow): DraftSection {
  return {
    id: row.id,
    draftId: row.draftId,
    versionId: row.versionId,
    sectionType: row.sectionType as DraftSection["sectionType"],
    title: row.title,
    content: parseContent(row.content),
    reviewStatus: row.reviewStatus as ReviewStatus,
    stale: row.stale,
    warnings: parseWarnings(row.warnings),
    previousContent: row.previousContent ? parseContent(row.previousContent) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

function serializeWarnings(warnings: SectionWarning[]): string {
  return JSON.stringify(warnings ?? []);
}

function isValidReviewStatus(s: string): s is ReviewStatus {
  return [
    "UNREVIEWED",
    "AI_DRAFTED",
    "VERIFIED",
    "NEEDS_SUPPORT",
    "USER_EDITED",
    "REJECTED",
  ].includes(s);
}

// ---------------------------------------------------------------------------
// §23 — updateSectionReview
// ---------------------------------------------------------------------------

/**
 * §25 — Update a section's review status, optionally with human-edited
 * content. CRITICAL: human edits are NEVER destroyed. When `editedContent`
 * is provided, the current `content` is preserved as `previousContent` and
 * the section's reviewStatus is set to USER_EDITED (regardless of the
 * `reviewStatus` argument — a human edit always forces USER_EDITED).
 *
 * @param sectionId      the DraftSection id
 * @param reviewStatus   the new review status (ignored when editedContent is
 *                       provided — forced to USER_EDITED)
 * @param editedContent  optional new content (human edit)
 * @param userId         optional user id (for audit trail — currently stored
 *                       as a section warning of type "HUMAN_EDIT_BY")
 * @returns the updated DraftSection
 */
export async function updateSectionReview(
  sectionId: string,
  reviewStatus: ReviewStatus,
  editedContent?: DraftSectionContent | string,
  userId?: string,
): Promise<DraftSection> {
  if (!isValidReviewStatus(reviewStatus)) {
    throw new Error(`Invalid review status: ${reviewStatus}`);
  }

  // Load the current row.
  const current = (await db.draftSection.findUnique({
    where: { id: sectionId },
  })) as PrismaDraftSectionRow | null;

  if (!current) {
    throw new Error(`DraftSection ${sectionId} not found`);
  }

  let newContentJson = current.content;
  let newPreviousContentJson = current.previousContent;
  let effectiveStatus: ReviewStatus = reviewStatus;
  let newStale = current.stale;
  let newWarnings = parseWarnings(current.warnings);

  if (editedContent !== undefined) {
    // §25 — preserve previousContent. The current content becomes the
    // previousContent (we never destroy prior content).
    const newContent: DraftSectionContent =
      typeof editedContent === "string"
        ? parseContent(editedContent)
        : editedContent;

    // Only swap if the content actually changed — otherwise the audit trail
    // fills up with no-op entries.
    const currentContent = parseContent(current.content);
    const changed =
      JSON.stringify(currentContent) !== JSON.stringify(newContent);
    if (changed) {
      newPreviousContentJson = current.content; // preserve prior
      newContentJson = serializeContent(newContent);
    }
    // §25 — human edit forces USER_EDITED regardless of the passed status.
    effectiveStatus = "USER_EDITED";
    newStale = false; // the edit cleared stale.

    // Append a HUMAN_EDIT_BY warning (audit trail) — non-destructive.
    newWarnings = [
      ...newWarnings.filter((w) => w.type !== "HUMAN_EDIT_BY"),
      {
        type: "HUMAN_EDIT_BY",
        detail: `Section edited by ${userId ?? "user"} at ${new Date().toISOString()}`,
      },
    ];
  }

  // Cap warnings at a reasonable size (audit trail is bounded per §7).
  if (newWarnings.length > 25) {
    newWarnings = newWarnings.slice(-25);
  }

  const updated = (await db.draftSection.update({
    where: { id: sectionId },
    data: {
      content: newContentJson,
      previousContent: newPreviousContentJson,
      reviewStatus: effectiveStatus,
      stale: newStale,
      warnings: serializeWarnings(newWarnings),
      updatedAt: new Date(),
    },
  })) as PrismaDraftSectionRow;

  return rowToDraftSection(updated);
}

// ---------------------------------------------------------------------------
// §25 — markStaleAssertions
// ---------------------------------------------------------------------------

/**
 * §25 — When a source the draft relied on changes (the user edits a fact,
 * new evidence is added, an authority is overruled, an applicability verdict
 * changes), all DraftSections that cite that source's internal id are marked
 * STALE and their reviewStatus is downgraded to NEEDS_SUPPORT (NEEDS_REVERIFY).
 *
 * This function is idempotent — re-marking an already-stale section is a
 * no-op.
 *
 * @param draftId         the LegalDraft id
 * @param changedSourceIds the internal source ids that changed (F1, L2, C3,
 *                          CC1, E5, A2, ...)
 */
export async function markStaleAssertions(
  draftId: string,
  changedSourceIds: string[],
): Promise<void> {
  if (changedSourceIds.length === 0) return;

  // De-duplicate + normalize the changed-id set.
  const changed = new Set(
    changedSourceIds.filter((s) => typeof s === "string" && s.length > 0),
  );
  if (changed.size === 0) return;

  // Load all sections for the draft (any version — we mark stale across
  // versions because the user may want to regenerate any of them).
  const sections = (await db.draftSection.findMany({
    where: { draftId },
  })) as PrismaDraftSectionRow[];

  for (const row of sections) {
    const content = parseContent(row.content);
    const cited = content.sourceIds ?? [];
    const depends = cited.some((sid) => changed.has(sid));
    if (!depends) continue;
    if (row.stale && row.reviewStatus === "NEEDS_SUPPORT") continue;

    // Append a STALE_DUE_TO_SOURCE_CHANGE warning (audit trail).
    const warnings = parseWarnings(row.warnings);
    const newWarnings: SectionWarning[] = [
      ...warnings.filter(
        (w) =>
          w.type !== "STALE_DUE_TO_SOURCE_CHANGE" ||
          !changed.has(w.sourceId ?? ""),
      ),
      ...Array.from(changed).map((sid) => ({
        type: "STALE_DUE_TO_SOURCE_CHANGE",
        detail: `Section marked STALE because relied source ${sid} changed (§25). Re-verify before restoring VERIFIED status.`,
        sourceId: sid,
      })),
    ].slice(-25);

    await db.draftSection.update({
      where: { id: row.id },
      data: {
        stale: true,
        reviewStatus: "NEEDS_SUPPORT",
        warnings: serializeWarnings(newWarnings),
        updatedAt: new Date(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// §24 — getSectionWarnings
// ---------------------------------------------------------------------------

/**
 * §24 — Return the inline warnings stored on a section.
 *
 * The warnings array is the canonical source of inline review feedback. The
 * drafting UI renders these next to the section. Categories include (§24):
 *   - MISSING_SUPPORT
 *   - DISPUTED_FACT
 *   - CONTRADICTED_FACT
 *   - METADATA_ONLY
 *   - QUOTE_UNVERIFIED
 *   - STALE_LAW
 *   - PRECEDENT_WITH_DISTINCTIONS
 *   - COUNTER_AUTHORITY
 *   - MISSING_INFORMATION
 *   - HUMAN_EDIT_BY
 *   - STALE_DUE_TO_SOURCE_CHANGE
 *   - INVENTED_CITATION
 *
 * @param sectionId the DraftSection id
 * @returns the SectionWarning[] stored on the section
 */
export async function getSectionWarnings(
  sectionId: string,
): Promise<SectionWarning[]> {
  const row = (await db.draftSection.findUnique({
    where: { id: sectionId },
    select: { warnings: true },
  })) as { warnings: string } | null;

  if (!row) return [];
  return parseWarnings(row.warnings);
}

// ---------------------------------------------------------------------------
// Helpers exported for the API + UI layers
// ---------------------------------------------------------------------------

/**
 * Set (replace) the warnings array on a section. Used by the verification
 * orchestrator (`runAllVerification`) to surface firewall verdicts as inline
 * §24 warnings.
 */
export async function setSectionWarnings(
  sectionId: string,
  warnings: SectionWarning[],
): Promise<void> {
  await db.draftSection.update({
    where: { id: sectionId },
    data: {
      warnings: serializeWarnings(warnings),
      updatedAt: new Date(),
    },
  });
}

/**
 * §25 — Convenience helper: bulk-set warnings + (optionally) stale flag on
 * many sections in one DB transaction.
 */
export async function bulkSetSectionState(
  updates: Array<{
    sectionId: string;
    warnings?: SectionWarning[];
    stale?: boolean;
    reviewStatus?: ReviewStatus;
  }>,
): Promise<void> {
  if (updates.length === 0) return;
  await db.$transaction(
    updates.map((u) =>
      db.draftSection.update({
        where: { id: u.sectionId },
        data: {
          ...(u.warnings !== undefined
            ? { warnings: serializeWarnings(u.warnings) }
            : {}),
          ...(u.stale !== undefined ? { stale: u.stale } : {}),
          ...(u.reviewStatus !== undefined
            ? { reviewStatus: u.reviewStatus }
            : {}),
          updatedAt: new Date(),
        },
      }),
    ),
  );
}

/**
 * Load a DraftSection (parsed) by id. Exposed for the API + UI.
 */
export async function getSection(sectionId: string): Promise<DraftSection | null> {
  const row = (await db.draftSection.findUnique({
    where: { id: sectionId },
  })) as PrismaDraftSectionRow | null;
  return row ? rowToDraftSection(row) : null;
}
