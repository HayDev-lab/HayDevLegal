// tests/unit/legal-drafting-invalidation.test.ts
//
// Phase 6.1 — §29-§34 — Dependency invalidation tests.
//
// §29 CRITICAL: "Never leave VERIFIED badge when dependency changes."
//
// When a source the draft relied on changes (a fact's status is downgraded,
// supporting evidence is removed, a statute is amended, a precedent's
// applicability verdict is revised, a new counter-authority is added), all
// DraftSections that cite that source's internal id MUST be marked STALE
// and their reviewStatus downgraded to NEEDS_SUPPORT (NEEDS_REVERIFY).
// `markStaleAssertions(draftId, changedSourceIds)` is the function that
// performs this invalidation.
//
// Test cases (per §29-34):
//   §30 — Fact change:        F1 DOCUMENT_VERIFIED → DISPUTED → section stale
//   §31 — Evidence removal:  fact F1's supporting CE1 removed → section stale
//   §32 — Law change:        L1 statute version amended → section stale
//   §33 — Precedent change:  C1 DIRECT → NOT_APPLICABLE → section stale
//   §34 — Counter-authority: new E1 counter-authority added → section stale
//
// Plus additional §25 correctness tests:
//   - markStaleAssertions is idempotent (§25)
//   - Sections NOT citing the changed source remain unchanged (no spurious
//     invalidation)
//   - The STALE_DUE_TO_SOURCE_CHANGE warning is appended with the source id
//     in the audit trail
//
// Per §29 — content is SYNTHETIC Armenian/RU/EN legal-style text. No real
// case data. Cleanup is per-test (each test creates + deletes its own draft).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "@/lib/db";
import { markStaleAssertions, getSection } from "@/lib/legal-drafting/review/review-model";
import type {
  DraftSectionContent,
  SectionWarning,
} from "@/lib/legal-drafting/types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal row shapes (only the fields we need — Prisma returns `any` for
 * SQLite JSON-typed fields; we cast).
 */
type CaseRow = { id: string };
type DraftRow = {
  id: string;
  caseId: string;
  documentType: string;
  title: string;
  status: string;
  language: string;
  parties: string;
  jurisdiction: string | null;
  caseNumber: string | null;
  goal: string | null;
  requestedRelief: string | null;
  contextSummary: string;
  plan: string;
};

interface InvalidationFixture {
  caseId: string;
  draftId: string;
  versionId: string;
  sectionIds: Record<string, string>; // "facts" → sectionId, "precedents" → sectionId, ...
  cleanup: () => Promise<void>;
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

/**
 * Create a real CaseWorkspace + LegalDraft + DraftVersion + a fixed set of
 * DraftSection rows whose `content.sourceIds` reference the specific source
 * ids we will invalidate. Each section is VERIFIED initially (we are
 * testing that markStaleAssertions downgrades them).
 */
async function createInvalidationFixture(
  suffix: string,
): Promise<InvalidationFixture> {
  const now = new Date();
  const caseRow = (await db.caseWorkspace.create({
    data: {
      title: `Invalidation Fixture [${suffix}]`,
      caseType: "CRIMINAL",
      jurisdiction: "ՀՀ Քրեական դատարան",
      court: "Երևանի ընդհանուր իրավասության դատարան",
      proceedingType: "FIRST_INSTANCE",
      status: "ACTIVE",
      documentCount: 0,
      pageCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  })) as CaseRow;

  const draftId = `inv-draft-${suffix}`;
  const versionId = `inv-version-${suffix}`;

  await db.legalDraft.create({
    data: {
      id: draftId,
      caseId: caseRow.id,
      documentType: "MOTION",
      title: `Motion for Release [${suffix}]`,
      status: "VERIFYING",
      language: "hy",
      parties: JSON.stringify(["Դատավոր Պողոսյան", "Դատախազ Սարգսյան"]),
      jurisdiction: "ՀՀ Քրեական դատարան",
      caseNumber: `YE/${suffix}/2024`,
      goal: "release from detention",
      requestedRelief: "release the defendant from detention",
      contextSummary: JSON.stringify({}),
      plan: JSON.stringify({}),
      createdAt: now,
      updatedAt: now,
    } as DraftRow,
  });

  await db.draftVersion.create({
    data: {
      id: versionId,
      draftId,
      version: 1,
      content: JSON.stringify([]),
      createdBy: "SYSTEM",
      verificationStatus: "VERIFIED",
      sourceIdMap: JSON.stringify({
        F1: { type: "fact", refId: "fact-a", citation: "Case Fact F1 (detention date)" },
        CE1: { type: "evidence", refId: "doc-1", citation: "Court Decision p.3" },
        L1: { type: "legislation", refId: "leg-215", citation: "Article 215 CrPC RA" },
        C1: { type: "cassation", refId: "cassation-1", citation: "Cassation Decision NԱ/1234/2022" },
        E1: { type: "echr", refId: "echr-1", citation: "ECtHR, Winterwerp v. Netherlands" },
        A1: { type: "argument", refId: "arg-1", citation: "Argument 1 (statutory max exceeded)" },
      }),
      createdAt: now,
      updatedAt: now,
    },
  });

  // §30 — Facts section citing F1.
  const factsSectionId = `inv-sec-facts-${suffix}`;
  // §31 — Evidence section citing CE1 (the supporting evidence for F1).
  const evidenceSectionId = `inv-sec-evidence-${suffix}`;
  // §32 — Applicable Law section citing L1.
  const lawSectionId = `inv-sec-law-${suffix}`;
  // §33 — Precedents section citing C1.
  const precedentsSectionId = `inv-sec-precedents-${suffix}`;
  // §34 — Arguments section citing A1 (which depends on E1 as a counter-authority).
  const argumentsSectionId = `inv-sec-arguments-${suffix}`;
  // A control section that cites NONE of the changed sources — must NOT be
  // marked stale by any of the invalidation runs (§29 — no spurious
  // invalidation).
  const controlSectionId = `inv-sec-control-${suffix}`;

  const makeSectionRow = (
    id: string,
    sectionType: string,
    title: string,
    text: string,
    sourceIds: string[],
  ) => ({
    id,
    draftId,
    versionId,
    sectionType,
    title,
    content: serializeContent({ text, sourceIds }),
    reviewStatus: "VERIFIED",
    stale: false,
    warnings: serializeWarnings([]),
    previousContent: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.draftSection.createMany({
    data: [
      makeSectionRow(
        factsSectionId,
        "facts",
        "Facts",
        "It is established that the defendant was detained on 15 March 2023 (F1). The detention exceeds the statutory maximum.",
        ["F1"],
      ),
      makeSectionRow(
        evidenceSectionId,
        "facts",
        "Supporting Evidence",
        "The detention is documented in the court decision at page 3 (CE1).",
        ["CE1"],
      ),
      makeSectionRow(
        lawSectionId,
        "applicable_law",
        "Applicable Law",
        "Article 215 CrPC RA requires release when the statutory maximum is exceeded (L1).",
        ["L1"],
      ),
      makeSectionRow(
        precedentsSectionId,
        "precedents",
        "Precedents",
        "The Cassation Court held that detention beyond the statutory maximum is unlawful (C1).",
        ["C1"],
      ),
      makeSectionRow(
        argumentsSectionId,
        "arguments",
        "Arguments",
        "The applicant's argument relies on the statutory maximum being exceeded (A1). A counter-authority (E1) is distinguished.",
        ["A1", "E1"],
      ),
      makeSectionRow(
        controlSectionId,
        "introduction",
        "Introduction",
        "This is a control section that cites no source ids. It must not be marked stale by any invalidation run.",
        [],
      ),
    ],
  });

  const cleanup = async () => {
    // §19 archive-first — for test fixtures we go straight to hard-delete
    // (the case is synthetic, no real data). Cascades to drafts / versions
    // / sections.
    try {
      await db.draftSection.deleteMany({ where: { draftId } });
    } catch {
      // ignore
    }
    try {
      await db.draftVersion.deleteMany({ where: { draftId } });
    } catch {
      // ignore
    }
    try {
      await db.legalDraft.deleteMany({ where: { id: draftId } });
    } catch {
      // ignore
    }
    try {
      await db.caseWorkspace.deleteMany({ where: { id: caseRow.id } });
    } catch {
      // ignore
    }
  };

  return {
    caseId: caseRow.id,
    draftId,
    versionId,
    sectionIds: {
      facts: factsSectionId,
      evidence: evidenceSectionId,
      law: lawSectionId,
      precedents: precedentsSectionId,
      arguments: argumentsSectionId,
      control: controlSectionId,
    },
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// §29-34 — Invalidation tests
// ---------------------------------------------------------------------------

describe("§29-§34 — Dependency invalidation tests", () => {
  let fixture: InvalidationFixture;

  beforeAll(async () => {
    // Single fixture shared across the 5 invalidation test cases — each
    // test invalidates a different source id and asserts the corresponding
    // section is downgraded. The control section is checked in every test
    // to confirm no spurious invalidation.
    fixture = await createInvalidationFixture("shared");
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  // §30 — Fact change
  test("§30 — Fact change F1 (DOCUMENT_VERIFIED → DISPUTED) invalidates the facts section", async () => {
    // Pre-condition: the facts section is VERIFIED + not stale.
    const before = await getSection(fixture.sectionIds.facts);
    expect(before).not.toBeNull();
    expect(before!.reviewStatus).toBe("VERIFIED");
    expect(before!.stale).toBe(false);

    // The user downgrades F1 to DISPUTED. Per §29 we MUST invalidate the
    // sections that cited F1.
    await markStaleAssertions(fixture.draftId, ["F1"]);

    const after = await getSection(fixture.sectionIds.facts);
    expect(after).not.toBeNull();
    // §29 CRITICAL: "Never leave VERIFIED badge when dependency changes."
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    expect(after!.stale).toBe(true);
    // Audit trail: a STALE_DUE_TO_SOURCE_CHANGE warning was appended with
    // the source id.
    const staleWarning = after!.warnings.find(
      (w) =>
        w.type === "STALE_DUE_TO_SOURCE_CHANGE" && w.sourceId === "F1",
    );
    expect(staleWarning).toBeDefined();
    expect(staleWarning!.detail).toContain("F1");

    // Control section: NOT marked stale (no spurious invalidation).
    const control = await getSection(fixture.sectionIds.control);
    expect(control!.reviewStatus).toBe("VERIFIED");
    expect(control!.stale).toBe(false);
  });

  // §31 — Evidence removal
  test("§31 — Evidence removal CE1 invalidates the evidence section", async () => {
    const before = await getSection(fixture.sectionIds.evidence);
    expect(before!.reviewStatus).toBe("VERIFIED");
    expect(before!.stale).toBe(false);

    // The operator removes the supporting evidence (CE1).
    await markStaleAssertions(fixture.draftId, ["CE1"]);

    const after = await getSection(fixture.sectionIds.evidence);
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    expect(after!.stale).toBe(true);
    const w = after!.warnings.find(
      (x) => x.type === "STALE_DUE_TO_SOURCE_CHANGE" && x.sourceId === "CE1",
    );
    expect(w).toBeDefined();

    // Control still untouched.
    const control = await getSection(fixture.sectionIds.control);
    expect(control!.reviewStatus).toBe("VERIFIED");
    expect(control!.stale).toBe(false);
  });

  // §32 — Law change
  test("§32 — Law change L1 (statute version amended) invalidates the legal section", async () => {
    const before = await getSection(fixture.sectionIds.law);
    expect(before!.reviewStatus).toBe("VERIFIED");
    expect(before!.stale).toBe(false);

    // The statute L1 is amended — invalidate sections citing L1.
    await markStaleAssertions(fixture.draftId, ["L1"]);

    const after = await getSection(fixture.sectionIds.law);
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    expect(after!.stale).toBe(true);
    const w = after!.warnings.find(
      (x) => x.type === "STALE_DUE_TO_SOURCE_CHANGE" && x.sourceId === "L1",
    );
    expect(w).toBeDefined();

    // Control still untouched.
    const control = await getSection(fixture.sectionIds.control);
    expect(control!.reviewStatus).toBe("VERIFIED");
    expect(control!.stale).toBe(false);
  });

  // §33 — Precedent applicability change
  test("§33 — Precedent applicability change C1 (DIRECT → NOT_APPLICABLE) invalidates the precedents section", async () => {
    const before = await getSection(fixture.sectionIds.precedents);
    expect(before!.reviewStatus).toBe("VERIFIED");
    expect(before!.stale).toBe(false);

    // The precedent's applicability verdict was revised.
    await markStaleAssertions(fixture.draftId, ["C1"]);

    const after = await getSection(fixture.sectionIds.precedents);
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    expect(after!.stale).toBe(true);
    const w = after!.warnings.find(
      (x) => x.type === "STALE_DUE_TO_SOURCE_CHANGE" && x.sourceId === "C1",
    );
    expect(w).toBeDefined();
  });

  // §34 — Counter-authority added after verification
  test("§34 — Counter-authority E1 added after verification invalidates the argument section", async () => {
    const before = await getSection(fixture.sectionIds.arguments);
    expect(before!.reviewStatus).toBe("VERIFIED");
    expect(before!.stale).toBe(false);

    // A new counter-authority E1 is added — the argument section that
    // cited E1 as a counter-authority must be re-evaluated.
    await markStaleAssertions(fixture.draftId, ["E1"]);

    const after = await getSection(fixture.sectionIds.arguments);
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    expect(after!.stale).toBe(true);
    const w = after!.warnings.find(
      (x) => x.type === "STALE_DUE_TO_SOURCE_CHANGE" && x.sourceId === "E1",
    );
    expect(w).toBeDefined();
  });

  // §25 — Idempotency
  test("§25 — markStaleAssertions is idempotent (running twice is a no-op)", async () => {
    // The facts section was already marked stale in §30. Running again
    // with the same source id should be a no-op (no duplicate warnings,
    // no exception, status remains NEEDS_SUPPORT / stale=true).
    const before = await getSection(fixture.sectionIds.facts);
    expect(before!.stale).toBe(true);
    expect(before!.reviewStatus).toBe("NEEDS_SUPPORT");
    const warningCountBefore = before!.warnings.filter(
      (w) => w.type === "STALE_DUE_TO_SOURCE_CHANGE" && w.sourceId === "F1",
    ).length;

    await markStaleAssertions(fixture.draftId, ["F1"]);
    await markStaleAssertions(fixture.draftId, ["F1"]); // second run

    const after = await getSection(fixture.sectionIds.facts);
    expect(after!.stale).toBe(true);
    expect(after!.reviewStatus).toBe("NEEDS_SUPPORT");
    const warningCountAfter = after!.warnings.filter(
      (w) => w.type === "STALE_DUE_TO_SOURCE_CHANGE" && w.sourceId === "F1",
    ).length;
    // No duplicate STALE warnings added.
    expect(warningCountAfter).toBe(warningCountBefore);
  });

  // §29 — No spurious invalidation
  test("§29 — Section NOT citing the changed source remains VERIFIED (no spurious invalidation)", async () => {
    // Invalidate L1 — should only affect the law section, NOT the facts /
    // precedents sections.
    // We use a fresh fixture here so the precondition is clean.
    const f = await createInvalidationFixture("no-spurious");
    try {
      // Pre-conditions.
      const lawBefore = await getSection(f.sectionIds.law);
      const factsBefore = await getSection(f.sectionIds.facts);
      const precedentsBefore = await getSection(f.sectionIds.precedents);
      expect(lawBefore!.reviewStatus).toBe("VERIFIED");
      expect(factsBefore!.reviewStatus).toBe("VERIFIED");
      expect(precedentsBefore!.reviewStatus).toBe("VERIFIED");

      await markStaleAssertions(f.draftId, ["L1"]);

      // Law section downgraded.
      const lawAfter = await getSection(f.sectionIds.law);
      expect(lawAfter!.reviewStatus).toBe("NEEDS_SUPPORT");
      expect(lawAfter!.stale).toBe(true);

      // Facts + precedents UNCHANGED.
      const factsAfter = await getSection(f.sectionIds.facts);
      const precedentsAfter = await getSection(f.sectionIds.precedents);
      expect(factsAfter!.reviewStatus).toBe("VERIFIED");
      expect(factsAfter!.stale).toBe(false);
      expect(precedentsAfter!.reviewStatus).toBe("VERIFIED");
      expect(precedentsAfter!.stale).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  // §29 — Empty changed-source list is a no-op
  test("§29 — markStaleAssertions with empty changed-source list is a no-op", async () => {
    const f = await createInvalidationFixture("empty");
    try {
      await markStaleAssertions(f.draftId, []);
      // No sections changed.
      const facts = await getSection(f.sectionIds.facts);
      expect(facts!.reviewStatus).toBe("VERIFIED");
      expect(facts!.stale).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  // §29 — Multiple-source invalidation in one call
  test("§29 — markStaleAssertions with multiple sources invalidates all dependent sections", async () => {
    const f = await createInvalidationFixture("multi");
    try {
      await markStaleAssertions(f.draftId, ["F1", "L1", "C1"]);

      const facts = await getSection(f.sectionIds.facts);
      const law = await getSection(f.sectionIds.law);
      const precedents = await getSection(f.sectionIds.precedents);
      // All three are stale.
      expect(facts!.reviewStatus).toBe("NEEDS_SUPPORT");
      expect(facts!.stale).toBe(true);
      expect(law!.reviewStatus).toBe("NEEDS_SUPPORT");
      expect(law!.stale).toBe(true);
      expect(precedents!.reviewStatus).toBe("NEEDS_SUPPORT");
      expect(precedents!.stale).toBe(true);

      // Control section still VERIFIED.
      const control = await getSection(f.sectionIds.control);
      expect(control!.reviewStatus).toBe("VERIFIED");
      expect(control!.stale).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
