// src/lib/legal-research/argument/evidence-strength.ts
// Argument strength computation (master prompt §47).
//
// DETERMINISTIC. Strength is NEVER set by politics or the desired answer.
// Inputs (each from a verified structured source):
//   primary authority / direct holding / factual similarity / temporal
//   validity / hierarchy / counter-authority / verification quality.

import type { ApplicabilityResult, LegalHolding } from "../types";
import type { LegalEvidence } from "@/lib/legal-search/types";

export type StrengthInput = {
  applicability: ApplicabilityResult;
  evidence: LegalEvidence;
  holdings: LegalHolding[];
  hasCounterAuthority: boolean;
};

export function computeStrength(input: StrengthInput): "STRONG" | "MODERATE" | "LIMITED" {
  const { applicability: app, evidence, holdings, hasCounterAuthority } = input;
  let score = 0;

  // Primary authority (verified full text from an official source).
  if (evidence.grade === "PRIMARY_VERIFIED") score += 2;
  else if (evidence.grade === "PRIMARY_METADATA") score += 1;
  else if (evidence.grade === "SECONDARY_VERIFIED") score += 1;

  // Direct holding — verified court position on the point.
  const verifiedHolding = holdings.some((h) => h.verification !== "REJECT");
  if (verifiedHolding) score += 2;

  // Factual similarity.
  if (app.factualSimilarity === "HIGH") score += 2;
  else if (app.factualSimilarity === "MEDIUM") score += 1;

  // Temporal validity.
  if (app.temporalCompatibility === "COMPATIBLE") score += 1;
  if (app.temporalCompatibility === "POTENTIALLY_STALE") score -= 1;
  if (app.temporalCompatibility === "INCOMPATIBLE") score -= 2;

  // Hierarchy.
  if (app.authority === "BINDING") score += 1;
  if (app.authority === "CONTEXTUAL") score -= 1;

  // Counter-authority present (§47 — must weaken).
  if (hasCounterAuthority) score -= 1;

  // Verification quality (§62 — Phase 4 never upgrades weak evidence).
  if (!evidence.identityVerified && evidence.fullTextVerified) score -= 1;

  if (score >= 6) return "STRONG";
  if (score >= 3) return "MODERATE";
  return "LIMITED";
}
