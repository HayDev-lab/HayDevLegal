"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Square,
  BookOpen,
  Send,
  MessageCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Share2,
} from "lucide-react";
import type { LegalSource, CitationRef, AnswerChunk } from "@/lib/legal/types";
import type { ResearchReport } from "@/lib/legal-research/types";
import { cn } from "@/lib/utils";
import { MarkdownAnswer } from "./MarkdownAnswer";

type AgentAnswerProps = {
  query: string;
  sources: LegalSource[];
  /** When true, component starts streaming immediately on mount. */
  autoStart?: boolean;
  /** Optional date-sensitivity context (spec §16) passed to the AI */
  dateContext?: { date?: string; wantsHistorical?: boolean; wantsCurrent?: boolean };
  /** Search warnings (temporal / restricted) reflected in the AI prompt. */
  warnings?: string[];
  /** Phase 4 — structured research report (deep mode) for the answer engine. */
  research?: ResearchReport;
};

type StreamState = "idle" | "thinking" | "streaming" | "done" | "error";

type Turn = {
  role: "user" | "assistant";
  content: string;
};

export function AgentAnswer({ query, sources, autoStart = true, dateContext, warnings, research }: AgentAnswerProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<StreamState>("idle");
  const [citations, setCitations] = useState<CitationRef[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [followUp, setFollowUp] = useState("");
  const [showFullAnswer, setShowFullAnswer] = useState(true);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const followUpInputRef = useRef<HTMLInputElement>(null);

  const start = useCallback(
    async (followUpQuery?: string, history?: Turn[]) => {
      // Abort any existing stream
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      if (!followUpQuery) {
        setText("");
        setTurns([]);
      } else {
        // Keep the existing text as the prior turn; we'll append the new answer below
        setTurns((prev) => [...prev, { role: "user", content: followUpQuery }, { role: "assistant", content: "" }]);
      }
      setCitations([]);
      setErrorMsg(null);
      setRequestId(null);
      setState("thinking");

      const actualQuery = followUpQuery ?? query;

      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: actualQuery,
            evidence: sources,
            history: history ?? (followUpQuery ? turns : undefined),
            dateContext: followUpQuery ? undefined : dateContext,
            warnings: followUpQuery ? undefined : warnings,
            research: followUpQuery ? undefined : research,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        setState("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let firstTokenSeen = false;
        let accumulated = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk: AnswerChunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            if (chunk.type === "delta") {
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                setState("streaming");
              }
              accumulated += chunk.text;
              if (followUpQuery) {
                // Update the last assistant turn
                setTurns((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    next[lastIdx] = { ...next[lastIdx], content: accumulated };
                  }
                  return next;
                });
              } else {
                setText(accumulated);
              }
            } else if (chunk.type === "replace") {
              // Hallucination firewall final pass: re-render the cleaned text.
              accumulated = chunk.text;
              if (followUpQuery) {
                setTurns((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
                    next[lastIdx] = { ...next[lastIdx], content: accumulated };
                  }
                  return next;
                });
              } else {
                setText(accumulated);
              }
            } else if (chunk.type === "done") {
              setCitations(chunk.citations);
              setRequestId(chunk.requestId);
              setState("done");
            } else if (chunk.type === "error") {
              setErrorMsg(chunk.message);
              setRequestId(chunk.requestId);
              setState("error");
            }
          }
        }
        setState((s) => (s === "streaming" || s === "thinking" ? "done" : s));
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          setState(followUpQuery ? "done" : "idle");
          return;
        }
        console.error("[AgentAnswer] stream failed:", err);
        setErrorMsg("AI վերլուծությունն այս պահին հասանելի չէ։ Աղբյուրները մնում են հասանելի։");
        setState("error");
      }
    },
    [query, sources, turns, warnings],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState("done");
  }, []);

  // Keep a ref to the latest `start` function so the auto-start effect can
  // call it without having `start` in its deps (which would cause the effect
  // to re-run + abort the fetch whenever `turns`/`sources` change).
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Auto-start once when sources become available.
  // Deps are intentionally minimal: [autoStart, sources.length].
  // We do NOT include `start` here — that would re-trigger the effect when
  // `start` is recreated (e.g. after setTurns([])), aborting the in-flight
  // fetch via the cleanup function.
  useEffect(() => {
    if (!autoStart) return;
    if (sources.length === 0) return;
    if (startedRef.current) return;
    startedRef.current = true;
    startRef.current();
    // Only abort on UNMOUNT, not on dep changes.
    return () => {
      abortRef.current?.abort();
    };
  }, [autoStart, sources.length]);

  // Auto-scroll the answer panel as tokens arrive.
  useEffect(() => {
    if (scrollRef.current && state === "streaming") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, turns, state]);

  const handleFollowUp = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = followUp.trim();
      if (!q || state === "thinking" || state === "streaming") return;
      setFollowUp("");
      void start(q);
    },
    [followUp, state, start],
  );

  const isBusy = state === "thinking" || state === "streaming";
  const hasTurns = turns.length > 0;
  // The currently displayed text: either the main answer or the last follow-up answer
  const displayText = hasTurns ? turns[turns.length - 1]?.content ?? "" : text;

  // Copy the AI answer to clipboard (plain text with citations).
  // Always shows the "copied" feedback for UX; clipboard write is best-effort
  // with a timeout so it never hangs in restricted environments.
  const handleCopy = useCallback(async () => {
    if (!displayText) return;
    const doFallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = displayText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        const sel = window.getSelection();
        if (sel && scrollRef.current) {
          const range = document.createRange();
          range.selectNodeContents(scrollRef.current);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    };
    try {
      // Race the clipboard write against a 1s timeout so it never hangs.
      await Promise.race([
        navigator.clipboard?.writeText(displayText) ?? Promise.reject(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
      ]);
    } catch {
      doFallback();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayText]);

  // Share the query as a URL (copies the shareable ?q= link to clipboard).
  const handleShare = useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("q", query);
    const shareUrl = url.toString();
    try {
      await Promise.race([
        navigator.clipboard?.writeText(shareUrl) ?? Promise.reject(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000)),
      ]);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = shareUrl;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        // ignore
      }
    }
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  }, [query]);

  if (sources.length === 0) return null;

  return (
    <section
      aria-label="AI վերլուծություն"
      aria-live="polite"
      className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-100 bg-gradient-to-r from-neutral-50 to-white px-4 py-3 dark:border-neutral-800 dark:from-neutral-900 dark:to-neutral-900/50 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
            <Sparkles className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-900 uppercase dark:text-neutral-100">
              AI Վերլուծություն
            </h2>
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
              Հիմնված {sources.length} ապացույցի վրա · հղումներ դեպի սկզբնաղբյուրներ
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Copy answer button */}
          {displayText && !isBusy && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? "Պատճենվեց" : "Պատճենել պատասխանը"}
              title={copied ? "Պատճենվեց" : "Պատճենել պատասխանը"}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500" aria-hidden />
              ) : (
                <Copy className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
          {/* Share query link button */}
          {displayText && !isBusy && (
            <button
              type="button"
              onClick={handleShare}
              aria-label={shared ? "Հղումը պատճենվեց" : "Կիսվել հղումով"}
              title={shared ? "Հղումը պատճենվեց" : "Կիսվել հղումով"}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            >
              {shared ? (
                <Check className="h-3 w-3 text-emerald-500" aria-hidden />
              ) : (
                <Share2 className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
          {/* Collapse / expand toggle */}
          {displayText && !isBusy && (
            <button
              type="button"
              onClick={() => setShowFullAnswer((v) => !v)}
              aria-label={showFullAnswer ? "Կծկել" : "Ընդարձակել"}
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              {showFullAnswer ? (
                <ChevronUp className="h-3 w-3" aria-hidden />
              ) : (
                <ChevronDown className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
          {isBusy && (
            <button
              type="button"
              onClick={cancel}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <Square className="h-3 w-3" aria-hidden />
              Կանգնեցնել
            </button>
          )}
          {state === "done" && (
            <button
              type="button"
              onClick={() => {
                startedRef.current = true;
                setText("");
                setTurns([]);
                start();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Կրկին
            </button>
          )}
          {state === "idle" && (
            <button
              type="button"
              onClick={() => {
                startedRef.current = true;
                start();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              <Sparkles className="h-3 w-3" aria-hidden />
              Սկսել վերլուծությունը
            </button>
          )}
          {state === "error" && (
            <button
              type="button"
              onClick={() => {
                startedRef.current = true;
                start();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Կրկին
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        {state === "thinking" && !displayText && (
          <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            <span className="pulse-legal">Վերլուծում եմ աղբյուրները...</span>
          </div>
        )}

        {state === "error" && (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">{errorMsg}</p>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400/80">
                Հիմնական աղբյուրները վերևում մնում են հասանելի։ Կարող եք փորձել կրկին ստանալ վերլուծությունը։
              </p>
            </div>
          </div>
        )}

        {displayText && showFullAnswer && (
          <div
            ref={scrollRef}
            className={cn(
              "scroll-legal max-h-[60vh] overflow-y-auto pr-1",
              state === "streaming" && "stream-caret",
            )}
          >
            {/* Render prior turns as a conversation context (compact) */}
            {hasTurns && turns.length > 2 && (
              <div className="mb-4 space-y-2 border-l-2 border-neutral-200 pl-3 dark:border-neutral-700">
                {turns.slice(0, -2).map((t, i) => (
                  <div key={i} className="text-xs">
                    <span
                      className={cn(
                        "font-medium",
                        t.role === "user"
                          ? "text-neutral-500 dark:text-neutral-400"
                          : "text-neutral-400 dark:text-neutral-500",
                      )}
                    >
                      {t.role === "user" ? "Հարց՝ " : "Պատասխան՝ "}
                    </span>
                    <span className="text-neutral-600 dark:text-neutral-300 line-clamp-2">
                      {t.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* Render the latest user question if it's a follow-up */}
            {hasTurns && turns.length >= 2 && (
              <div className="mb-3 flex items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-800/50">
                <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden />
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  {turns[turns.length - 2]?.content}
                </p>
              </div>
            )}
            {/* The main answer (markdown-rendered) */}
            <MarkdownAnswer
              text={displayText}
              citations={citations}
              sources={sources}
            />
          </div>
        )}

        {state === "done" && !displayText && !errorMsg && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Վերլուծություն չստացվեց։ Փորձեք կրկին։
          </p>
        )}

        {/* Citations footer */}
        {state === "done" && citations.length > 0 && (
          <div className="mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              Օգտագործված աղբյուրներ
            </div>
            <div className="flex flex-wrap gap-2">
              {citations.map((c) => (
                <a
                  key={c.id}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-neutral-900 text-[10px] font-bold text-white dark:bg-white dark:text-neutral-900">
                    {c.id}
                  </span>
                  <span className="max-w-[11rem] truncate sm:max-w-[18rem] group-hover:text-neutral-900 dark:group-hover:text-white">
                    {c.title}
                  </span>
                  <span className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">↗</span>
                </a>
              ))}
            </div>
            {requestId && (
              <p className="mt-2 font-mono text-[10px] text-neutral-300 dark:text-neutral-600">
                request_id: {requestId}
              </p>
            )}
          </div>
        )}

        {/* Follow-up question input (spec §52) */}
        {(state === "done" || state === "idle") && (
          <div className="enter-slide-up mt-4 border-t border-neutral-100 pt-3 dark:border-neutral-800">
            <form onSubmit={handleFollowUp} className="flex items-center gap-2">
              <input
                ref={followUpInputRef}
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                placeholder="Հստակեցնող հարց տալ աղբյուրների հիման վրա..."
                disabled={isBusy}
                aria-label="Հստակեցնող հարց"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-neutral-700"
              />
              <button
                type="submit"
                disabled={!followUp.trim() || isBusy}
                aria-label="Ուղարկել հստակեցնող հարցը"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white transition-all hover:bg-neutral-700 disabled:bg-neutral-300 disabled:cursor-not-allowed dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
              >
                <Send className="h-4 w-4" aria-hidden />
              </button>
            </form>
            <p className="mt-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
              Հետևող հարցերը պահպանում են ընթացիկ աղբյուրները և զրույցի համատեքստը։
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
