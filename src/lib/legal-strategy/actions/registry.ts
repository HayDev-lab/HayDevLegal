// src/lib/legal-strategy/actions/registry.ts
// Phase 7 — §21 — ACTION_REGISTRY: exhaustive specs for every legal action
// type recognized by the Strategy Engine.
//
// CRITICAL: "No LLM-invented action type." The candidate generator (§21)
// MUST only produce candidates whose `actionType` is in this registry. The
// verifier (§37) rejects any candidate whose action type is not present.
//
// Each ActionSpec defines:
//   - jurisdiction(s) where the action is recognized
//   - proceeding types it applies to
//   - procedural stages at which it is allowed (the wrongStageActionRate
//     metric fires when a candidate is proposed at a disallowed stage)
//   - required facts / events / metadata / evidence (described — the
//     prerequisites engine maps them to actual CaseFacts/ChronologyEvents)
//   - legal-basis categories (statute families that govern the action)
//   - timing requirements (described — the deadline model materializes them)
//   - procedural effect (§30 — what the action seeks procedurally; NOT
//     whether it will win)
//   - Phase 6 DocumentType mapping (§34 — RELEASE_MOTION→MOTION, etc.)

import type { ActionSpec, ActionType } from "../types";
import { ACTION_TYPES } from "../types";

// ---------------------------------------------------------------------------
// §21 — ACTION_REGISTRY (13 action types)
// ---------------------------------------------------------------------------

export const ACTION_REGISTRY: Record<ActionType, ActionSpec> = {
  // 1. MOTION — a general procedural motion filed with the court.
  MOTION: {
    type: "MOTION",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE", "BANKRUPTCY"],
    allowedStages: [
      "investigation",
      "first_instance",
      "first_instance_decided",
      "appeal",
      "appeal_decided",
      "cassation",
      "execution",
    ],
    requiredFacts: [
      "Pending court proceeding with identified case number",
      "Identifiable procedural posture and stage",
    ],
    requiredEvents: ["A verified procedural event anchoring the motion (hearing, filing, or decision)"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["Documentary support for the relief sought"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Filed during the proceeding at the appropriate stage; certain motions are time-barred after specific events.",
    ],
    proceduralEffect:
      "Requests the court to take a specific procedural step (e.g. set a hearing, compel disclosure, join a party). Does not by itself dispose of the merits.",
    draftDocumentType: "MOTION",
  },

  // 2. OBJECTION — opposition to a specific procedural act by the opposing party.
  OBJECTION: {
    type: "OBJECTION",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE", "BANKRUPTCY"],
    allowedStages: [
      "investigation",
      "first_instance",
      "first_instance_decided",
      "appeal",
      "appeal_decided",
      "cassation",
      "execution",
    ],
    requiredFacts: [
      "An identifiable procedural act by the opposing party (motion, request, evidence submission)",
      "The objected-to act's date and substance",
    ],
    requiredEvents: ["The procedural act being objected to (a verified filing or submission)"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["Documentary support for the objection (the opposing party's filing)"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Generally filed within the response window set by the court or statute after the objected-to act.",
    ],
    proceduralEffect:
      "Opposes a specific procedural act by the opposing party and asks the court to deny or modify it.",
    draftDocumentType: "OBJECTION",
  },

  // 3. APPEAL — first-level appeal from a first-instance decision.
  APPEAL: {
    type: "APPEAL",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE", "BANKRUPTCY"],
    allowedStages: ["first_instance_decided"],
    requiredFacts: [
      "A first-instance court decision has been issued",
      "The decision is final/communicated (not interlocutory in a way that bars appeal)",
    ],
    requiredEvents: ["Verified DECISION event for the first-instance decision"],
    requiredMetadata: ["court", "caseNumber", "proceduralStage"],
    requiredEvidence: ["The first-instance court decision (document)"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Filed within the statutory appeal period (commonly 7-30 days from decision/service, depending on proceeding type and code).",
    ],
    proceduralEffect:
      "Asks the appellate court to review the first-instance decision on procedural and/or substantive grounds and to affirm, modify, or reverse it.",
    draftDocumentType: "APPEAL",
  },

  // 4. CASSATION_APPEAL — cassation-level appeal.
  CASSATION_APPEAL: {
    type: "CASSATION_APPEAL",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE"],
    allowedStages: ["appeal_decided"],
    requiredFacts: [
      "An appellate court decision has been issued",
      "The cassation grounds (procedural violations, misapplication of law) are identifiable",
    ],
    requiredEvents: ["Verified DECISION event for the appellate court decision"],
    requiredMetadata: ["court", "caseNumber", "proceduralStage"],
    requiredEvidence: ["The appellate court decision (document)"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Filed within the statutory cassation period (commonly 30-60 days from the appellate decision).",
    ],
    proceduralEffect:
      "Asks the Court of Cassation to review the appellate decision for violations of substantive or procedural law, and to affirm, modify, reverse, or remand.",
    draftDocumentType: "CASSATION_APPEAL",
  },

  // 5. CONSTITUTIONAL_COMPLAINT — complaint to the Constitutional Court.
  CONSTITUTIONAL_COMPLAINT: {
    type: "CONSTITUTIONAL_COMPLAINT",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE", "CONSTITUTIONAL"],
    allowedStages: [
      "first_instance_decided",
      "appeal_decided",
      "cassation_decided",
      "concourt",
    ],
    requiredFacts: [
      "A specific constitutional right is alleged to have been violated",
      "Ordinary remedies exhausted (or an exception applies)",
    ],
    requiredEvents: [
      "Final domestic decision (or exhaustion of ordinary remedies)",
    ],
    requiredMetadata: ["parties", "jurisdiction"],
    requiredEvidence: ["The decision(s) alleged to violate the constitution"],
    legalBasisCategories: ["constitution", "constitutional_court_law"],
    timingRequirements: [
      "Filed within the statutory period after the final domestic decision (commonly 60 days).",
    ],
    proceduralEffect:
      "Asks the Constitutional Court to determine whether a specific legal act or court decision complies with the Constitution.",
    draftDocumentType: "CONSTITUTIONAL_COMPLAINT",
  },

  // 6. ECHR_STEP — a procedural step at the ECtHR level.
  ECHR_STEP: {
    type: "ECHR_STEP",
    jurisdiction: ["ECHR"],
    proceedingTypes: ["ECHR", "CRIMINAL", "CIVIL", "ADMINISTRATIVE"],
    allowedStages: ["cassation_decided", "concourt", "echr"],
    requiredFacts: [
      "Exhaustion of domestic remedies (or a recognized exception under Article 35)",
      "A specific Convention right is alleged to have been violated",
    ],
    requiredEvents: ["Final domestic decision"],
    requiredMetadata: ["parties", "jurisdiction"],
    requiredEvidence: ["The final domestic decision(s)"],
    legalBasisCategories: ["echr_convention"],
    timingRequirements: [
      "Application lodged within six months of the final domestic decision (Article 35).",
    ],
    proceduralEffect:
      "Initiates or advances a proceeding before the European Court of Human Rights. Does not replace the official ECHR application form.",
    draftDocumentType: "ECHR_APPLICATION_SUPPORT",
  },

  // 7. EVIDENCE_MOTION — motion to admit / produce specific evidence.
  EVIDENCE_MOTION: {
    type: "EVIDENCE_MOTION",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE"],
    allowedStages: ["investigation", "first_instance", "appeal"],
    requiredFacts: [
      "Specific evidence exists that has not yet been admitted",
      "The evidence is relevant to a material fact",
    ],
    requiredEvents: ["Pending court proceeding"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["The evidence sought to be admitted"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Generally filed before the close of the evidentiary phase of the proceeding.",
    ],
    proceduralEffect:
      "Requests the court to admit specific evidence into the record (e.g. witness, document, expert report).",
    draftDocumentType: "MOTION",
  },

  // 8. EXCLUSION_ARGUMENT — motion/argument to exclude unlawfully obtained evidence.
  EXCLUSION_ARGUMENT: {
    type: "EXCLUSION_ARGUMENT",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE"],
    allowedStages: ["investigation", "first_instance", "appeal"],
    requiredFacts: [
      "Specific evidence was obtained (or is alleged to have been obtained) unlawfully",
      "The specific procedural violation is identifiable (e.g. no warrant, no counsel, coercion)",
    ],
    requiredEvents: ["The procedural act that produced the evidence (search, seizure, interrogation)"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["The evidence sought to be excluded + the procedural record of how it was obtained"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "constitution",
    ],
    timingRequirements: [
      "Generally filed before the close of the evidentiary phase; some jurisdictions require a pre-trial motion.",
    ],
    proceduralEffect:
      "Asks the court to declare specific evidence inadmissible and to exclude it from the record based on a procedural violation in its collection.",
    draftDocumentType: "MOTION",
  },

  // 9. RELEASE_MOTION — motion for release from detention.
  RELEASE_MOTION: {
    type: "RELEASE_MOTION",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL"],
    allowedStages: ["investigation", "first_instance", "appeal"],
    requiredFacts: [
      "The subject is currently detained",
      "The legal basis for continued detention is disputed or has lapsed",
    ],
    requiredEvents: ["Verified detention event (ARREST or detention order)"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["Detention order + the procedural record"],
    legalBasisCategories: ["criminal_procedure_code", "constitution"],
    timingRequirements: [
      "May be filed at any time during detention; certain deadlines attach after the maximum statutory detention period.",
    ],
    proceduralEffect:
      "Requests the court to order the release of the detained person (or to substitute a less restrictive measure).",
    draftDocumentType: "MOTION",
  },

  // 10. DEADLINE_RESTORATION_REQUEST — request to restore a missed procedural deadline.
  DEADLINE_RESTORATION_REQUEST: {
    type: "DEADLINE_RESTORATION_REQUEST",
    jurisdiction: ["AM"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE"],
    allowedStages: ["first_instance_decided", "appeal_decided", "cassation"],
    requiredFacts: [
      "A procedural deadline was missed",
      "A recognized ground for restoration exists (e.g. no notice, force majeure)",
    ],
    requiredEvents: ["The missed deadline trigger event (e.g. decision communication)"],
    requiredMetadata: ["court", "caseNumber"],
    requiredEvidence: ["Proof of the ground for restoration (e.g. non-delivery record, medical certificate)"],
    legalBasisCategories: [
      "criminal_procedure_code",
      "civil_procedure_code",
      "administrative_procedure_code",
    ],
    timingRequirements: [
      "Filed within the statutory restoration window after the ground ceased (commonly short — e.g. 3-7 days).",
    ],
    proceduralEffect:
      "Requests the court to restore a missed procedural deadline so that a subsequent procedural act (appeal, objection) can be filed.",
    draftDocumentType: "REQUEST_TO_AUTHORITY",
  },

  // 11. DAMAGES_CLAIM — claim for damages (civil or administrative).
  DAMAGES_CLAIM: {
    type: "DAMAGES_CLAIM",
    jurisdiction: ["AM"],
    proceedingTypes: ["CIVIL", "ADMINISTRATIVE", "CRIMINAL"],
    allowedStages: ["first_instance", "first_instance_decided", "appeal"],
    requiredFacts: [
      "Identifiable harm (pecuniary or non-pecuniary)",
      "Causal link between the defendant's act and the harm",
    ],
    requiredEvents: ["The event causing the harm"],
    requiredMetadata: ["court", "parties"],
    requiredEvidence: ["Documentary evidence of the harm + causation"],
    legalBasisCategories: ["civil_code", "civil_procedure_code", "constitution"],
    timingRequirements: [
      "Filed within the statutory limitation period (commonly 3 years for civil damages; varies for state liability).",
    ],
    proceduralEffect:
      "Asks the court to award monetary compensation for pecuniary and/or non-pecuniary harm.",
    draftDocumentType: "CLAIM",
  },

  // 12. ADMINISTRATIVE_CHALLENGE — challenge to an administrative act.
  ADMINISTRATIVE_CHALLENGE: {
    type: "ADMINISTRATIVE_CHALLENGE",
    jurisdiction: ["AM"],
    proceedingTypes: ["ADMINISTRATIVE"],
    allowedStages: ["first_instance", "first_instance_decided", "appeal"],
    requiredFacts: [
      "An identifiable administrative act exists (decision, order, regulation)",
      "The act is final (administrative remedy exhausted, when required)",
    ],
    requiredEvents: ["The administrative act issuance event"],
    requiredMetadata: ["court", "parties", "jurisdiction"],
    requiredEvidence: ["The challenged administrative act (document)"],
    legalBasisCategories: ["administrative_procedure_code", "administrative_offences_code"],
    timingRequirements: [
      "Filed within the statutory challenge period (commonly 60 days from notification of the act).",
    ],
    proceduralEffect:
      "Asks the administrative court to invalidate, modify, or compel a specific administrative act.",
    draftDocumentType: "CLAIM",
  },

  // 13. OTHER — escape hatch for actions outside the standard taxonomy.
  OTHER: {
    type: "OTHER",
    jurisdiction: ["AM", "ECHR"],
    proceedingTypes: ["CRIMINAL", "CIVIL", "ADMINISTRATIVE", "BANKRUPTCY", "CONSTITUTIONAL", "ECHR", "OTHER"],
    allowedStages: [
      "investigation",
      "first_instance",
      "first_instance_decided",
      "appeal",
      "appeal_decided",
      "cassation",
      "cassation_decided",
      "concourt",
      "echr",
      "execution",
    ],
    requiredFacts: ["An identifiable procedural context"],
    requiredEvents: ["A verified procedural event anchoring the action"],
    requiredMetadata: ["parties"],
    requiredEvidence: ["Documentary support for the action"],
    legalBasisCategories: ["other"],
    timingRequirements: ["Varies — operator must identify the applicable rule."],
    proceduralEffect:
      "A procedural action outside the standard taxonomy. Operator must specify the goal clearly.",
    draftDocumentType: "OTHER",
  },
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Look up the ActionSpec for a given action type. */
export function getActionSpec(type: ActionType): ActionSpec {
  const spec = ACTION_REGISTRY[type];
  if (!spec) {
    // §21 — defensive: never return undefined; throw with a clear error so
    // the verifier can flag any LLM-invented action type.
    throw new Error(`Unknown ActionType: ${type}`);
  }
  return spec;
}

/**
 * Get all action types whose allowedStages contain the given stage AND whose
 * proceedingTypes contain the given caseType. The candidate generator uses
 * this to filter the registry to the actions relevant at the current
 * procedural posture.
 *
 * `OTHER` is always included as a fallback (per the registry spec — the
 * operator may need it for non-standard procedural actions).
 */
export function getActionsForStage(
  stage: string | null,
  caseType: string | null,
): ActionType[] {
  if (!stage && !caseType) {
    // No posture information — return the full registry. The generator will
    // surface them all as candidates with UNKNOWN prerequisites.
    return ACTION_TYPES.slice();
  }
  const out: ActionType[] = [];
  for (const t of ACTION_TYPES) {
    const spec = ACTION_REGISTRY[t];
    const stageOk = !stage || spec.allowedStages.includes(stage);
    const typeOk = !caseType || spec.proceedingTypes.includes(caseType);
    if (stageOk && typeOk) out.push(t);
  }
  // Always include OTHER (escape hatch) when at least one matching action
  // was found — otherwise the user has no fallback for non-standard
  // procedural actions.
  if (out.length > 0 && !out.includes("OTHER")) {
    out.push("OTHER");
  }
  // If nothing matched (e.g. an unrecognized stage), fall back to OTHER only.
  if (out.length === 0) {
    return ["OTHER"];
  }
  return out;
}

/**
 * §34 — Map an ActionType to its Phase 6 DocumentType. Used when the
 * strategy engine hands off to the Phase 6 drafting engine to produce
 * the actual document.
 *
 * Mapping (mirrors the registry's draftDocumentType field):
 *   MOTION                     → MOTION
 *   OBJECTION                  → OBJECTION
 *   APPEAL                     → APPEAL
 *   CASSATION_APPEAL           → CASSATION_APPEAL
 *   CONSTITUTIONAL_COMPLAINT   → CONSTITUTIONAL_COMPLAINT
 *   ECHR_STEP                  → ECHR_APPLICATION_SUPPORT
 *   EVIDENCE_MOTION            → MOTION
 *   EXCLUSION_ARGUMENT         → MOTION
 *   RELEASE_MOTION             → MOTION
 *   DEADLINE_RESTORATION_REQUEST → REQUEST_TO_AUTHORITY
 *   DAMAGES_CLAIM              → CLAIM
 *   ADMINISTRATIVE_CHALLENGE  → CLAIM
 *   OTHER                      → OTHER
 */
export function mapActionToDraftType(type: ActionType): string {
  const spec = getActionSpec(type);
  return spec.draftDocumentType;
}

/** Whether a given action type is recognized by the registry (§37 check). */
export function isRegisteredActionType(type: string): boolean {
  return ACTION_TYPES.includes(type as ActionType);
}
