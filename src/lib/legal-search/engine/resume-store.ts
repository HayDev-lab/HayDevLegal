// src/lib/legal-search/engine/resume-store.ts
// Bounded resume-token store for the interactive source-confirmation flow
// (Phase 3 §63-§64). Tokens bind a document reference to a DEDICATED source
// session; cookies never leave the server (§27).

import { randomBytes } from "node:crypto";
import { RESOLUTION } from "../config";

export type ResumeToken = {
  token: string;
  source: "datalex" | "judiciary";
  caseExternalId: string;
  appName: string;
  canonicalUrl: string;
  /** Server-side only — never logged, never sent to the client. */
  cookies: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
};

const tokens = new Map<string, ResumeToken>();

function prune(): void {
  const now = Date.now();
  for (const [k, t] of tokens) {
    if (t.expiresAt < now) tokens.delete(k);
  }
  while (tokens.size > RESOLUTION.maxResumeTokens) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
}

export function createResumeToken(init: Omit<ResumeToken, "token" | "createdAt" | "expiresAt" | "attempts">): ResumeToken {
  prune();
  const t: ResumeToken = {
    ...init,
    token: randomBytes(24).toString("hex"),
    createdAt: Date.now(),
    expiresAt: Date.now() + RESOLUTION.resumeTokenTtlMs,
    attempts: 0,
  };
  tokens.set(t.token, t);
  return t;
}

export function getResumeToken(token: string): ResumeToken | undefined {
  const t = tokens.get(token);
  if (!t) return undefined;
  if (t.expiresAt < Date.now()) {
    tokens.delete(token);
    return undefined;
  }
  return t;
}

export function dropResumeToken(token: string): void {
  tokens.delete(token);
}

/** Parse "source:externalId" document references from search results. */
export function parseDocumentRef(doc: string): { source: "datalex" | "judiciary"; externalId: string } | null {
  const m = doc.match(/^(datalex|judiciary):([A-Za-z0-9_-]{4,64})$/);
  if (!m) return null;
  return { source: m[1] as "datalex" | "judiciary", externalId: m[2] };
}
