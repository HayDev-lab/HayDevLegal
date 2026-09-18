// src/lib/case-workspace/evaluation/case-gold-set.ts
// Gold fixtures for Case Workspace hard-assertion evaluation (Phase 5 §20).
//
// 16 fixture DESCRIPTORS (not test data) — each describes the scenario,
// the setup steps the test harness performs, and the assertions the test
// must check. The harness generates actual Prisma rows from the descriptor.
//
// Every fixture maps to a §20 correctness rule and to a hard-assertion in
// `evaluator.ts`. The fixture id matches the assertion name where one-to-one
// (e.g. fixture 1 → `provenance_loss = 0`).
//
// §20 — "live gate" fixtures (fixture 16 — Codex closed-evidence analysis
// when quota returns) MUST be skipped when Codex is AUTH_REQUIRED today.
// The harness detects this via the run's status and skips the fixture
// (per §25 — never block Phase 5 on a Codex quota state).

import type { CaseGoldFixture } from "../research/types";

// ---------------------------------------------------------------------------
// 16 gold fixtures
// ---------------------------------------------------------------------------

export const CASE_GOLD_FIXTURES: readonly CaseGoldFixture[] = [
  {
    id: "G1-duplicate-document-same-sha256",
    name: "Duplicate document (same SHA-256)",
    description:
      "Two uploads with identical content arrive. The ingestion layer must detect the duplicate by SHA-256 and skip re-parsing the second copy.",
    setupSteps: [
      "Create a case workspace.",
      "Upload document A (PDF with 3 pages, sha256 = X).",
      "Upload document B with identical bytes (same sha256 = X) but a different filename.",
      "Wait for both CaseJob rows to settle.",
    ],
    assertions: [
      "CaseDocument count for the case = 1 (the second upload is a duplicate, not a new row, OR is recorded as DUPLICATE_SKIP without page re-extraction).",
      "No DocumentPage row references the duplicate's id (the parser is not re-invoked).",
      "CaseJob for the duplicate has status COMPLETED with progressCurrent == 0 (no work done).",
    ],
  },
  {
    id: "G2-same-hearing-multiple-docs-chronology-dedup",
    name: "Same hearing in multiple documents (chronology dedup)",
    description:
      "Three documents reference the same hearing (same date + judge + case-section). The chronology builder must deduplicate to ONE event, not three.",
    setupSteps: [
      "Upload three documents where each references the 2023-09-15 hearing before Judge X.",
      "Run the chronology builder.",
    ],
    assertions: [
      "Exactly one ChronologyEvent row with date='2023-09-15' and eventType='HEARING'.",
      "The event's evidenceRefs array references all three documents (multi-provenance).",
      "verification='DOCUMENT_VERIFIED' (three independent sources confirm the event).",
    ],
  },
  {
    id: "G3-conflicting-dates-chronology-conflict",
    name: "Conflicting dates (chronology conflict marker)",
    description:
      "Two documents reference the same hearing but disagree on the date (one says 2023-09-15, the other 2023-09-22). The chronology MUST surface the conflict, not silently pick one date.",
    setupSteps: [
      "Upload document A referencing hearing on 2023-09-15.",
      "Upload document B referencing the same hearing but with date 2023-09-22.",
      "Run the chronology builder.",
    ],
    assertions: [
      "At least one ChronologyEvent has hasConflict=true and a non-empty conflictDetail.",
      "The conflictDetail mentions both candidate dates.",
      "verification='DISPUTED' (multi-source disagreement).",
    ],
  },
  {
    id: "G4-party-claim-rejected-court-claim-separation",
    name: "Party claim rejected by court (claim separation)",
    description:
      "The defendant claims self-defense. The court decision document rejects that claim. The system MUST keep the defendant's claim as CaseClaim(claimType=DEFENDANT) and the court's rejection as CaseClaim(claimType=COURT_FINDING) — never promote the defendant's claim to a court holding.",
    setupSteps: [
      "Upload a defense brief with the defendant's self-defense claim.",
      "Upload a court decision rejecting self-defense.",
      "Run the claim extractor.",
    ],
    assertions: [
      "A CaseClaim row exists with claimType='DEFENDANT' and proposition containing 'self-defense'.",
      "A CaseClaim row exists with claimType='COURT_FINDING' rejecting the self-defense claim.",
      "No CaseClaim row with claimType='COURT_FINDING' has a source whose documentType is INDICTMENT or DEFENSE_BRIEF.",
    ],
  },
  {
    id: "G5-supporting-and-contradicting-evidence-fact-disputed",
    name: "Supporting + contradicting evidence → fact DISPUTED",
    description:
      "A fact has both supporting and contradicting evidence. The fact matrix MUST mark the status as DISPUTED, not VERIFIED.",
    setupSteps: [
      "Upload document A supporting fact F (e.g. 'defendant was at location X').",
      "Upload document B contradicting fact F (e.g. 'defendant was at location Y').",
      "Run the fact matrix builder.",
    ],
    assertions: [
      "A CaseFact row exists for F with status='DISPUTED'.",
      "supportingEvidence.length > 0 AND contradictingEvidence.length > 0.",
      "materiality is HIGH (the contradiction is material).",
    ],
  },
  {
    id: "G6-ambiguous-entity-names-resolver-no-merge",
    name: "Ambiguous entity names (entity resolver doesn't merge)",
    description:
      "Two different people share the surname 'Պողոսյան'. One is the defendant (Armen), the other is a witness (David). The entity resolver MUST NOT merge them into a single CaseEntity.",
    setupSteps: [
      "Upload a document where 'Պողոսյան Արմեն' is mentioned as the defendant.",
      "Upload a document where 'Պողոսյան Դավիթ' is mentioned as a witness.",
      "Run the entity resolver.",
    ],
    assertions: [
      "Two distinct CaseEntity rows exist (canonicalName='Պողոսյան Արմեն' and canonicalName='Պողոսյան Դավիթ').",
      "No CaseEntity has both names as aliases of a single canonical name.",
      "Each entity's evidenceRefs points to its own document of origin.",
    ],
  },
  {
    id: "G7-historical-law-version-temporal-context",
    name: "Historical law / version issue (research with temporal context)",
    description:
      "The case events happened in 2018, but the relevant statute was amended in 2021. Federated research MUST not silently apply the 2021 version to the 2018 events — the temporal validator flags the version mismatch.",
    setupSteps: [
      "Create a case with a 2018 chronology event.",
      "Create a LegalIssueLink referencing a statute.",
      "Run researchIssueForCase — the federated engine retrieves both the 2018 and 2021 versions.",
    ],
    assertions: [
      "The LegalIssueLink.relatedLaw entries include the 2018 version.",
      "If the 2021 version is also surfaced, the temporal validator flags it as POTENTIALLY_STALE or INCOMPATIBLE for this case's timeline.",
      "The research report's temporal.compatibility is NOT COMPATIBLE for the 2021 version when the case events predate the amendment.",
    ],
  },
  {
    id: "G8-fact-no-evidence-unknown",
    name: "Fact with no evidence (status UNKNOWN)",
    description:
      "A fact is alleged by the user but has no supporting evidence in the uploaded documents. The fact matrix MUST mark it as UNKNOWN (or ALLEGED), never VERIFIED.",
    setupSteps: [
      "Create a user-entered CaseFact with no supporting evidence refs.",
      "Run the fact matrix builder.",
    ],
    assertions: [
      "The CaseFact has status='ALLEGED' (or 'UNKNOWN').",
      "supportingEvidence is empty.",
      "source='USER' (preserved provenance — this is a user allegation, not a finding).",
    ],
  },
  {
    id: "G9-scanned-pdf-requires-ocr",
    name: "Scanned PDF requiring OCR",
    description:
      "A scanned-image PDF (no extractable text). The ingestion layer MUST set requiresOcr=true and NOT hallucinate text — DocumentPage.originalText stays empty.",
    setupSteps: [
      "Upload a scanned-image PDF (pages are bitmaps).",
      "Run the ingestion parser.",
    ],
    assertions: [
      "CaseDocument.requiresOcr = true.",
      "DocumentPage.originalText is empty for every page.",
      "extractionStatus = 'REQUIRES_OCR' (not FAILED — the system is honest about why).",
      "processingStatus = 'PARTIAL' or 'EXTRACTED' (not READY — OCR is pending).",
    ],
  },
  {
    id: "G10-16-volume-synthetic-case-scale",
    name: "16-volume synthetic case (scale)",
    description:
      "A case with 16 volumes and ≥10,000 pages. The system MUST ingest, build chronology, fact matrix, and search without OOM and within a bounded wall-clock time.",
    setupSteps: [
      "Create a case workspace.",
      "Create 16 volumes.",
      "Upload ≥10 synthetic PDFs (1000 pages each) distributed across the volumes.",
      "Run the full ingestion + analysis pipeline.",
    ],
    assertions: [
      "All CaseDocument rows reach processingStatus='READY' (or PARTIAL when OCR is required).",
      "DocumentPage count ≈ 10,000 (within ±10 for synthetic variance).",
      "The full pipeline completes within 30 minutes (the harness enforces this).",
      "Memory usage stays bounded (no unbounded map growth in the ingestion worker).",
    ],
  },
  {
    id: "G11-incremental-upload-no-reprocess",
    name: "Incremental upload of new volume (no reprocess)",
    description:
      "After 16 volumes are fully processed, the user uploads volume 17. The system MUST NOT re-parse any of the unchanged volumes 1-16 — only volume 17 is processed.",
    setupSteps: [
      "Run fixture G10 (16 volumes fully processed).",
      "Upload volume 17 (a new PDF).",
      "Observe the CaseJob queue.",
    ],
    assertions: [
      "Only one new CaseJob is created (jobType='INGEST', documentIds=[new volume's document ids]).",
      "No CaseJob row references the unchanged volumes' documentIds.",
      "All 16 volumes' processingStatus remains 'READY' (not touched).",
    ],
  },
  {
    id: "G12-interrupted-resumed-ingestion",
    name: "Interrupted / resumed ingestion (job resume)",
    description:
      "Ingestion fails at document 37/100 (simulated worker crash). The resume logic MUST pick up from document 38, not restart from document 1.",
    setupSteps: [
      "Create a case with 100 documents queued for ingestion.",
      "Simulate a crash after document 37 completes.",
      "Trigger resume.",
    ],
    assertions: [
      "The resumed CaseJob has progressCurrent=37 at resume time.",
      "After resume, documents 38-100 reach processingStatus='READY'.",
      "Documents 1-37 retain their READY status (not reprocessed).",
    ],
  },
  {
    id: "G13-exact-page-provenance-evidence-ref",
    name: "Exact page provenance (evidence ref → page)",
    description:
      "Every extracted fact / claim / evidence link MUST carry documentId + page. No fact can reference a vague 'document' without a page number.",
    setupSteps: [
      "Upload a 10-page document with extractable facts on pages 3 and 7.",
      "Run the fact extractor.",
      "Sample 10 CaseFact rows.",
    ],
    assertions: [
      "Every CaseFact.supportingEvidence[].documentId is non-empty.",
      "Every CaseFact.supportingEvidence[].page is a positive integer ≤ the document's pageCount.",
      "Every CaseEvidenceLink.evidenceRef.page is ≤ the referenced document's pageCount.",
    ],
  },
  {
    id: "G14-case-evidence-vs-legal-authority-separation",
    name: "Case evidence vs legal authority separation (research)",
    description:
      "After running federated research, the legal-authority results (laws / precedents) MUST land in LegalIssueLink.relatedLaw + relatedPrecedents — NOT in CaseFact.supportingEvidence (case-internal evidence).",
    setupSteps: [
      "Create a case with a LegalIssueLink.",
      "Run researchIssueForCase for that issue.",
    ],
    assertions: [
      "LegalIssueLink.relatedLaw.length > 0 OR relatedPrecedents.length > 0 (research produced results).",
      "No CaseFact.supportingEvidence entry references a federated-search result URL — case evidence is from uploaded documents only.",
      "The federated-search URL appears in relatedLaw/relatedPrecedents entries' url field.",
    ],
  },
  {
    id: "G15-codex-unavailable-deterministic-fallback",
    name: "Codex unavailable → deterministic analysis fallback",
    description:
      "When Codex CLI is AUTH_REQUIRED (ChatGPT not signed in), the case workspace MUST still produce a deterministic analysis (§26) — the case summary + structural analysis succeed without an LLM.",
    setupSteps: [
      "Create a case with facts, issues, and federated-search legal authority.",
      "Build a CaseAnalysisPack via buildCaseAnalysisPack.",
      "Call runCodexCaseAnalysis — it returns AUTH_REQUIRED.",
      "Call runDeterministicAnalysis.",
    ],
    assertions: [
      "runCodexCaseAnalysis returns status='AUTH_REQUIRED' (NOT an exception).",
      "The CaseAnalysisResult row persisted for the Codex attempt has status='BLOCKED_EXTERNAL_QUOTA'.",
      "runDeterministicAnalysis returns a DeterministicCaseAnalysis with non-empty synthesis and `deterministic: true`.",
      "Every evidenceId referenced in the deterministic analysis exists in the pack.",
    ],
  },
  {
    id: "G16-codex-closed-evidence-live-gate",
    name: "Codex closed-evidence analysis when quota returns (live gate)",
    description:
      "When Codex CLI is HEALTHY (ChatGPT signed in AND quota not exhausted), the case workspace runs the full closed-evidence analysis. The output passes the firewall (§16). SKIP THIS FIXTURE when Codex is AUTH_REQUIRED today (§25 — don't block Phase 5).",
    setupSteps: [
      "Probe Codex CLI health: getAiRuntime().provider('codex-cli').health().",
      "If status='AUTH_REQUIRED', SKIP this fixture (return SKIPPED — not failed).",
      "Otherwise: create a case with facts + issues + federated-search legal authority.",
      "Build a CaseAnalysisPack via buildCaseAnalysisPack.",
      "Call runCodexCaseAnalysis.",
    ],
    assertions: [
      "runCodexCaseAnalysis returns status='SUCCESS' with a non-null analysis.",
      "The analysis passes validateCodexOutput() — no unknown evidenceId.",
      "The analysis.synthesis is non-empty.",
      "The CaseAnalysisResult row has status='COMPLETED' and provider='codex-cli'.",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Helper — list of fixtures whose evaluation is gated on Codex availability.
// ---------------------------------------------------------------------------

export const LIVE_GATE_FIXTURE_IDS: ReadonlySet<string> = new Set([
  "G16-codex-closed-evidence-live-gate",
]);

/** Count + ids of all fixtures (for harness reporting). */
export function describeGoldSet(): {
  total: number;
  liveGate: string[];
  deterministic: string[];
} {
  return {
    total: CASE_GOLD_FIXTURES.length,
    liveGate: CASE_GOLD_FIXTURES.filter((f) =>
      LIVE_GATE_FIXTURE_IDS.has(f.id),
    ).map((f) => f.id),
    deterministic: CASE_GOLD_FIXTURES.filter(
      (f) => !LIVE_GATE_FIXTURE_IDS.has(f.id),
    ).map((f) => f.id),
  };
}
