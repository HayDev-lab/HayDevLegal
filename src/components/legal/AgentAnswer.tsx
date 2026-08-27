"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Sparkles, Loader2, AlertTriangle, RotateCcw, Square, BookOpen } from "lucide-react";
import type { LegalSource, CitationRef, AnswerChunk } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

type AgentAnswerProps = {
  query: string;
  sources: LegalSource[];
  /** When true, component starts streaming immediately on mount. */
  autoStart?: boolean;
};

type StreamState = "idle" | "thinking" | "streaming" | "done" | "error";

export function AgentAnswer({ query, sources, autoStart = true }: AgentAnswerProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<StreamState>("idle");
  const [citations, setCitations] = useState<CitationRef[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    // Abort any existing stream
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setText("");
    setCitations([]);
    setErrorMsg(null);
    setRequestId(null);
    setState("thinking");

    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, sources }),
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
            setText((prev) => prev + chunk.text);
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
      // If stream ended without explicit done/error, mark done.
      setState((s) => (s === "streaming" || s === "thinking" ? "done" : s));
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setState("idle");
        return;
      }
      console.error("[AgentAnswer] stream failed:", err);
      setErrorMsg("AI վերլուծությունն այս պահին հասանելի չէ։ Աղբյուրները մնում են հասանելի։");
      setState("error");
    }
  }, [query, sources]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState("idle");
  }, []);

  // Auto-start once when sources become available.
  useEffect(() => {
    if (!autoStart) return;
    if (sources.length === 0) return;
    if (startedRef.current) return;
    startedRef.current = true;
    start();
    return () => {
      abortRef.current?.abort();
    };
  }, [autoStart, sources.length, start]);

  // Auto-scroll the answer panel as tokens arrive.
  useEffect(() => {
    if (scrollRef.current && state === "streaming") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text, state]);

  if (sources.length === 0) return null;

  return (
    <section
      aria-label="AI վերլուծություն"
      aria-live="polite"
      className="overflow-hidden rounded-xl border border-neutral-200 bg-white"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-100 bg-gradient-to-r from-neutral-50 to-white px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-white">
            <Sparkles className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-neutral-900 uppercase">
              AI Վերլուծություն
            </h2>
            <p className="text-[11px] text-neutral-400">
              Հիմնված {sources.length} աղբյուրի վրա · հղումներով դեպի ARLIS
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state === "streaming" && (
            <button
              type="button"
              onClick={cancel}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              <Square className="h-3 w-3" aria-hidden />
              Կանգնեցնել
            </button>
          )}
          {(state === "done" || state === "error") && (
            <button
              type="button"
              onClick={() => {
                startedRef.current = true;
                start();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              Կրկին
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        {state === "thinking" && (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            <span className="pulse-legal">Վերլուծում եմ աղբյուրները...</span>
          </div>
        )}

        {state === "error" && (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">{errorMsg}</p>
              <p className="mt-0.5 text-xs text-amber-700">
                Հիմնական աղբյուրները վերևում մնում են հասանելի։ Կարող եք փորձել կրկին ստանալ վերլուծությունը։
              </p>
            </div>
          </div>
        )}

        {text && (
          <div
            ref={scrollRef}
            className={cn(
              "scroll-legal max-h-[60vh] overflow-y-auto pr-1",
              "text-[15px] leading-relaxed text-neutral-800",
              state === "streaming" && "stream-caret",
            )}
          >
            <AnswerRenderer text={text} citations={citations} sources={sources} />
          </div>
        )}

        {state === "done" && !text && !errorMsg && (
          <p className="text-sm text-neutral-500">
            Վերլուծություն չստացվեց։ Փորձեք կրկին։
          </p>
        )}

        {/* Citations footer */}
        {state === "done" && citations.length > 0 && (
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-500">
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
                  className="group inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded bg-neutral-900 text-[10px] font-bold text-white">
                    {c.id}
                  </span>
                  <span className="max-w-[18rem] truncate group-hover:text-neutral-900">
                    {c.title}
                  </span>
                  <span className="text-neutral-400 group-hover:text-neutral-600">↗</span>
                </a>
              ))}
            </div>
            {requestId && (
              <p className="mt-2 font-mono text-[10px] text-neutral-300">
                request_id: {requestId}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Render the streamed answer text, transforming inline [S1]..[S4] citations
 * into clickable superscript links to the corresponding ARLIS source URL.
 */
function AnswerRenderer({
  text,
  citations,
  sources,
}: {
  text: string;
  citations: CitationRef[];
  sources: LegalSource[];
}) {
  // Use the union of citations (done) and source ids as the valid set.
  const byId = new Map<string, LegalSource>();
  for (const s of sources) byId.set(s.id, s);
  for (const c of citations) {
    if (!byId.has(c.id)) {
      byId.set(c.id, {
        id: c.id,
        source: "ARLIS",
        title: c.title,
        canonicalUrl: c.url,
        excerpt: "",
        retrievedAt: "",
        relevanceScore: 0,
      });
    }
  }

  // Split on [Sn] markers and render.
  const parts: Array<{ type: "text"; value: string } | { type: "cite"; id: string }> = [];
  const re = /\[S(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
    parts.push({ type: "cite", id: `S${m[1]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });

  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((p, i) => {
        if (p.type === "text") return <span key={i}>{p.value}</span>;
        const src = byId.get(p.id);
        if (!src || !src.canonicalUrl) {
          // Unsupported citation — should have been stripped by the firewall,
          // but render defensively as plain text.
          return <span key={i} className="text-neutral-400">[{p.id}]</span>;
        }
        return (
          <a
            key={i}
            href={src.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={src.title}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-neutral-900 px-1 align-super text-[10px] font-bold leading-none text-white no-underline hover:bg-neutral-700"
          >
            {p.id}
          </a>
        );
      })}
    </div>
  );
}
