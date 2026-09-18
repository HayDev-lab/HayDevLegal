// src/lib/legal-strategy/state/procedural-posture.ts
// Phase 7 — §22 — Build the ProceduralPosture: case type, court, stage,
// challenged act, last verified procedural event, available decisions,
// pending motions, known deadlines, appeal/Cassation/ConCourt/ECHR history.
//
// CRITICAL: "Unknown remains unknown." Every field is nullable. The engine
// never fabricates a stage, court, or challenged act. When the case record
// doesn't support an inference, the field stays null.
//
// The posture is built deterministically from the verified Case Workspace
// rows (case workspace + chronology). No LLM, no legal research.

import { db } from "@/lib/db";
import type { AppealHistoryEntry, ProceduralPosture } from "../types";
import type { CaseState } from "./case-state";

// ---------------------------------------------------------------------------
// Stage classifier (deterministic — based on chronology events + case type)
// ---------------------------------------------------------------------------

/**
 * Infer the procedural stage from chronology events. Conservative — returns
 * null when no conclusive stage can be derived from the case record.
 *
 * Stages recognized (RA jurisdiction):
 *   - "investigation"        (events: SEARCH, SEIZURE, INTERROGATION, ARREST)
 *   - "first_instance"       (events: HEARING with court, no DECISION yet)
 *   - "first_instance_decided" (DECISION event, no appeal filing)
 *   - "appeal"               (FILING event whose title mentions appeal/բողոք)
 *   - "appeal_decided"       (DECISION after an appeal filing)
 *   - "cassation"            (FILING event mentioning cassation/վճռաբեկ)
 *   - "cassation_decided"    (DECISION after cassation filing)
 *   - "concourt"             (FILING event mentioning constitutional court)
 *   - "echr"                 (filing at the ECtHR — rare in domestic cases)
 *   - "execution"            (DECISION + filing mentioning execution)
 */
export function inferStageFromEvents(
  events: { eventType: string; title: string; description?: string | null }[],
): string | null {
  if (!events || events.length === 0) return null;

  const last = events[events.length - 1];
  if (!last) return null;
  const text = `${last.title} ${last.description ?? ""}`.toLowerCase();

  // Walk backwards to find the latest decisive signal.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    const t = `${e.title} ${e.description ?? ""}`.toLowerCase();
    if (t.includes("cassation") || t.includes("վճռաբեկ") || t.includes("кассаци")) {
      return "cassation";
    }
    if (t.includes("constitutional court") || t.includes("սահմանադրական դատարան")) {
      return "concourt";
    }
    if (t.includes("echr") || t.includes("estrn") || t.includes("european court")) {
      return "echr";
    }
    if (t.includes("appeal") || t.includes("բողոք") || t.includes("апелляц")) {
      return "appeal";
    }
    if (e.eventType === "DECISION" && (t.includes("appeal") || t.includes("բողոք"))) {
      return "appeal_decided";
    }
    if (e.eventType === "DECISION") {
      return "first_instance_decided";
    }
  }

  // No decisive signal — fall back to the latest event's type.
  if (["SEARCH", "SEIZURE", "INTERROGATION", "ARREST"].includes(last.eventType)) {
    return "investigation";
  }
  if (last.eventType === "HEARING") {
    return "first_instance";
  }
  if (last.eventType === "FILING") {
    return "first_instance";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Challenged act extractor
// ---------------------------------------------------------------------------

/**
 * Extract the challenged act from chronology events of type DECISION. Returns
 * the most recent DECISION event's title as the challenged act. Returns null
 * when no DECISION event is in the record.
 */
export function extractChallengedAct(
  events: { eventType: string; title: string; verification: string }[],
): string | null {
  const decisions = events.filter(
    (e) => e.eventType === "DECISION" && e.verification === "DOCUMENT_VERIFIED",
  );
  if (decisions.length === 0) return null;
  return decisions[decisions.length - 1]?.title ?? null;
}

// ---------------------------------------------------------------------------
// Appeal history extractor
// ---------------------------------------------------------------------------

/**
 * Extract appeal / cassation / concourt / ECHR history from chronology FILING
 * events whose titles contain the relevant keyword. Each history entry's
 * outcome is "FILED" when the event is just a filing, "DECIDED" when there's
 * a later DECISION event for the same level, "UNKNOWN" otherwise.
 */
function extractAppealHistory(
  events: {
    eventId: string;
    eventType: string;
    title: string;
    date: string | null;
    verification: string;
  }[],
  keyword: string,
): AppealHistoryEntry[] {
  const out: AppealHistoryEntry[] = [];
  const filings = events.filter(
    (e) =>
      e.eventType === "FILING" &&
      e.title.toLowerCase().includes(keyword.toLowerCase()),
  );
  for (const f of filings) {
    // Is there a later DECISION event mentioning the same keyword?
    const decided = events.some(
      (e) =>
        e.eventType === "DECISION" &&
        e.title.toLowerCase().includes(keyword.toLowerCase()) &&
        // The decision is at or after the filing date (when dates are known).
        (!e.date || !f.date || e.date >= f.date),
    );
    out.push({
      eventId: f.eventId,
      title: f.title,
      date: f.date,
      outcome: decided ? "DECIDED" : "FILED",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildProceduralPosture
// ---------------------------------------------------------------------------

/**
 * Build the ProceduralPosture for a case from the CaseWorkspace row + the
 * chronology events. The CaseState's bounded event slice is used when
 * provided (to avoid re-fetching); otherwise the raw chronology is loaded.
 *
 * Per §22: "Unknown remains unknown." Every field is nullable. The engine
 * never fabricates a stage, court, or challenged act.
 */
export async function buildProceduralPosture(
  caseId: string,
  caseState?: CaseState,
): Promise<ProceduralPosture> {
  if (!caseId) return emptyPosture("");

  // Load the case row + raw chronology (CaseState's bounded slice is a
  // subset; for the posture we want the full chronology so we don't miss
  // appeal filings).
  const [caseRow, rawEvents] = await Promise.all([
    db.caseWorkspace.findUnique({
      where: { id: caseId },
      select: {
        caseType: true,
        court: true,
        jurisdiction: true,
        proceedingType: true,
      },
    }),
    db.chronologyEvent.findMany({
      where: { caseId },
      orderBy: { date: "asc" },
    }),
  ]);

  // Map raw events into a uniform shape (parse participants/evidenceRefs
  // is not needed here — we only need eventType, title, date, verification).
  const events = rawEvents.map((e) => ({
    eventId: e.id,
    eventType: e.eventType,
    title: e.title,
    description: e.description,
    date: e.date,
    verification: e.verification,
  }));

  // Last verified procedural event = the most recent DOCUMENT_VERIFIED event
  // (chronology is sorted ascending by date).
  const verifiedEvents = events.filter(
    (e) => e.verification === "DOCUMENT_VERIFIED",
  );
  const lastVerified = verifiedEvents[verifiedEvents.length - 1] ?? null;

  // Available decisions = all DOCUMENT_VERIFIED DECISION events.
  const availableDecisions = verifiedEvents
    .filter((e) => e.eventType === "DECISION")
    .map((e) => ({ eventId: e.eventId, title: e.title, date: e.date }));

  // Pending motions = FILING events with no later DECISION event for the
  // same hearing (conservative: any FILING whose date is after the latest
  // DECISION is "pending").
  const latestDecisionDate = availableDecisions
    .map((d) => d.date)
    .filter((d): d is string => typeof d === "string")
    .sort()
    .pop();
  const pendingMotions = verifiedEvents
    .filter(
      (e) =>
        e.eventType === "FILING" &&
        (!latestDecisionDate || !e.date || e.date >= latestDecisionDate),
    )
    .map((e) => ({ eventId: e.eventId, title: e.title, date: e.date }));

  // Known deadlines = chronology events whose title mentions deadline / ժամկետ
  // / срок. Conservative — only verified events.
  const knownDeadlines = verifiedEvents
    .filter((e) => {
      const t = e.title.toLowerCase();
      return (
        t.includes("deadline") ||
        t.includes("ժամկետ") ||
        t.includes("срок") ||
        t.includes("ժամկետային")
      );
    })
    .map((e) => ({ eventId: e.eventId, title: e.title, date: e.date }));

  // Histories.
  const appealHistory = extractAppealHistory(events, "appeal").concat(
    extractAppealHistory(events, "բողոք"),
  );
  const cassationHistory = extractAppealHistory(events, "cassation").concat(
    extractAppealHistory(events, "վճռաբեկ"),
  );
  const conCourtHistory = extractAppealHistory(events, "constitutional").concat(
    extractAppealHistory(events, "սահմանադրական"),
  );
  const echrHistory = extractAppealHistory(events, "echr").concat(
    extractAppealHistory(events, "european court"),
  );

  // Stage inference.
  const stage = inferStageFromEvents(events);

  // Challenged act extraction.
  const challengedAct = extractChallengedAct(events);

  // `inferred` flag — true when the stage or challenged act was derived
  // heuristically (vs. directly read from a verified chronology row).
  const inferred =
    (stage !== null && stage !== "first_instance") || challengedAct !== null;

  return {
    caseId,
    caseType: caseRow?.caseType ?? null,
    court: caseRow?.court ?? null,
    jurisdiction: caseRow?.jurisdiction ?? null,
    proceedingType: caseRow?.proceedingType ?? null,
    stage,
    challengedAct,
    lastVerifiedEvent: lastVerified
      ? {
          eventId: lastVerified.eventId,
          title: lastVerified.title,
          date: lastVerified.date,
          verification: lastVerified.verification,
        }
      : null,
    availableDecisions,
    pendingMotions,
    knownDeadlines,
    appealHistory,
    cassationHistory,
    conCourtHistory,
    echrHistory,
    inferred,
  };
}

// ---------------------------------------------------------------------------
// Empty posture (for failed / not-found cases)
// ---------------------------------------------------------------------------

export function emptyPosture(caseId: string): ProceduralPosture {
  return {
    caseId,
    caseType: null,
    court: null,
    jurisdiction: null,
    proceedingType: null,
    stage: null,
    challengedAct: null,
    lastVerifiedEvent: null,
    availableDecisions: [],
    pendingMotions: [],
    knownDeadlines: [],
    appealHistory: [],
    cassationHistory: [],
    conCourtHistory: [],
    echrHistory: [],
    inferred: false,
  };
}
