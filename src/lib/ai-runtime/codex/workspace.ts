// src/lib/ai-runtime/codex/workspace.ts
// Isolated workspace lifecycle for codex case analysis (§43–§44).
//
// Each codex run gets its own directory under /tmp/haydevlegal-case/<request-id>/
// with mode 0700 and files written with mode 0600. Workspaces are NEVER
// shared between users (§44) — the request id scopes ownership, and the
// caller is expected to call cleanupWorkspace() once the run is finished
// (success OR failure).
//
// The workspace contains:
//   case.json                — the full CaseAnalysisPack (self-contained reference)
//   issues.json              — pack.issues (LegalIssue[])
//   legislation.json         — pack.legislation
//   cassation.json           — pack.cassationCases
//   constitutional-court.json — pack.constitutionalCases
//   echr.json                — pack.echrCases
//   evidence.json            — flat list of all evidence with their ids/types
//                              (the master reference the codex CLI consults to
//                              know which evidence ids are permissible)
//
// The codex CLI (owned by Task 2's providers) writes `analysis.json` to the
// same directory. `readWorkspaceOutput` reads + Zod-validates that file and
// returns `null` (never throws) when missing or structurally invalid.
//
// `verifyNoRepositoryMutation` is a guard for the §89 test: after a codex
// run it should leave the project repository untouched. The function runs
// `git status --porcelain` and returns true only when stdout is empty.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { CodexCaseAnalysisSchema } from "./case-analysis-schema";
import type {
  CaseAnalysisPack,
  CodexCaseAnalysis,
  CodexWorkspace,
  LegalEvidence,
} from "./types";

const execFileAsync = promisify(execFile);

// /tmp is per-process-restart on most Linux distros; subdirectory keeps our
// workspaces isolated from other tooling that may use /tmp.
const WORKSPACE_ROOT = "/tmp/haydevlegal-case";

// File permissions — strict by design.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Create an isolated codex workspace for `requestId` (or a fresh UUID when
 * omitted) and populate it with the closed-evidence pack.
 *
 * Returns a descriptor with the absolute rootDir and a map of every file
 * written (relative path → content). The map is exposed so the caller can
 * surface the inputs in traces / logs without re-reading the filesystem.
 */
export async function createWorkspace(
  requestId: string | undefined,
  pack: CaseAnalysisPack,
): Promise<CodexWorkspace> {
  const id = requestId && requestId.length > 0 ? requestId : randomUUID();
  const rootDir = path.join(WORKSPACE_ROOT, id);

  // mkdir -p the workspace root (and parent) with 0700.
  await fs.mkdir(rootDir, { recursive: true, mode: DIR_MODE });
  // Re-chmod in case mkdir hit an existing dir whose mode we couldn't control.
  await fs.chmod(rootDir, DIR_MODE).catch(() => {
    /* best-effort — ignore */
  });

  const flatEvidence: LegalEvidence[] = [
    ...pack.legislation,
    ...pack.cassationCases,
    ...pack.constitutionalCases,
    ...pack.echrCases,
    ...pack.otherEvidence,
  ];

  const files: Record<string, string> = {
    "case.json": JSON.stringify(pack, null, 2),
    "issues.json": JSON.stringify(pack.issues, null, 2),
    "legislation.json": JSON.stringify(pack.legislation, null, 2),
    "cassation.json": JSON.stringify(pack.cassationCases, null, 2),
    "constitutional-court.json": JSON.stringify(pack.constitutionalCases, null, 2),
    "echr.json": JSON.stringify(pack.echrCases, null, 2),
    "evidence.json": JSON.stringify(flatEvidence, null, 2),
  };

  // Write every file with mode 0600. Sequential writes keep the permissions
  // race tight (concurrent writers from another request can't leak content
  // via shared fd).
  for (const [relative, content] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relative);
    const handle = await fs.open(fullPath, "w", FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.close();
    // Re-chmod in case umask overrode the open() mode.
    await fs.chmod(fullPath, FILE_MODE).catch(() => {
      /* best-effort — ignore */
    });
  }

  return { rootDir, files };
}

/**
 * Read `analysis.json` from the workspace and Zod-validate it.
 *
 * Returns:
 *   - The parsed CodexCaseAnalysis when the file exists and parses cleanly.
 *   - `null` when the file is missing OR fails Zod validation.
 *
 * NEVER throws. Callers decide what to do with a null result (degrade to
 * "analysis unavailable", retry, surface to the user, etc.).
 */
export async function readWorkspaceOutput(
  rootDir: string,
): Promise<CodexCaseAnalysis | null> {
  if (!rootDir || rootDir.length === 0) {
    return null;
  }

  const analysisPath = path.join(rootDir, "analysis.json");

  let raw: string;
  try {
    const handle = await fs.open(analysisPath, "r");
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // Missing file or unreadable — caller decides.
    return null;
  }

  if (!raw || raw.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CodexCaseAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data;
}

/**
 * Remove a workspace directory. Best-effort — never throws. Safe to call
 * multiple times, safe to call with a path that doesn't exist.
 */
export async function cleanupWorkspace(rootDir: string): Promise<void> {
  if (!rootDir || rootDir.length === 0) {
    return;
  }

  // Defense-in-depth: only delete paths under the codex workspace root.
  // Prevents a misconfigured caller from passing "/" or an arbitrary path.
  const normalized = path.resolve(rootDir);
  const normalizedRoot = path.resolve(WORKSPACE_ROOT);
  const relative = path.relative(normalizedRoot, normalized);
  if (relative.startsWith("..") || relative === "") {
    // Either outside our root, or the root itself — refuse to delete.
    return;
  }

  try {
    await fs.rm(normalized, { recursive: true, force: true });
  } catch {
    /* best-effort — ignore */
  }
}

/**
 * §89 test guard — confirm the repository under process.cwd() is unchanged.
 *
 * Runs `git status --porcelain` and returns true only when stdout is empty
 * (no modified, staged, or untracked files). Returns false when:
 *   - git is not installed or cwd is not a git repository;
 *   - the command times out (5s);
 *   - stdout is non-empty (something mutated).
 *
 * This function does NOT modify state and is safe to call from tests.
 */
export async function verifyNoRepositoryMutation(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      {
        cwd: process.cwd(),
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}
