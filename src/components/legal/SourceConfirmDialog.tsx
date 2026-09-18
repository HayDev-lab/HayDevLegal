"use client";

// SourceConfirmDialog — interactive source confirmation (Phase 3 §25, §51, §63-§64).
//
// When a court-decision evidence is metadata-only because Datalex gates the
// full text behind a CAPTCHA, the user can choose to confirm the source:
//   1. our server bootstraps a dedicated Datalex session;
//   2. the challenge image is proxied into this dialog;
//   3. THE USER solves it (we never do);
//   4. the server retries showCase and returns passages of the real document.
// A normal search NEVER blocks on this flow — it is strictly opt-in.

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, Loader2, ExternalLink, X } from "lucide-react";
import type { LegalSource } from "@/lib/legal/types";

type ResolveBootstrap = {
  documentId: string;
  token: string;
  captchaUrl: string;
};

type ResolveResult =
  | { status: "resolved"; url: string; passages: string[]; textPreview: string; bytes: number }
  | { status: "captcha_required"; error?: string }
  | { status: "error"; error: string };

export function SourceConfirmDialog({
  source,
  query,
  onClose,
  onResolved,
}: {
  source: LegalSource;
  query: string;
  onClose: () => void;
  /** Called with the resolved passages so the card can be upgraded in place. */
  onResolved: (passages: string[], url: string, textPreview: string) => void;
}) {
  const [bootstrap, setBootstrap] = useState<ResolveBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [captchaText, setCaptchaText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const documentRef = source.documentRef ?? "";

  const start = useCallback(async () => {
    setBootstrap(null);
    setBootstrapError(null);
    setResult(null);
    setCaptchaText("");
    try {
      const res = await fetch(`/api/resolve?doc=${encodeURIComponent(documentRef)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "սխալ");
      }
      setBootstrap((await res.json()) as ResolveBootstrap);
      setTimeout(() => inputRef.current?.focus(), 120);
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : "Աղբյուրի սեսիան չստեղծվեց։");
    }
  }, [documentRef]);

  useEffect(() => {
    void start();
  }, [start]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!bootstrap || !captchaText.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: bootstrap.token, captchaText: captchaText.trim(), query }),
      });
      const body = (await res.json().catch(() => ({}))) as ResolveResult;
      if (body.status === "resolved") {
        setResult(body);
        onResolved(body.passages, body.url, body.textPreview);
      } else if (body.status === "captcha_required") {
        setResult(body);
        setCaptchaText("");
        setCaptchaNonce((n) => n + 1); // fresh challenge image
        setTimeout(() => inputRef.current?.focus(), 120);
      } else {
        setResult({ status: "error", error: body.error ?? "Աղբյուրի սխալ։" });
      }
    } catch {
      setResult({ status: "error", error: "Ցանցային սխալ։" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Աղբյուրի հաստատում"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="enter-legal w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Աղբյուրի հաստատում
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            aria-label="Փակել"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          Այս դատական գործի ամբողջական տեքստը DataLex-ը ցուցադրում է միայն հաստատումից հետո։
          Մուտքագրեք պատկերի տեքստը՝ ստանալու փաստաթղթի իրական բովանդակությունը։
          {source.caseNumber ? ` Գործի համարը՝ ${source.caseNumber}։` : ""}
        </p>

        {bootstrapError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {bootstrapError}
          </div>
        )}

        {!bootstrap && !bootstrapError && (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Ստեղծվում է աղբյուրի սեսիա...
          </div>
        )}

        {bootstrap && !result?.status.startsWith("resolved") && (
          <>
            <div className="mb-3 flex justify-center">
              <img
                key={captchaNonce}
                src={`${bootstrap.captchaUrl}&r=${captchaNonce}`}
                alt="Հաստատման պատկեր"
                className="h-[60px] w-[200px] rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800"
              />
            </div>
            <div className="mb-3 flex gap-2">
              <input
                ref={inputRef}
                value={captchaText}
                onChange={(e) => setCaptchaText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                placeholder="Պատկերի տեքստը"
                autoComplete="off"
                maxLength={10}
                className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
              />
              <button
                type="button"
                onClick={() => setCaptchaNonce((n) => n + 1)}
                className="rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                title="Նոր պատկեր"
                aria-label="Նոր պատկեր"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {result && result.status !== "resolved" && "error" in result && result.error && (
              <p className="mb-2 text-xs text-red-600 dark:text-red-400">{result.error}</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={busy || captchaText.trim().length < 3}
                onClick={() => void submit()}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
                Հաստատել և ստանալ տեքստը
              </button>
              <a
                href={source.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                Բացել DataLex-ում <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
          </>
        )}

        {result?.status === "resolved" && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Ամբողջական տեքստը ստացվել է և ստուգվել է
            </p>
            {(result.passages.length > 0 ? result.passages : [result.textPreview]).slice(0, 2).map((p, i) => (
              <div
                key={i}
                className="max-h-40 overflow-y-auto rounded-md border border-neutral-100 bg-neutral-50/60 p-3 text-xs leading-relaxed text-neutral-700 dark:border-neutral-800 dark:bg-neutral-800/40 dark:text-neutral-300"
              >
                {p.slice(0, 700)}
                {p.length > 700 ? "…" : ""}
              </div>
            ))}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              Փակել
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
