// tests/helpers/stress-data-generator.ts
// Phase 5.1 §25 — Large-case stress harness data generator.
//
// Generates bulk SYNTHETIC case data DIRECTLY via Prisma — bypasses the
// full ingestion pipeline (no validateFile / no computeSha256 lookup /
// no parseDocument / no storage writes) so we can produce ~10,000 logical
// DocumentPage records in a few seconds.
//
// §25 — "Never claim 10,000 real PDF pages parsed if using logical records."
// The DocumentPage rows created here are LOGICAL records with realistic
// Armenian legal-style text content. They are NOT parsed from 10,000 real
// PDF files. Tests that consume this helper MUST assert against these
// logical records, not against parser-throughput claims.
//
// Each page contains ~500 chars of Armenian legal text including:
//   - Armenian-style dates (recognized by chronology extractor):
//       "15 հունվարի 2023" → EXACT date, ISO 2023-01-15
//   - Court names (recognized by entity extractor):
//       "Քրեական դատարան", "Վճռաբեկ դատարան", "դատարան"
//   - People roles (recognized by entity extractor):
//       "դատավոր", "դատախազ", "մեղադրյալ", "քննիչ", "փաստաբան"
//   - Fact keywords (recognized by fact extractor):
//       "խուզարկությունն իրականացվել է", "ձերբակալվել է",
//       "մեղադրանք առաջադրվել", "խոստովանել է"
//   - Claim keywords (recognized by claim extractor):
//       "դատարանը եզրակացնում է", "մեղադրյալը պնդում է",
//       "դատախազը նշում է"
//   - The common search keyword "դատարան" appears in nearly every page
//     so search queries for "դատարան" return realistic hit counts.
//
// Usage:
//   const { caseId, cleanup } = await generateStressCase(16, 40, 16);
//   // ... assertions ...
//   await cleanup(); // MUST call at the end — do not leave 10K pages in dev DB.

import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratedVolume {
  volumeId: string;
  documentIds: string[];
  pageCount: number;
}

export interface StressCaseHandle {
  caseId: string;
  volumeIds: string[];
  documentIds: string[];
  /** Total logical DocumentPage records generated for this case. */
  pageCount: number;
  /** Archive + hard-delete the case + all derived data + any storage. */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Armenian legal-style text generation
// ---------------------------------------------------------------------------

const ARM_MONTHS = [
  "հունվարի",
  "փետրվարի",
  "մարտի",
  "ապրիլի",
  "մայիսի",
  "հունիսի",
  "հուլիսի",
  "օգոստոսի",
  "սեպտեմբերի",
  "հոկտեմբերի",
  "նոյեմբերի",
  "դեկտեմբերի",
];

const COURTS = [
  "Քրեական դատարան",
  "Վճռաբեկ դատարան",
  "Առաջին ատյանի դատարան",
  "Վերաքննիչ դատարան",
  "Սահմանադրական դատարան",
];

const DEFENDANT_NAMES = [
  "Արամ Պողոսյան",
  "Դավիթ Խաչատրյան",
  "Տիգրան Ավետիսյան",
  "Նարեկ Գրիգորյան",
  "Սուրեն Մնացականյան",
];

const JUDGES = [
  "դատավոր Հովսեփյան",
  "դատավոր Աղաջանյան",
  "դատավոր Ստեփանյան",
  "դատավոր Կարապետյան",
];

const PROSECUTORS = [
  "դատախազ Մելիքյան",
  "դատախազ Հովհաննիսյան",
  "դատախազ Գևորգյան",
];

const INVESTIGATORS = [
  "քննիչ Վարդանյան",
  "քննիչ Պողոսյան",
  "քննիչ Մուրադյան",
];

const LAWYERS = [
  "փաստաբան Սարգսյան",
  "փաստաբան Նալբանդյան",
];

const FACT_SNIPPETS = [
  "խուզարկությունն իրականացվել է",
  "ձերբակալվել է",
  "մեղադրանք առաջադրվել",
  "խոստովանել է",
  "բռնագրավվել է",
  "ներկայացվել է դատարան",
];

const CLAIM_SNIPPETS = [
  "դատարանը եզրակացնում է",
  "դատարանը վճռեց",
  "մեղադրյալը պնդում է",
  "դատախազը նշում է",
  "պաշտպանը նշում է",
];

function deterministicDate(year: number, monthIdx: number, day: number): string {
  const m = String(monthIdx + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * Build ~500 chars of Armenian legal-style text for one page. The text
 * deterministically includes a date, court name, role keywords, fact
 * keywords, and claim keywords so that chronology/entity/fact/claim
 * extractors return realistic results, and search for "դատարան" returns
 * hits with documentId + pageNumber provenance.
 *
 * @param seed     numeric seed (typically the page index)
 * @param volumeNumber  volume number (1-16) — used to vary content across volumes
 */
function buildPageText(seed: number, volumeNumber: number): string {
  const monthIdx = (seed + volumeNumber) % 12;
  const armMonth = ARM_MONTHS[monthIdx];
  // Day: cycle 1..28 to stay in valid range.
  const day = ((seed % 28) + 1);
  const year = 2018 + ((volumeNumber + seed) % 6); // 2018..2023
  const iso = deterministicDate(year, monthIdx, day);

  const court = COURTS[(seed + volumeNumber) % COURTS.length]!;
  const defendant = DEFENDANT_NAMES[(seed * 7 + volumeNumber) % DEFENDANT_NAMES.length]!;
  const judge = JUDGES[(seed * 3 + volumeNumber) % JUDGES.length]!;
  const prosecutor = PROSECUTORS[(seed * 5 + volumeNumber) % PROSECUTORS.length]!;
  const investigator = INVESTIGATORS[(seed * 11 + volumeNumber) % INVESTIGATORS.length]!;
  const lawyer = LAWYERS[(seed * 13 + volumeNumber) % LAWYERS.length]!;
  const fact = FACT_SNIPPETS[(seed + volumeNumber) % FACT_SNIPPETS.length]!;
  const claim = CLAIM_SNIPPETS[(seed * 17 + volumeNumber) % CLAIM_SNIPPETS.length]!;

  // Compose ~500 chars of Armenian legal prose. The order matters: dates
  // at the start of sentences so the chronology extractor captures them
  // with realistic context windows.
  const lines: string[] = [
    `${day} ${armMonth} ${year}թ. ${court}-ում նիստ տեղի ունեցավ ${defendant}-ի գործով:`,
    `${judge}-ի նախագահությամբ նիստին մասնակցում էին ${prosecutor}-ը, ${lawyer}-ը և ${investigator}-ը:`,
    `Ատյանի դատարանը քննեց գործի նյութերը, որոնց համաձայն՝ ${fact}:`,
    `${claim}, որ ապացույցները բավարար են մեղադրանքը հաստատելու համար:`,
    `Դատարանի որոշմամբ նիստը հետաձգվեց հաջորդ ամսվա 15-ին:`,
    `ISO ${iso} ամսաթիվը համապատասխանում է դատական ակտի կնքման օրվան:`,
  ];
  const text = lines.join(" ");
  // Pad / trim to ~500 chars to keep SQLite text size predictable across pages.
  // 10,000 pages × 500 chars = ~5MB total text (manageable).
  if (text.length >= 500) return text.slice(0, 500);
  return text + " ".repeat(500 - text.length);
}

// ---------------------------------------------------------------------------
// Volume + document + page generator
// ---------------------------------------------------------------------------

/**
 * Create a CaseVolume + N CaseDocuments + M DocumentPages each, directly
 * via Prisma (bypasses the full ingestion pipeline for speed).
 *
 * §25 — logical records, NOT parsed from real PDFs. Each page carries
 * realistic Armenian legal-style text so search/chronology/fact/claim
 * queries return realistic results.
 *
 * @param caseId         Owning CaseWorkspace id
 * @param volumeNumber   1-indexed volume number
 * @param documentCount  How many CaseDocuments to create in this volume
 * @param pagesPerDoc    How many DocumentPage rows per CaseDocument
 */
export async function generateVolumeWithDocuments(
  caseId: string,
  volumeNumber: number,
  documentCount: number,
  pagesPerDoc: number,
): Promise<GeneratedVolume> {
  // 1. Create the volume.
  const volume = await db.caseVolume.create({
    data: {
      caseId,
      number: volumeNumber,
      title: `Volume ${volumeNumber} — Stress`,
      order: volumeNumber - 1,
    },
  });

  const documentIds: string[] = [];
  let pageCount = 0;

  // 2. For each document, create the CaseDocument row + its DocumentPage rows.
  //    Insert pages in chunks of 100 to keep SQLite parameter lists bounded
  //    (mirrors the registry's `insertDocumentPages` chunking).
  for (let d = 0; d < documentCount; d++) {
    const documentId = randomUUID();
    documentIds.push(documentId);

    // Synthetic but realistic document metadata. sha256 is unique per
    // (volume, doc) so dedup checks won't trigger across stress-generated
    // docs. storageKey is a synthetic placeholder — no actual file is
    // written (§25 — logical records, bypass ingestion).
    const sha256 = `stress-${caseId.slice(0, 12)}-v${volumeNumber}-d${d}-${randomUUID()}`;
    const storageKey = `stress/${caseId}/${documentId}/synthetic.txt`;

    await db.caseDocument.create({
      data: {
        id: documentId,
        caseId,
        volumeId: volume.id,
        originalFilename: `vol${volumeNumber}-doc${d + 1}.txt`,
        displayName: `Volume ${volumeNumber} Document ${d + 1}`,
        mimeType: "text/plain",
        sizeBytes: pagesPerDoc * 500, // approximate
        sha256,
        documentType: "OTHER",
        pageCount: pagesPerDoc,
        // Per §25 — stress-generated pages are LOGICAL records. Mark them
        // READY so §25.G (incremental re-processing) can verify old docs
        // STAY READY when a new volume is added.
        processingStatus: "READY",
        requiresOcr: false,
        storageKey,
      },
    });

    // 3. Chunked insert of DocumentPage rows for this document.
    const chunkSize = 100;
    const pages: Array<{
      documentId: string;
      pageNumber: number;
      originalText: string;
      normalizedText: string;
      extractionStatus: string;
    }> = [];
    for (let p = 0; p < pagesPerDoc; p++) {
      const seed = volumeNumber * 1000 + d * 100 + p;
      const text = buildPageText(seed, volumeNumber);
      pages.push({
        documentId,
        pageNumber: p + 1,
        originalText: text,
        normalizedText: text.replace(/\s+/g, " ").trim(),
        extractionStatus: "SUCCESS",
      });
    }
    for (let i = 0; i < pages.length; i += chunkSize) {
      const slice = pages.slice(i, i + chunkSize);
      await db.documentPage.createMany({ data: slice });
    }
    pageCount += pagesPerDoc;
  }

  return { volumeId: volume.id, documentIds, pageCount };
}

// ---------------------------------------------------------------------------
// Stress case generator
// ---------------------------------------------------------------------------

/**
 * Generate a full stress case:
 *   volumeCount volumes × docsPerVolume documents × pagesPerDoc pages each.
 *
 * §25 target: 16 volumes × 40 docs × 16 pages = ~10,240 logical pages.
 *
 * §25 — "Never claim 10,000 real PDF pages parsed if using logical records."
 * The returned `pageCount` is the count of LOGICAL DocumentPage records
 * generated directly via Prisma, NOT pages parsed from real PDFs.
 *
 * @returns handle with caseId + cleanup function. The cleanup archives
 *          storage (best-effort) + hard-deletes the case row (cascades
 *          to ALL derived data — CaseVolume / CaseDocument / DocumentPage /
 *          CaseJob / ChronologyEvent / CaseEntity / CaseFact /
 *          CaseEvidenceLink / CaseClaim / CaseContradiction /
 *          LegalIssueLink / CaseAnalysisResult).
 */
export async function generateStressCase(
  volumeCount: number,
  docsPerVolume: number,
  pagesPerDoc: number,
): Promise<StressCaseHandle> {
  // Create the case.
  const caseRow = await db.caseWorkspace.create({
    data: {
      title: `Stress Case ${volumeCount}v×${docsPerVolume}d×${pagesPerDoc}p`,
      caseNumber: `STRESS-${volumeCount}-${docsPerVolume}-${pagesPerDoc}`,
      caseType: "CRIMINAL",
      status: "ACTIVE",
    },
  });
  const caseId = caseRow.id;

  const volumeIds: string[] = [];
  const documentIds: string[] = [];
  let pageCount = 0;

  // Generate each volume.
  for (let v = 0; v < volumeCount; v++) {
    const vol = await generateVolumeWithDocuments(
      caseId,
      v + 1,
      docsPerVolume,
      pagesPerDoc,
    );
    volumeIds.push(vol.volumeId);
    documentIds.push(...vol.documentIds);
    pageCount += vol.pageCount;
  }

  // Update denormalized counts on the case row (mirrors what
  // ingestDocument would have done).
  await db.caseWorkspace.update({
    where: { id: caseId },
    data: {
      documentCount: documentIds.length,
      pageCount,
    },
  });

  // Cleanup: archive-first per §19, then hard-delete (cascades).
  // Both steps are best-effort so a partial-state case can still be cleaned
  // up if an earlier step left it half-created.
  const cleanup = async (): Promise<void> => {
    // 1. Try to archive storage (best-effort — the generator didn't write
    //    real storage bytes, but §25.G's incremental test did via
    //    ingestDocument). Silent on missing dirs.
    try {
      const { archiveCaseStorage, purgeCaseStorage } = await import(
        "@/lib/case-workspace/documents/storage"
      );
      await archiveCaseStorage(caseId).catch(() => {});
      await purgeCaseStorage(caseId).catch(() => {});
    } catch {
      // storage module not loadable — non-fatal.
    }
    // 2. Hard-delete the case row. The Prisma schema's onDelete: Cascade
    //    relations ensure all derived rows (volumes, documents, pages,
    //    jobs, chronology, entities, facts, evidence links, claims,
    //    contradictions, issue links, analysis results) are removed.
    try {
      await db.caseWorkspace.delete({ where: { id: caseId } });
    } catch {
      // Already gone — nothing to do.
    }
  };

  return {
    caseId,
    volumeIds,
    documentIds,
    pageCount,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export { buildPageText as _buildPageTextForTest };
