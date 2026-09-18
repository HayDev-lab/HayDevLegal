// src/lib/case-workspace/chronology/builder.ts
//
// §8 — Build a chronology for a case from all DocumentPage text.
//
// Algorithm:
//   1. For each DocumentPage, run extractDateCandidates.
//   2. For each candidate, build a ChronologyEvent (verification=DOCUMENT_VERIFIED,
//      evidenceRefs=[{documentId, page, quote:context}]).
//   3. Dedup (§8 — same hearing referenced by multiple documents): if two
//      events have the same date AND similar title (Jaccard > 0.6 on token
//      sets), merge — keep one event, append the other's evidenceRefs.
//   4. Conflict detection (§8 — sources disagree): if two events reference the
//      same hearing (similar title) but DIFFERENT dates, set hasConflict=true
//      on both and record conflictDetail.
//   5. Sort events by date (UNKNOWN dates last).
//   6. Persist: delete old DOCUMENT_VERIFIED events for this case (preserve
//      USER_ALLEGED user-entered events), then insert new events.
//
// NEVER hallucinate. Dates that cannot be parsed become UNKNOWN (preserved
// as events with dateStatus=UNKNOWN; the original text is still kept).

import { db } from "@/lib/db";
import { extractDateCandidates } from "./extractor";
import type {
  ChronologyEventRecord,
  ChronologyConflict,
  ChronologyEventType,
  DateStatus,
  EvidenceRef,
  Verification,
} from "../analysis-types";

export interface BuildChronologyResult {
  events: ChronologyEventRecord[];
  conflicts: ChronologyConflict[];
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  // Tokenize on non-letter boundaries. Works for Armenian/Cyrillic/Latin.
  const tokens = new Set<string>();
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    if (t.length > 2) tokens.add(t); // ignore very short tokens
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sameDate(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a === b;
}

// Infer event type from context (the text surrounding the date mention).
function inferEventType(context: string): ChronologyEventType {
  const c = context.toLowerCase();
  if (
    c.includes("նիստ") ||
    c.includes("դատաքննություն") ||
    c.includes("заседание") ||
    c.includes("hearing") ||
    c.includes("session")
  ) return "HEARING";
  if (
    c.includes("ներկայացվել") ||
    c.includes("ներկայացված") ||
    c.includes("подано") ||
    c.includes("filed")
  ) return "FILING";
  if (
    c.includes("խուզարկություն") ||
    c.includes("обыск") ||
    c.includes("search")
  ) return "SEARCH";
  if (
    c.includes("բռնագրավում") ||
    c.includes("изъятие") ||
    c.includes("seizure")
  ) return "SEIZURE";
  if (
    c.includes("հարցաքննություն") ||
    c.includes("допрос") ||
    c.includes("interrogation")
  ) return "INTERROGATION";
  if (
    c.includes("ձերբակալություն") ||
    c.includes("ձերբակալվել") ||
    c.includes("арест") ||
    c.includes("arrest")
  ) return "ARREST";
  if (
    c.includes("որոշում") ||
    c.includes("վճիռ") ||
    c.includes("решение") ||
    c.includes("decision") ||
    c.includes("ruling")
  ) return "DECISION";
  return "OTHER";
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

export async function buildChronologyForCase(
  caseId: string
): Promise<BuildChronologyResult> {
  if (!caseId) return { events: [], conflicts: [] };

  // 1. Fetch all documents + pages for this case.
  const documents = await db.caseDocument.findMany({
    where: { caseId },
    include: {
      pages: { orderBy: { pageNumber: "asc" } },
    },
  });

  // 2. Build raw event list (un-deduped).
  interface RawEvent {
    date: string | null;
    originalDateText: string;
    dateStatus: DateStatus;
    eventType: ChronologyEventType;
    title: string;
    description: string;
    evidenceRefs: EvidenceRef[];
    verification: Verification;
    hasConflict: boolean;
    conflictDetail: string | null;
  }
  const raw: RawEvent[] = [];

  for (const doc of documents) {
    for (const page of doc.pages) {
      const text = page.originalText ?? "";
      if (!text) continue;
      const candidates = extractDateCandidates(text, { language: "auto" });
      for (const c of candidates) {
        const ctx = c.context ?? c.original;
        raw.push({
          date: c.normalized ?? null,
          originalDateText: c.original,
          dateStatus: c.dateStatus,
          eventType: inferEventType(ctx),
          title: ctx.length > 120 ? ctx.slice(0, 117) + "…" : ctx,
          description: ctx,
          evidenceRefs: [
            {
              documentId: doc.id,
              page: page.pageNumber,
              quote: ctx,
              originalFilename: doc.originalFilename,
              contentHash: doc.sha256,
            },
          ],
          verification: "DOCUMENT_VERIFIED",
          hasConflict: false,
          conflictDetail: null,
        });
      }
    }
  }

  // 3. Dedup: same date + similar title (Jaccard > 0.6) → merge evidenceRefs.
  const merged: RawEvent[] = [];
  for (const e of raw) {
    const dup = merged.find(
      (m) =>
        sameDate(m.date, e.date) &&
        jaccard(tokenize(m.title), tokenize(e.title)) > 0.6
    );
    if (dup) {
      // Merge — append the other's evidenceRefs (preserve provenance).
      dup.evidenceRefs.push(...e.evidenceRefs);
    } else {
      merged.push({ ...e, evidenceRefs: [...e.evidenceRefs] });
    }
  }

  // 4. Conflict detection: similar title + different date → both haveConflict.
  // (§8 — sources disagree on the same hearing.)
  for (let i = 0; i < merged.length; i++) {
    const a = merged[i];
    for (let j = i + 1; j < merged.length; j++) {
      const b = merged[j];
      if (sameDate(a.date, b.date)) continue;
      const sim = jaccard(tokenize(a.title), tokenize(b.title));
      if (sim > 0.6) {
        a.hasConflict = true;
        b.hasConflict = true;
        const detail = `Sources disagree on date for the same event: "${a.date ?? "unknown"}" vs "${b.date ?? "unknown"}"`;
        a.conflictDetail = a.conflictDetail
          ? `${a.conflictDetail} | ${detail}`
          : detail;
        b.conflictDetail = b.conflictDetail
          ? `${b.conflictDetail} | ${detail}`
          : detail;
      }
    }
  }

  // 5. Sort: EXACT dates first (lexicographic ISO works), then INFERRED, then UNKNOWN.
  const statusRank: Record<DateStatus, number> = {
    EXACT: 0,
    INFERRED: 1,
    UNKNOWN: 2,
  };
  merged.sort((a, b) => {
    const ra = statusRank[a.dateStatus];
    const rb = statusRank[b.dateStatus];
    if (ra !== rb) return ra - rb;
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  // 6. Persist: replace DOCUMENT_VERIFIED events for this case (preserve
  //    USER_ALLEGED user-entered events).
  await db.chronologyEvent.deleteMany({
    where: { caseId, verification: "DOCUMENT_VERIFIED" },
  });
  const created: ChronologyEventRecord[] = [];
  for (const e of merged) {
    const rec = await db.chronologyEvent.create({
      data: {
        caseId,
        date: e.date,
        originalDateText: e.originalDateText,
        dateStatus: e.dateStatus,
        eventType: e.eventType,
        title: e.title,
        description: e.description,
        participants: "[]",
        evidenceRefs: JSON.stringify(e.evidenceRefs),
        verification: e.verification,
        hasConflict: e.hasConflict,
        conflictDetail: e.conflictDetail,
      },
    });
    created.push({
      id: rec.id,
      caseId: rec.caseId,
      date: rec.date,
      originalDateText: rec.originalDateText,
      dateStatus: rec.dateStatus as DateStatus,
      eventType: rec.eventType as ChronologyEventType,
      title: rec.title,
      description: rec.description,
      participants: [],
      evidenceRefs: e.evidenceRefs,
      verification: e.verification as Verification,
      hasConflict: rec.hasConflict,
      conflictDetail: rec.conflictDetail,
    });
  }

  // 7. Build conflicts list from merged events that have hasConflict=true.
  //    Pair up events that conflict on the same hearing.
  const conflicts: ChronologyConflict[] = [];
  for (let i = 0; i < created.length; i++) {
    const a = created[i];
    if (!a.hasConflict) continue;
    for (let j = i + 1; j < created.length; j++) {
      const b = created[j];
      if (!b.hasConflict) continue;
      if (sameDate(a.date, b.date)) continue;
      if (jaccard(tokenize(a.title), tokenize(b.title)) > 0.6) {
        conflicts.push({
          eventIds: [a.id, b.id],
          reason:
            a.conflictDetail ??
            `Same event referenced with different dates (${a.date ?? "?"} vs ${b.date ?? "?"})`,
        });
      }
    }
  }

  return { events: created, conflicts };
}
