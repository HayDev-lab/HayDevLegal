// src/lib/ai-runtime/structured-generation.ts
// Helper that wraps provider.generateStructured with the JSON extraction +
// Zod validation pipeline shared by every provider.
//
// The runtime contract is: each provider's generateStructured MUST return
// AiResult<T> and is responsible for parsing + validating internally.
// This helper is the canonical implementation that providers delegate to,
// so the parsing logic is consistent across Z-AI / Ollama / Generic /
// Codex variants.

import type { ZodType } from "zod";
import type {
  AiMessage,
  AiProvider,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
} from "./types";

/**
 * Extract the first JSON object/array from a model response.
 * Accepts ```json fences and leading/trailing prose.
 *
 * (Ported verbatim from src/lib/legal-research/llm.ts so the runtime is
 * self-contained; the original llm.ts remains the canonical source for
 * legacy callers and Task 4 will eventually delete its copy.)
 */
export function extractJson(raw: string): unknown {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const opener = body[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Validate the parsed JSON against the schema. Returns the parsed value,
 * or null if it does not validate (in which case the caller should return
 * INVALID_SCHEMA).
 */
export function validateStructured<T>(parsed: unknown, schema: ZodType<T>): T | null {
  const r = schema.safeParse(parsed);
  return r.success ? r.data : null;
}

/**
 * Shared pipeline used by every provider's `generateStructured`:
 *
 *   rawContent
 *     → extractJson     (returns unknown or null)
 *     → validate        (returns T or null)
 *
 * Returns:
 *   - SUCCESS(value)   if both parse + validate succeed
 *   - SUCCESS_EMPTY    if rawContent is empty (no JSON to extract)
 *   - INVALID_SCHEMA   if extraction or validation fails
 *
 * Provider implementations wrap this with their own transport call.
 */
export function finalizeStructuredResult<T>(
  rawContent: string,
  schema: ZodType<T>,
  providerId: AiProviderId,
  startedAt: number,
): AiResult<T> {
  const latencyMs = Date.now() - startedAt;
  if (!rawContent || rawContent.trim() === "") {
    return { status: "SUCCESS_EMPTY", provider: providerId, latencyMs };
  }
  const parsed = extractJson(rawContent);
  if (parsed === null || parsed === undefined) {
    return {
      status: "INVALID_SCHEMA",
      provider: providerId,
      detail: "no JSON object/array found in model response",
    };
  }
  const validated = validateStructured(parsed, schema);
  if (validated === null) {
    return {
      status: "INVALID_SCHEMA",
      provider: providerId,
      detail: "Zod schema validation failed",
    };
  }
  return { status: "SUCCESS", value: validated, provider: providerId, latencyMs };
}

/**
 * `requestStructured<T>` — public helper used by the runtime router itself
 * (not by providers). The router calls provider.generateStructured directly;
 * this helper exists for ad-hoc callers (e.g. Task 4 integration code that
 * needs to invoke a specific provider rather than the routed policy).
 *
 * Returns the AiResult<T> as-is; the caller is responsible for any
 * fallback logic.
 */
export async function requestStructured<T>(
  provider: AiProvider,
  schema: ZodType<T>,
  prompt: string | AiMessage[],
  ctx: AiRuntimeContext,
  opts: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    schemaName?: string;
  } = {},
): Promise<AiResult<T>> {
  const messages: AiMessage[] = Array.isArray(prompt)
    ? prompt
    : opts.systemPrompt
      ? [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];
  const req: AiStructuredRequest<T> = {
    messages,
    schema,
    schemaName: opts.schemaName,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
  };
  return provider.generateStructured(req, ctx);
}

/**
 * Shared "is this a 429" detector (§23, §26, §51). Implemented here so
 * providers don't reimplement the regex.
 */
export function isRateLimitError(err: unknown): {
  rateLimited: boolean;
  retryAfterMs?: number;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const rl = /429|too many requests|rate.?limit/i.test(msg);
  if (!rl) return { rateLimited: false };
  // Try to honor Retry-After if surfaced in the message.
  const m = msg.match(/retry[- ]?after[:\s]+(\d+)/i);
  const retryAfterMs = m ? Number.parseInt(m[1], 10) * 1000 : undefined;
  return { rateLimited: true, retryAfterMs };
}

/**
 * Shared timeout race. Returns a tuple of [promise, cancel] where the
 * promise rejects with `Error("ai timeout")` if `timeoutMs` elapses first.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  ctx: AiRuntimeContext,
): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ai timeout")), timeoutMs);
  });
  const abortPromise = ctx.signal
    ? new Promise<never>((_, reject) => {
        if (ctx.signal!.aborted) reject(new Error("aborted"));
        else ctx.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      })
    : null;
  const racers: Promise<T | never>[] = [work, timeoutPromise as Promise<never>];
  if (abortPromise) racers.push(abortPromise);
  const promise = Promise.race(racers) as Promise<T>;
  const cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return { promise, cancel };
}
