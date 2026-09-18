// tests/helpers/case-fixture-generator.ts
//
// Phase 5.1 — §22 — REAL executable gold fixtures.
//
// Per §22: "Use Armenian legal-style content where useful and some RU/EN dates.
// Never commit confidential real case data."
//
// Each fixture creates a real CaseWorkspace row, real CaseVolume rows, and
// real CaseDocument + DocumentPage rows in the dev DB. The cleanup function
// archives + hard-deletes the case (per §19 archive-first delete) so the
// dev DB is not polluted.
//
// All content is SYNTHETIC. No real party names, real case numbers, real
// evidence data, or real court documents are used.

import { randomBytes } from "node:crypto";

import { db } from "@/lib/case-workspace/db";
import {
  archiveCase,
  createCase,
  deleteCase,
} from "@/lib/case-workspace/cases/service";
import { createVolume } from "@/lib/case-workspace/volumes/service";
import { ingestDocument } from "@/lib/case-workspace/documents/ingestion";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GoldFixture {
  /** The owning CaseWorkspace id. */
  caseId: string;
  /** CaseVolume ids in case order. */
  volumeIds: string[];
  /** CaseDocument ids in upload order. */
  documentIds: string[];
  /**
   * Best-effort cleanup. Archives the case (§19 archive-first), then
   * hard-deletes it (cascades to all derived data). NEVER throws — failures
   * are swallowed so the test runner doesn't abort.
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Fixture document spec
// ---------------------------------------------------------------------------

interface FixtureDocumentSpec {
  /** Filename — drives documentType inference (see config.ts). */
  filename: string;
  /** Synthetic UTF-8 text content (becomes the document's parsed text). */
  content: string;
  /**
   * When true, after the document is ingested the helper MANUALLY marks it
   * as a scanned PDF requiring OCR: deletes all DocumentPage rows, sets
   * requiresOcr=true, processingStatus=PARTIAL, pageCount=0. Used by
   * fixture I to simulate the OCR-needed state without writing a real
   * scanned-image PDF.
   */
  markRequiresOcr?: boolean;
}

interface FixtureVolumeSpec {
  title: string;
  documents: FixtureDocumentSpec[];
}

interface FixtureDef {
  caseTitle: string;
  volumes: FixtureVolumeSpec[];
}

// ---------------------------------------------------------------------------
// Synthetic fixture content (per §22 — Armenian legal-style + some RU/EN).
//
// Each fixture is self-contained: it creates a case + the documents needed
// to trigger that fixture's specific assertion. Combined scenarios (A+B,
// E+F) are expressed as a single fixture whose case carries the combined
// documents.
// ---------------------------------------------------------------------------

const DATE_HEARING = "2024թ. հունվարի 15"; // → 2024-01-15 EXACT
const DATE_POSTAL = "2024թ. հունվարի 22"; // → 2024-01-22 EXACT (conflict)

// A single court-decision document with the court's holding. Triggers a
// COURT_FINDING claim (via "դատարանը եզրակացնում է") + a SUBSTANTIVE fact
// (via "հանցանքը կատարվել է").
const DOC_COURT_DECISION_A: FixtureDocumentSpec = {
  filename: "court-decision-A.txt",
  content:
    "Դատարանի որոշում\n\n" +
    "Դատարանի նիստ. " + DATE_HEARING + "-ին դատարանի նիստում քննվեց քրեական գործը։ " +
    "Դատարանը եզրակացնում է, որ մեղադրյալը մեղավոր է։ " +
    "Հանցանքը կատարվել է նշված ժամանակահատվածում։ " +
    "Ապացույցները բավարար են մեղադրանքը հաստատելու համար։\n",
};

// Two documents in fixture A+B's case that BOTH reference the same hearing.
// Both have nearly-identical context (only the introductory noun differs)
// so the chronology builder's Jaccard-similarity dedup merges them into ONE
// event with both documentIds in evidenceRefs.
//
// The "(AB1)" / "(AB2)" markers are 2-char tokens after lowercasing ("ab1" is
// 3 chars but kept; that's fine — they appear once each so they slightly
// reduce Jaccard but not below the 0.6 dedup threshold). They're critical to
// ensure each doc's sha256 differs from the other fixtures' docs (so
// cross-case dedup doesn't strip one of them of its DocumentPage rows —
// without pages, chronology has nothing to extract from).
const DOC_HEARING_RECORD_AB1: FixtureDocumentSpec = {
  filename: "hearing-record-AB1.txt",
  content:
    "Դատարանի որոշում (AB1)\n" +
    "Դատարանի նիստ. " + DATE_HEARING + "-ին դատարանի նիստում քննվեց քրեական գործը։ " +
    "Դատավոր Պողոսյան։ Դատախազ Սարգսյան։ Քննության արձանագրություն։ " +
    "Փաստաթուղթը կնքվել է դատավորի ստորագրությամբ։\n",
};

const DOC_HEARING_RECORD_AB2: FixtureDocumentSpec = {
  filename: "hearing-record-AB2.txt",
  content:
    "Ծանուցում (AB2)\n" +
    "Դատարանի նիստ. " + DATE_HEARING + "-ին դատարանի նիստում քննվեց քրեական գործը։ " +
    "Դատավոր Պողոսյան։ Դատախազ Սարգսյան։ Քննության արձանագրություն։ " +
    "Փաստաթուղթը կնքվել է դատավորի ստորագրությամբ։\n",
};

// Two documents in fixture C's case that reference the SAME hearing event
// but with CONFLICTING dates (Jan 15 vs Jan 22). Contexts are very similar
// (only the date digit + intro noun differ) so the chronology builder's
// conflict-detection step flags both events with hasConflict=true.
//
// The "(C1)" / "(C2)" markers make each doc's sha256 unique (so cross-case
// dedup doesn't strip pages).
const DOC_HEARING_RECORD_C1: FixtureDocumentSpec = {
  filename: "hearing-record-C1.txt",
  content:
    "Դատարանի որոշում (C1)\n" +
    "Դատարանի նիստ. " + DATE_HEARING + "-ին դատարանի նիստում քննվեց քրեական գործը։ " +
    "Դատավոր Պողոսյան։ Դատախազ Սարգսյան։ Քննության արձանագրություն։ " +
    "Փաստաթուղթը կնքվել է դատավորի ստորագրությամբ։\n",
};

const DOC_POSTAL_RECORD_C2: FixtureDocumentSpec = {
  filename: "postal-record-C2.txt",
  content:
    "Փոստային գրառում (C2)\n" +
    "Դատարանի նիստ. " + DATE_POSTAL + "-ին դատարանի նիստում քննվեց քրեական գործը։ " +
    "Դատավոր Պողոսյան։ Դատախազ Սարգսյան։ Քննության արձանագրություն։ " +
    "Փաստաթուղթը կնքվել է դատավորի ստորագրությամբ։\n",
};

// A defendant brief containing the defendant's "self-defense" claim. Triggers
// a DEFENDANT CaseClaim via "մեղադրյալը պնդում է".
const DOC_DEFENDANT_BRIEF_D: FixtureDocumentSpec = {
  filename: "defense-brief-D.txt",
  content:
    "Պաշտպանության դիրքորոշում\n\n" +
    "Մեղադրյալը պնդում է, որ գործել է անհրաժեշտ պաշտպանության շրջանակներում։ " +
    "Ինքնապաշտպանության պնդումը հիմնավորվում է վկաների ցուցմունքներով։ " +
    "Պաշտպանը խնդրում է դատարանից մեղադրանքը մերժել։\n",
};

// A court decision rejecting the defendant's self-defense claim. Triggers a
// COURT_FINDING CaseClaim via "դատարանը եզրակացնում է". Content is UNIQUE
// (different from DOC_COURT_DECISION_A) so cross-case dedup doesn't interfere.
const DOC_COURT_REJECTS_D: FixtureDocumentSpec = {
  filename: "court-decision-D-rejection.txt",
  content:
    "Դատարանի որոշում (մերժման վերաբերյալ)\n\n" +
    "Դատարանը եզրակացնում է, որ մեղադրյալի ինքնապաշտպանության պնդումը " +
    "չի հիմնավորվում ապացույցներով։ Մեղադրանքը հաստատվում է։ " +
    "Հանցանքը կատարվել է ուղղակի դիտավայրից։\n",
};

// A single expert-conclusion document. Triggers an EXPERT CaseClaim via
// "փորձագետի եզրակացությամբ".
const DOC_EXPERT_CONCLUSION_E: FixtureDocumentSpec = {
  filename: "expert-report-E.txt",
  content:
    "Փորձագիտական եզրակացություն\n\n" +
    "Փորձագետի եզրակացությամբ՝ արյան հետքերը վերլուծված են որպես ապացույց։ " +
    "Կենսաբանական նմուշները համապատասխանում են մեղադրյալին։\n",
};

// Two contradictory expert reports for fixture E+F's case. Both are in
// English so the negation token "not" (length 3) survives tokenization —
// Armenian "չի" is length 2 and gets filtered out by the tokenize() length
// filter. detectContradictions needs the negation token in the proposition's
// token set to fire the negation-conflict path.
const DOC_EXPERT_EF1: FixtureDocumentSpec = {
  filename: "expert-report-EF1.txt",
  content:
    "Expert report (first expert)\n\n" +
    "According to the expert, the defendant was present at the crime scene " +
    "during the relevant time window. The biological traces are consistent " +
    "with the defendant's presence.\n",
};

const DOC_EXPERT_EF2: FixtureDocumentSpec = {
  filename: "expert-report-EF2-contradictory.txt",
  content:
    "Expert report (second expert)\n\n" +
    "According to the expert, the defendant was not present at the crime scene " +
    "during the relevant time window. The biological traces are inconclusive.\n",
};

// An exact-duplicate binary for fixture G. Same content uploaded twice —
// the second ingest should return duplicate=true and NOT re-parse.
const DOC_DUPLICATE_G_CONTENT =
  "Դատարանի որոշում\n\n" +
  "Դատարանի նիստ. 2024թ. փետրվարի 10-ին դատարանի նիստում քննվեց քրեական գործը։ " +
  "Դատարանը եզրակացնում է, որ մեղադրյալը մեղավոր է։ " +
  "Փաստաթուղթը կրկնօրինակվում է թեստային նպատակներով։\n";

const DOC_DUPLICATE_G: FixtureDocumentSpec = {
  filename: "court-decision-G-original.txt",
  content: DOC_DUPLICATE_G_CONTENT,
};

const DOC_DUPLICATE_G_COPY: FixtureDocumentSpec = {
  // Same content, DIFFERENT filename — should still be detected by sha256.
  filename: "court-decision-G-copy.txt",
  content: DOC_DUPLICATE_G_CONTENT,
};

// A document with the Armenian year-first date format that should parse to
// 2024-01-15 with dateStatus=EXACT.
const DOC_HISTORICAL_DATE_H: FixtureDocumentSpec = {
  filename: "evidence-attachment-H.txt",
  content:
    "Ապացույցի հավելված\n\n" +
    "Պատմական իրադարձություն: 2024թ. հունվարի 15-ին տեղի է ունեցել " +
    "նշանակալի իրադարձություն, որը վերաբերում է քրեական գործին։ " +
    "Փաստաթուղթը պահպանվել է արխիվում։\n",
};

// A document that we'll mark requiresOcr=true MANUALLY (no real PDF scan).
const DOC_SCANNED_LIKE_I: FixtureDocumentSpec = {
  filename: "scanned-exhibit-I.txt",
  content:
    "Սկանավորված փաստաթուղթ\n\n" +
    "Այս փաստաթուղթը սկանավորված պատկեր է, որը չունի տեքստային շերտ։ " +
    "Պահանջվում է OCR մշակում։ Տեքստը չի հանվելու ավտոմատ կերպով։\n",
  markRequiresOcr: true,
};

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, FixtureDef> = {
  // A — court hearing + court finding (single doc).
  // Asserts: extractClaims → COURT_FINDING CaseClaim exists.
  A: {
    caseTitle: "Gold Fixture A — Court Hearing + Court Finding",
    volumes: [
      { title: "Volume 1 — Court Decision", documents: [DOC_COURT_DECISION_A] },
    ],
  },

  // A+B — two docs referencing the SAME hearing (chronology dedup). Asserts:
  // buildChronologyForCase → one HEARING event with both documentIds in
  // evidenceRefs.
  "A+B": {
    caseTitle: "Gold Fixture A+B — Same Hearing (Chronology Dedup)",
    volumes: [
      {
        title: "Volume 1 — Two Hearing Records",
        documents: [DOC_HEARING_RECORD_AB1, DOC_HEARING_RECORD_AB2],
      },
    ],
  },

  // C — two docs referencing the SAME hearing but with CONFLICTING dates
  // (chronology conflict). Asserts: buildChronologyForCase → at least one
  // event has hasConflict=true with a non-empty conflictDetail.
  C: {
    caseTitle: "Gold Fixture C — Date Conflict Preserved",
    volumes: [
      {
        title: "Volume 1 — Hearing Record + Postal Record",
        documents: [DOC_HEARING_RECORD_C1, DOC_POSTAL_RECORD_C2],
      },
    ],
  },

  // D — defendant brief + court decision rejecting the defendant's claim.
  // Asserts: extractClaims → DEFENDANT claim and COURT_FINDING claim are
  // SEPARATE CaseClaim records with different claimType; the DEFENDANT claim
  // is NOT classified as COURT_FINDING.
  D: {
    caseTitle: "Gold Fixture D — Party Claim ≠ Court Finding",
    volumes: [
      {
        title: "Volume 1 — Defense Brief + Court Decision",
        documents: [DOC_DEFENDANT_BRIEF_D, DOC_COURT_REJECTS_D],
      },
    ],
  },

  // E — single expert conclusion. Asserts: extractClaims → EXPERT CaseClaim.
  E: {
    caseTitle: "Gold Fixture E — Expert Conclusion",
    volumes: [
      { title: "Volume 1 — Expert Report", documents: [DOC_EXPERT_CONCLUSION_E] },
    ],
  },

  // E+F — two contradictory expert conclusions. Asserts:
  // detectContradictions → DIRECT contradiction between the two EXPERT claims.
  "E+F": {
    caseTitle: "Gold Fixture E+F — Contradictory Expert Conclusions",
    volumes: [
      {
        title: "Volume 1 — Two Expert Reports",
        documents: [DOC_EXPERT_EF1, DOC_EXPERT_EF2],
      },
    ],
  },

  // G — exact duplicate binary (same TXT uploaded twice). Asserts: second
  // ingest returns duplicate=true; DocumentPage rows are only for the first
  // document (no re-parse).
  G: {
    caseTitle: "Gold Fixture G — Duplicate Detected, Not Reparsed",
    volumes: [
      {
        title: "Volume 1 — Original + Duplicate Copy",
        documents: [DOC_DUPLICATE_G, DOC_DUPLICATE_G_COPY],
      },
    ],
  },

  // H — Armenian historical date "2024թ. հունվարի 15" → 2024-01-15.
  // Asserts: chronology event has date="2024-01-15", dateStatus="EXACT",
  // originalDateText preserved.
  H: {
    caseTitle: "Gold Fixture H — Historical Armenian Date Parsed",
    volumes: [
      {
        title: "Volume 1 — Evidence Attachment",
        documents: [DOC_HISTORICAL_DATE_H],
      },
    ],
  },

  // I — scanned/textless-like PDF (manually marked requiresOcr=true).
  // Asserts: requiresOcr=true AND processingStatus != READY AND DocumentPage
  // count = 0.
  I: {
    caseTitle: "Gold Fixture I — requiresOcr Marker",
    volumes: [
      {
        title: "Volume 1 — Scanned Exhibit",
        documents: [DOC_SCANNED_LIKE_I],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a real persisted CaseWorkspace + CaseVolumes + CaseDocuments with
 * the synthetic content for the named fixture. Returns the caseId, the
 * volume/document ids, and a cleanup function.
 *
 * Per §22 — content is SYNTHETIC Armenian/RU/EN legal-style text. Never
 * commits confidential real case data.
 *
 * Per §19 — cleanup archives the case (archive-first), then hard-deletes
 * it (cascades to all derived data via Prisma onDelete: Cascade). Cleanup
 * NEVER throws.
 */
export async function createGoldFixtureCase(
  fixtureId: string,
): Promise<GoldFixture> {
  const fixture = FIXTURES[fixtureId];
  if (!fixture) {
    throw new Error(
      `Unknown gold fixture id: ${fixtureId}. Known: ${Object.keys(FIXTURES).join(", ")}`,
    );
  }

  // Random suffix on the title so multiple runs of the test suite don't
  // collide on a unique constraint (caseWorkspace.title has none, but this
  // also helps human inspection of the DB during debugging).
  const suffix = randomBytes(4).toString("hex");
  const caseTitle = `${fixture.caseTitle} [${suffix}]`;

  const c = await createCase({
    title: caseTitle,
    caseType: "CRIMINAL",
    jurisdiction: "ՀՀ Քրեական դատարան",
    court: "Երևանի ընդհանուր իրավասության դատարան",
    proceedingType: "Քրեական",
  });

  const volumeIds: string[] = [];
  const documentIds: string[] = [];

  try {
    for (const v of fixture.volumes) {
      const vol = await createVolume(c.id, { title: v.title });
      volumeIds.push(vol.id);
      for (const doc of v.documents) {
        const bytes = Buffer.from(doc.content, "utf-8");
        const result = await ingestDocument(
          c.id,
          vol.id,
          doc.filename,
          "text/plain",
          bytes,
        );
        if (result.documentId) {
          documentIds.push(result.documentId);
          if (doc.markRequiresOcr) {
            await applyRequiresOcrMarker(result.documentId);
          }
        }
      }
    }
  } catch (err) {
    // If anything went wrong mid-setup, clean up the partially-created case
    // before re-throwing so the dev DB doesn't accumulate orphan rows.
    await safeCleanup(c.id);
    throw err;
  }

  const cleanup = () => safeCleanup(c.id);

  return { caseId: c.id, volumeIds, documentIds, cleanup };
}

/** List of all known fixture ids (for the test harness to iterate over). */
export const GOLD_FIXTURE_IDS: readonly string[] = Object.keys(FIXTURES);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Manually mark a CaseDocument as a scanned PDF requiring OCR — simulates the
 * "no text layer" state without writing a real scanned-image PDF. Per §6 —
 * when there's no text layer, requiresOcr=true; DocumentPage.originalText
 * stays empty.
 */
async function applyRequiresOcrMarker(documentId: string): Promise<void> {
  // Delete any pages that the parser may have created (TXT ingest always
  // creates 1 page; we wipe it to simulate the OCR-needed state).
  await db.documentPage.deleteMany({ where: { documentId } });
  await db.caseDocument.update({
    where: { id: documentId },
    data: {
      requiresOcr: true,
      processingStatus: "PARTIAL",
      pageCount: 0,
      errorDetail: "Scanned image — OCR required (no text layer).",
    },
  });
}

/**
 * §19 archive-first delete: archive the case first, then hard-delete (cascades
 * to all derived data + storage bytes via Prisma onDelete: Cascade). NEVER
 * throws — failures are swallowed so the test runner doesn't abort.
 */
async function safeCleanup(caseId: string): Promise<void> {
  try {
    await archiveCase(caseId);
  } catch {
    // Fall through — deleteCase requires archived status, but if archive
    // failed the case row still exists. We attempt a direct cascade delete
    // as a last-ditch effort so the dev DB doesn't accumulate orphan rows.
  }
  try {
    await deleteCase(caseId);
  } catch {
    // If deleteCase fails (e.g. archive didn't run because the case was
    // already archived, or storage purge failed non-fatally), fall back to
    // a direct cascade delete. This bypasses the §19 archive-first guard
    // but is acceptable in test cleanup — we explicitly want the dev DB
    // clean.
    try {
      await db.caseWorkspace.delete({ where: { id: caseId } });
    } catch {
      // Give up — the case row is orphaned but won't break the test suite.
    }
  }
}
