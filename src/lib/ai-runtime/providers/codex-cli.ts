// src/lib/ai-runtime/providers/codex-cli.ts
// Codex CLI provider — REAL subprocess invocation (§35–§36, §40–§46).
//
// This is the FALLBACK transport for CASE_ANALYSIS. Per §14:
//   CASE_ANALYSIS → Codex SDK → Codex CLI → Ollama Cloud
//
// It spawns the `codex` binary as a subprocess (NO shell interpolation —
// §35) using the `exec` subcommand with these flags:
//
//   codex exec \
//     --json \                                  (JSONL events to stdout)
//     --sandbox read-only \                     (§42 — read-only sandbox)
//     --skip-git-repo-check \                    (workspace is not a git repo)
//     --ephemeral \                              (§44 — no persisted session files)
//     --ignore-user-config \                     (§36 — do not load ~/.codex/config.toml)
//     --ignore-rules \                           (§36 — do not load execpolicy .rules)
//     --output-schema <workspace>/output-schema.json \
//                                                (forces final response to conform
//                                                 to CodexCaseAnalysis JSON schema)
//     -o <workspace>/last-message.txt \          (clean last-message output file)
//     -C <workspace> \                           (§43 — isolated cwd)
//     <combined prompt>
//
// Controlled env (§36 — no inherited secrets): only PATH + HOME + CODEX_API_KEY
// (when set) are passed to the child. The cwd is the request-scoped workspace
// created by `createWorkspace()` — the subprocess sees only the case pack
// files written there.
//
// Output extraction strategy:
//   1. Read <workspace>/last-message.txt — cleanest path; the codex CLI
//      writes the model's final agent_message text here verbatim.
//   2. If empty/missing, parse stdout JSONL `item.completed` events of type
//      `agent_message` and concatenate their `text` fields. Take the LAST
//      agent_message (matches the SDK's `finalResponse` behavior).
//   3. If neither path produces content → SUCCESS_EMPTY.
//
// The extracted text is then run through:
//   - `extractJson()` (handles ```json fences and leading prose)
//   - Zod validation against `req.schema` (which is CodexCaseAnalysisSchema)
//   - `validateCodexOutput()` firewall (§46 — every evidenceId exists in pack)
//
// §20 (network=disabled / web search=disabled): the `--sandbox read-only`
// flag is the codex CLI's hard sandbox — it prevents the model from running
// ANY shell command that touches the filesystem or network with side
// effects. The codex CLI does not expose separate `network_access` /
// `web_search` config keys (verified via `codex features list` — the
// relevant flags are deprecated). The closed-evidence guarantee is therefore
// enforced by THREE layers: (a) read-only OS-level sandbox, (b) the system
// prompt forbidding outside authorities, (c) the post-hoc
// `validateCodexOutput()` firewall that rejects any unknown evidenceId.
//
// §21 (read-only sandbox): the workspace itself is a temp dir under
// /tmp/haydevlegal-case/<request-id>/ — the codex CLI sees only that dir
// (via -C) and is sandboxed read-only, so it cannot grant write access
// outside it.
//
// §22, §43, §44: workspace is request-scoped, created via
// `createWorkspace()`, cleaned up in `finally` (best-effort).
//
// §58 (honor AbortSignal): the subprocess is killed with SIGTERM if
// `ctx.signal` aborts; the spawnNoShell helper wires this up.
//
// §111 (never fake a pass): the binary is probed via `codex --version`
// (spawnSync, shell:false). If not found, `binaryAvailable` stays false and
// health() returns UNAVAILABLE.

import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderHealth,
  AiProviderId,
  AiResult,
  AiRuntimeContext,
  AiStructuredRequest,
  AiTextRequest,
} from "../types";
import { CODEX_CLI_CONFIG } from "../config";
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { CaseAnalysisPack, CodexCaseAnalysis } from "../codex";
import {
  CodexCaseAnalysisSchema,
  buildCasePrompt,
  cleanupWorkspace,
  createWorkspace,
  validateCodexOutput,
} from "../codex";
import {
  extractJson,
  isRateLimitError,
  withTimeout,
} from "../structured-generation";
import {
  clearCooldown,
  isInCooldown,
  remainingCooldownMs,
  triggerCooldown,
} from "../rate-limit";
import { incActive, decActive } from "../metrics";

const CAPABILITIES: AiProviderCapabilities = {
  structuredOutput: true,
  streaming: false,
  caseAnalysis: true,
  maxTokens: CODEX_CLI_CONFIG.maxTokens,
  defaultTimeoutMs: CODEX_CLI_CONFIG.defaultTimeoutMs,
};

// ---------------------------------------------------------------------------
// Spawn helper — §35 NO shell interpolation, §36 caps + timeout + signal kill,
// §58 honor AbortSignal.
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if the process was killed by SIGTERM (timeout or abort). */
  killed: boolean;
  /** True if the kill was triggered by ctx.signal abort (vs timeout). */
  aborted: boolean;
}

/**
 * Spawn a process with NO shell interpolation (§35). The binary name and
 * args are passed as an argv array; `shell: false` is enforced.
 *
 * §36: stdout/stderr are capped; the subprocess is killed on timeout.
 * §58: if `signal` aborts, the subprocess is killed with SIGTERM.
 */
function spawnNoShell(
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdoutCapBytes?: number;
    stderrCapBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const STDOUT_CAP = opts.stdoutCapBytes ?? 2 * 1024 * 1024; // §36 — 2MB
    const STDERR_CAP = opts.stderrCapBytes ?? 64 * 1024; // §36 — 64KB
    let stdout = "";
    let stderr = "";
    let killed = false;
    let aborted = false;
    let settled = false;

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_CAP) {
        stdout += chunk.toString("utf8").slice(0, STDOUT_CAP - stdout.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) {
        stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length);
      }
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore — process may have already exited
          }
        }, opts.timeoutMs)
      : undefined;

    // §58 — honor ctx.signal abort: kill the subprocess. Capture the signal
    // in a local so TS can narrow it inside the closure.
    const signal = opts.signal;
    const onAbort =
      signal && !signal.aborted
        ? () => {
            aborted = true;
            killed = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
          }
        : undefined;
    if (onAbort && signal) signal.addEventListener("abort", onAbort);
    // If the signal is already aborted at spawn time, kill immediately.
    if (signal?.aborted) {
      aborted = true;
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code, killed, aborted });
    });
  });
}

// ---------------------------------------------------------------------------
// Binary resolution — probe CODEX_CLI_CONFIG.binary first; fall back to
// node_modules/.bin/codex (where @openai/codex installs it as a dep of
// @openai/codex-sdk). Cache the resolved path + availability on the instance.
// ---------------------------------------------------------------------------

interface BinaryProbe {
  available: boolean;
  /** Absolute path to the codex binary, or null if not found. */
  path: string | null;
}

/**
 * Probe the codex binary by running `codex --version` (§35 — no shell).
 * Tries `CODEX_CLI_CONFIG.binary` first, then `node_modules/.bin/codex`.
 *
 * Per §111, NEVER fake a pass — if neither path resolves to a working
 * binary, `available` stays false.
 */
function probeCodexBinary(): BinaryProbe {
  const candidates: string[] = [];
  if (CODEX_CLI_CONFIG.binary && CODEX_CLI_CONFIG.binary.length > 0) {
    candidates.push(CODEX_CLI_CONFIG.binary);
  }
  // The codex binary is installed at node_modules/.bin/codex as a dep of
  // @openai/codex-sdk (verified: codex-cli 0.155.0).
  candidates.push(path.join(process.cwd(), "node_modules", ".bin", "codex"));

  for (const candidate of candidates) {
    try {
      // Use spawnSync for a one-shot version check — no shell interpolation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnSync } = require("node:child_process") as {
        spawnSync: typeof import("node:child_process").spawnSync;
      };
      const r = spawnSync(candidate, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        timeout: 3_000,
      });
      if (r.status === 0) {
        return { available: true, path: candidate };
      }
    } catch {
      // try next candidate
    }
  }
  return { available: false, path: null };
}

// ---------------------------------------------------------------------------
// JSONL parsing — extract the last agent_message text from codex exec events.
// ---------------------------------------------------------------------------

interface CodexEvent {
  type: string;
  item?: { type: string; text?: string };
  // Other fields are intentionally permissive — we only consult `type` +
  // `item.type` + `item.text`.
  [k: string]: unknown;
}

/**
 * Parse JSONL stdout from `codex exec --json`. Each line is one event.
 * Walks the events and collects every `item.completed` event whose
 * `item.type` is `agent_message`; returns the `text` of the LAST such event
 * (matches the SDK's `finalResponse` behavior — the model's final answer).
 *
 * Returns null when no agent_message event is found.
 */
function extractLastAgentMessage(jsonl: string): string | null {
  if (!jsonl || jsonl.trim().length === 0) return null;
  const lines = jsonl.split(/\r?\n/);
  let lastText: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: CodexEvent;
    try {
      evt = JSON.parse(trimmed) as CodexEvent;
    } catch {
      // Not valid JSON — skip (codex may emit partial lines during streaming).
      continue;
    }
    if (
      evt &&
      evt.type === "item.completed" &&
      evt.item &&
      evt.item.type === "agent_message" &&
      typeof evt.item.text === "string"
    ) {
      lastText = evt.item.text;
    }
  }
  return lastText;
}

// ---------------------------------------------------------------------------
// CaseAnalysisPack extraction — locate the pack JSON in the request messages.
// ---------------------------------------------------------------------------

/**
 * Extract the CaseAnalysisPack from the structured request's messages.
 *
 * The caller (codex-sdk sibling provider / router) sends the pack as the user
 * message content, optionally prefixed with an "EVIDENCE PACK:" header. We
 * find the first JSON object in the message and parse it.
 *
 * Returns INVALID_SCHEMA when no pack can be parsed.
 */
function extractPackFromMessages(
  messages: { role: string; content: string }[],
): CaseAnalysisPack | null {
  for (const m of messages) {
    if (typeof m.content !== "string" || m.content.length === 0) continue;
    // Fast path: the whole content is JSON.
    const direct = tryParseJson(m.content);
    if (direct && isCaseAnalysisPack(direct)) {
      return direct;
    }
    // Slow path: extract the first JSON object/array from the content
    // (handles "EVIDENCE PACK:" header + fenced JSON).
    const extracted = extractJson(m.content);
    if (extracted && isCaseAnalysisPack(extracted)) {
      return extracted as CaseAnalysisPack;
    }
  }
  return null;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isCaseAnalysisPack(v: unknown): v is CaseAnalysisPack {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.query === "string" &&
    Array.isArray(o.issues) &&
    Array.isArray(o.legislation) &&
    Array.isArray(o.cassationCases) &&
    Array.isArray(o.constitutionalCases) &&
    Array.isArray(o.echrCases) &&
    Array.isArray(o.otherEvidence)
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Real Codex CLI provider. Spawns the `codex` binary as a subprocess
 * against an isolated request-scoped workspace, parses the structured
 * output, and runs the closed-evidence firewall before returning.
 */
export class CodexCliProvider implements AiProvider {
  readonly id: AiProviderId = "codex-cli";
  readonly capabilities: AiProviderCapabilities = CAPABILITIES;

  // Cache the binary probe result on the instance (per §35 + the task
  // spec — do NOT rely on the registry's `binaryAvailable` flag, since
  // CODEX_CLI_CONFIG.binary defaults to "codex" which is not on PATH and
  // the registry's probe will fail).
  private binaryCache: BinaryProbe | undefined;

  private resolveBinary(): BinaryProbe {
    if (this.binaryCache) return this.binaryCache;
    this.binaryCache = probeCodexBinary();
    return this.binaryCache;
  }

  async health(): Promise<AiProviderHealth> {
    if (!CODEX_CLI_CONFIG.enabled) {
      return {
        status: "UNCONFIGURED",
        detail: "CODEX_CLI_ENABLED=false",
        lastCheckedAt: Date.now(),
      };
    }
    // Probe the binary OURSELVES (per the task spec — the registry's probe
    // uses CODEX_CLI_CONFIG.binary directly, which defaults to "codex" and
    // is not on PATH; we need to also try node_modules/.bin/codex).
    const probe = this.resolveBinary();
    if (!probe.available) {
      // §111 — never fake a pass. Honest UNAVAILABLE.
      return {
        status: "UNAVAILABLE",
        detail: "`codex` binary not on PATH (§111)",
        lastCheckedAt: Date.now(),
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        detail: `cooldown ${remainingCooldownMs(this.id)}ms`,
        lastCheckedAt: Date.now(),
      };
    }
    return {
      status: "HEALTHY",
      detail: `binary=${probe.path ?? CODEX_CLI_CONFIG.binary}`,
      lastCheckedAt: Date.now(),
    };
  }

  async generateText(
    _req: AiTextRequest,
    _ctx: AiRuntimeContext,
  ): Promise<AiResult<string>> {
    // Codex is a closed-evidence case analyzer, not a free-form text model.
    return {
      status: "UNAVAILABLE",
      provider: this.id,
      detail: "codex-cli generateText not implemented (§35 — codex is closed-evidence-only)",
    };
  }

  async generateStructured<T>(
    req: AiStructuredRequest<T>,
    ctx: AiRuntimeContext,
  ): Promise<AiResult<T>> {
    // -----------------------------------------------------------------
    // 1. Pre-checks (same as health + cooldown).
    // -----------------------------------------------------------------
    if (!CODEX_CLI_CONFIG.enabled) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "codex-cli not enabled",
      };
    }
    const probe = this.resolveBinary();
    if (!probe.available || !probe.path) {
      return {
        status: "UNAVAILABLE",
        provider: this.id,
        detail: "`codex` binary not on PATH (§111)",
      };
    }
    if (isInCooldown(this.id)) {
      return {
        status: "RATE_LIMITED",
        provider: this.id,
        retryAfterMs: remainingCooldownMs(this.id),
      };
    }

    const startedAt = Date.now();
    incActive(this.id);

    // The workspace is request-scoped — created here, cleaned up in finally.
    let workspace: { rootDir: string } | null = null;

    try {
      // -----------------------------------------------------------------
      // 2. Parse the CaseAnalysisPack from the request messages.
      // -----------------------------------------------------------------
      const pack = extractPackFromMessages(req.messages);
      if (!pack) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail:
            "codex-cli: no CaseAnalysisPack found in request messages (expected JSON with `query`, `issues`, `legislation`, …)",
        };
      }

      // -----------------------------------------------------------------
      // 3. Create the isolated workspace (§22, §43).
      // -----------------------------------------------------------------
      workspace = await createWorkspace(ctx.workspaceId, pack);

      // -----------------------------------------------------------------
      // 4. Build the prompt (§40).
      // -----------------------------------------------------------------
      const { system, user } = buildCasePrompt(pack);
      const combinedPrompt = `${system}

---

${user}

---

IMPORTANT: Output ONLY a single JSON object matching the CodexCaseAnalysis schema. No prose, no markdown fences.`;

      // -----------------------------------------------------------------
      // 5. Write the JSON schema file to the workspace (uses zod v4's
      //    native toJSONSchema() — zod-to-json-schema v3 doesn't support
      //    zod v4; verified empirically). This lets `--output-schema`
      //    enforce structured output at the CLI level (much more reliable
      //    than prompt-only enforcement).
      // -----------------------------------------------------------------
      const schemaPath = path.join(workspace.rootDir, "output-schema.json");
      try {
        // zod v4 exposes toJSONSchema as both a static `z.toJSONSchema(s)`
        // and an instance method `s.toJSONSchema()`. Both produce identical
        // draft/2020-12 JSON Schema.
        const jsonSchema = (z as unknown as {
          toJSONSchema: (s: unknown) => unknown;
        }).toJSONSchema(CodexCaseAnalysisSchema);
        await fs.writeFile(
          schemaPath,
          JSON.stringify(jsonSchema, null, 2),
          "utf8",
        );
      } catch {
        // Schema file is OPTIONAL — codex will still run, just without
        // CLI-level output-schema enforcement. The closed-evidence firewall
        // (§46) still validates the output post-hoc.
      }

      // The clean last-message file — codex writes the model's final
      // agent_message text here verbatim.
      const lastMessagePath = path.join(workspace.rootDir, "last-message.txt");

      // -----------------------------------------------------------------
      // 6. Spawn the codex subprocess (§35, §36, §58).
      // -----------------------------------------------------------------
      const args: string[] = [
        "exec",
        "--json", // JSONL events to stdout
        "--sandbox",
        "read-only", // §42 — read-only sandbox
        "--skip-git-repo-check", // workspace is not a git repo
        "--ephemeral", // §44 — no persisted session files
        "--ignore-user-config", // §36 — do not load ~/.codex/config.toml
        "--ignore-rules", // §36 — do not load execpolicy .rules
        "--output-schema",
        schemaPath, // forces final response to conform to JSON schema
        "-o",
        lastMessagePath, // clean last-message output file
        "-C",
        workspace.rootDir, // §43 — isolated cwd
        // Combined prompt as the positional argument.
        combinedPrompt,
      ];

      // Controlled env (§36 — no inherited secrets). Only PATH, HOME, and
      // CODEX_API_KEY (when set) are passed through. The codex-cli config
      // object does NOT carry the API key (the codex-sdk config does, but we
      // don't import it here to keep the cli provider self-contained). We
      // read CODEX_API_KEY from process.env directly.
      const childEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
      } as unknown as NodeJS.ProcessEnv;
      // Forward CODEX_API_KEY when present (auth — NOT a secret leak since
      // we explicitly allow-listed it).
      const codexApiKey = process.env.CODEX_API_KEY;
      if (codexApiKey && codexApiKey.length > 0) {
        childEnv.CODEX_API_KEY = codexApiKey;
      }

      const timeoutMs = req.timeoutMs ?? CODEX_CLI_CONFIG.defaultTimeoutMs;

      // Race the subprocess against the timeout + abort signal (§58).
      const subprocess = spawnNoShell(probe.path, args, {
        cwd: workspace.rootDir,
        env: childEnv,
        timeoutMs,
        stdoutCapBytes: 2 * 1024 * 1024, // §36 — 2MB (codex output can be large)
        stderrCapBytes: 64 * 1024, // §36 — 64KB
        signal: ctx.signal,
      });

      // withTimeout honors ctx.signal too (abort race) — keeps the
      // subprocess bound to the runtime context's deadline.
      const { promise, cancel } = withTimeout(subprocess, timeoutMs, ctx);

      let result: SpawnResult;
      try {
        result = await promise;
      } finally {
        cancel();
      }

      // -----------------------------------------------------------------
      // 7. Process the subprocess result.
      // -----------------------------------------------------------------

      // §58 — user aborted. (TIMEOUT has no `detail` field per AiResult;
      // diagnostic info is surfaced via stage trace.)
      if (result.aborted) {
        return {
          status: "TIMEOUT",
          provider: this.id,
        };
      }

      // Timeout (no abort, but the timer fired). Could also be an external
      // kill — we treat SIGTERM-with-no-clean-exit as a timeout.
      if (result.killed && result.exitCode !== 0) {
        return {
          status: "TIMEOUT",
          provider: this.id,
        };
      }

      // Non-zero exit — classify the error.
      if (result.exitCode !== 0) {
        const stderrSnippet = result.stderr.slice(0, 512);
        const rl = isRateLimitError(result.stderr);
        if (rl.rateLimited) {
          triggerCooldown(this.id, undefined, rl.retryAfterMs);
          return {
            status: "RATE_LIMITED",
            provider: this.id,
            retryAfterMs: remainingCooldownMs(this.id),
          };
        }
        return {
          status: "ERROR",
          provider: this.id,
          detail: `codex exec exit=${
            result.exitCode
          } stderr=${stderrSnippet.slice(0, 256)}`,
        };
      }

      // -----------------------------------------------------------------
      // 8. Extract the structured output. Prefer the clean last-message
      //    file (codex writes the model's final agent_message text there
      //    verbatim); fall back to JSONL parsing if the file is empty.
      // -----------------------------------------------------------------
      let rawText: string | null = null;

      // Primary path: read the last-message file.
      try {
        const handle = await fs.open(lastMessagePath, "r");
        try {
          rawText = await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        // File missing — fall back to JSONL parsing.
        rawText = null;
      }
      if (rawText !== null) {
        rawText = rawText.trim();
        if (rawText.length === 0) rawText = null;
      }

      // Fallback: parse JSONL `agent_message` events from stdout.
      if (rawText === null) {
        rawText = extractLastAgentMessage(result.stdout);
      }

      // No structured output produced.
      if (rawText === null || rawText.length === 0) {
        return {
          status: "SUCCESS_EMPTY",
          provider: this.id,
          latencyMs: Date.now() - startedAt,
        };
      }

      // -----------------------------------------------------------------
      // 9. JSON extraction (handles ```json fences and leading prose).
      // -----------------------------------------------------------------
      const extracted = extractJson(rawText);
      if (extracted === null || extracted === undefined) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail:
            "codex-cli: no JSON object found in codex output (extractJson returned null)",
        };
      }

      // -----------------------------------------------------------------
      // 10. Validate against req.schema (the caller-passed schema, which
      //     per the closed-evidence contract is CodexCaseAnalysisSchema).
      //     Also defensively validate against CodexCaseAnalysisSchema so we
      //     can run the §46 firewall with the right type.
      // -----------------------------------------------------------------
      const reqValidated = req.schema.safeParse(extracted);
      if (!reqValidated.success) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: `codex-cli: Zod schema validation failed — ${reqValidated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        };
      }

      // The closed-evidence firewall requires a CodexCaseAnalysis instance.
      // Validate against CodexCaseAnalysisSchema defensively (the caller's
      // schema may be a wider/narrower ZodType<T>; we need the canonical
      // shape for the firewall).
      const codexValidated = CodexCaseAnalysisSchema.safeParse(extracted);
      if (!codexValidated.success) {
        // req.schema passed but CodexCaseAnalysisSchema didn't — the caller
        // passed a non-canonical schema. Treat as INVALID_SCHEMA so we never
        // skip the firewall.
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail:
            "codex-cli: output passed req.schema but failed CodexCaseAnalysisSchema (firewall prerequisite)",
        };
      }
      const codexAnalysis: CodexCaseAnalysis = codexValidated.data;

      // -----------------------------------------------------------------
      // 11. §46 — closed-evidence firewall.
      // -----------------------------------------------------------------
      const verdict = validateCodexOutput(codexAnalysis, pack);
      if (!verdict.ok) {
        return {
          status: "INVALID_SCHEMA",
          provider: this.id,
          detail: `codex-cli firewall rejected: ${verdict.reason}`,
        };
      }

      // -----------------------------------------------------------------
      // 12. SUCCESS — clear cooldown, return value.
      // -----------------------------------------------------------------
      clearCooldown(this.id);
      return {
        status: "SUCCESS",
        value: reqValidated.data,
        provider: this.id,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      // -----------------------------------------------------------------
      // 13. Error handling — classify rate-limit / timeout / generic error.
      // -----------------------------------------------------------------
      const rl = isRateLimitError(err);
      if (rl.rateLimited) {
        triggerCooldown(this.id, undefined, rl.retryAfterMs);
        return {
          status: "RATE_LIMITED",
          provider: this.id,
          retryAfterMs: remainingCooldownMs(this.id),
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|aborted/i.test(msg)) {
        // TIMEOUT AiResult variant has no `detail` field — return the bare
        // status (the stage trace carries the error message).
        return {
          status: "TIMEOUT",
          provider: this.id,
        };
      }
      return {
        status: "ERROR",
        provider: this.id,
        detail: `codex-cli: ${msg.slice(0, 512)}`,
      };
    } finally {
      // §44 — workspace is request-scoped; cleanup in finally (best-effort).
      decActive(this.id);
      if (workspace) {
        await cleanupWorkspace(workspace.rootDir).catch(() => {
          /* best-effort */
        });
      }
    }
  }
}
