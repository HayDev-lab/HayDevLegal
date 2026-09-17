// src/lib/legal-search/engine/source-orchestrator.ts
// Parallel live source orchestration (spec §12-§13).
//
//   await Promise.allSettled([arlis.search(...), datalex.search(...), ...])
//
// Rules:
//  - one source failing NEVER breaks the whole search;
//  - every source gets its own timeout (AbortController-friendly);
//  - statuses are SUCCESS / EMPTY / TIMEOUT / RATE_LIMITED / RESTRICTED /
//    ERROR / UNSUPPORTED and are surfaced in the search trace.

import type {
  LegalSearchQuery,
  LegalSearchResult,
  SearchContext,
  SourceTraceEntry,
} from "../types";
import { adaptersFor } from "../sources/source-registry";
import { STAGES } from "../config";
import { recordSuccess, recordFailure, recordRestricted } from "./source-health";

export type OrchestratorRun = {
  results: LegalSearchResult[];
  trace: SourceTraceEntry[];
};

/** Cap candidates per source before merging (stage 1, spec §14). */
function capPerSource(results: LegalSearchResult[]): LegalSearchResult[] {
  return results.slice(0, STAGES.candidatesPerSource);
}

/**
 * Fan the query out to all applicable sources in parallel.
 * Never throws — failures become trace entries.
 */
export async function orchestrateSources(
  query: LegalSearchQuery,
  context: SearchContext,
): Promise<OrchestratorRun> {
  const adapters = adaptersFor(query, context.mode);

  const runs = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const perSourceDeadline = Math.min(
        context.deadline,
        Date.now() + Math.round(context.sourceTimeoutMs * (adapter.timeoutMultiplier ?? 1)),
      );
      const subContext: SearchContext = {
        ...context,
        deadline: perSourceDeadline,
      };
      // Race the adapter against its own deadline.
      const raceMs =
        Math.max(1, perSourceDeadline - Date.now()) +
        Math.round(500 * (adapter.timeoutMultiplier ?? 1));
      const raced = await Promise.race([
        adapter.search(query, subContext),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), raceMs)),
      ]);
      return { adapter, raced };
    }),
  );

  const results: LegalSearchResult[] = [];
  const trace: SourceTraceEntry[] = [];

  runs.forEach((run, i) => {
    const adapter = adapters[i];
    if (run.status === "fulfilled") {
      const { raced } = run.value;
      if (raced === null) {
        trace.push({
          id: adapter.id,
          name: adapter.name,
          status: "TIMEOUT",
          detail: "աղբյուրը չհասցրեց պատասխանել",
          resultCount: 0,
          durationMs: context.sourceTimeoutMs,
        });
        return;
      }
      const { outcome, results: sourceResults } = raced;
      // §61-§62 — per-capability health recording (search circuit).
      if (outcome.status === "SUCCESS" || outcome.status === "PARTIAL" || outcome.status === "EMPTY") {
        recordSuccess(adapter.id, "search");
      } else if (outcome.status === "RESTRICTED") {
        recordRestricted(adapter.id, "search");
      } else if (outcome.status !== "UNSUPPORTED") {
        recordFailure(adapter.id, "search");
      }
      trace.push({
        id: adapter.id,
        name: adapter.name,
        status: outcome.status,
        detail: outcome.detail,
        resultCount: outcome.resultCount,
        durationMs: outcome.durationMs,
        fallbackUrl: outcome.fallbackUrl,
      });
      results.push(...capPerSource(sourceResults));
    } else {
      // Adapter threw unexpectedly — isolate the failure.
      trace.push({
        id: adapter.id,
        name: adapter.name,
        status: "ERROR",
        detail: "անսպասելի սխալ",
        resultCount: 0,
        durationMs: 0,
      });
    }
  });

  // Hard cap on total candidates entering reranking.
  const capped = results.slice(0, STAGES.maxCandidates);
  return { results: capped, trace };
}

/**
 * Stage 3 (spec §14): fetch original documents for the top results,
 * bounded by concurrency and overall deadline.
 */
export async function fetchDocuments(
  results: LegalSearchResult[],
  context: SearchContext,
  fetchIds: Set<string>,
): Promise<{ fetched: number; extractedPassages: number }> {
  const targets = results.filter(
    (r) => fetchIds.has(r.sourceId) && r.url && /^https?:\/\//.test(r.url),
  );

  let fetched = 0;
  let extractedPassages = 0;

  // Bounded concurrency pool.
  const queue = [...targets];
  const workers = Array.from(
    { length: Math.min(POLICY_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0 && Date.now() < context.deadline - 500) {
        const r = queue.shift();
        if (!r) break;
        if (!r.fullText) {
          // fetchDocument is resolved through the adapter registry.
          const adapter = (await import("../sources/source-registry")).findAdapter(r.sourceId);
          if (!adapter?.fetchDocument) continue;
          try {
            const { status, document } = await adapter.fetchDocument(r, context);
            if (status === "SUCCESS" && document && document.text) {
              r.fullText = document.text;
              fetched++;
            }
          } catch {
            // best-effort; passage extraction falls back to excerpts
          }
        }
      }
    },
  );
  await Promise.allSettled(workers);

  // Passage extraction happens in the engine (needs query context).
  void extractedPassages;
  return { fetched, extractedPassages };
}

const POLICY_CONCURRENCY = 5;
