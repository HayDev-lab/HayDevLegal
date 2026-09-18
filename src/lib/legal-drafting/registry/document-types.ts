// src/lib/legal-drafting/registry/document-types.ts
// Phase 6 §5 — Document type registry.
//
// Each DocumentType has different required / optional sections, procedural
// constraints, and validation rules. The registry is the single source of
// truth for what a draft of a given type MUST contain — the planner, the
// deterministic assemblers, and the verifier all consult it.
//
// CRITICAL: never invent metadata. If a required field is missing the planner
// flags it under `missing_metadata` and the verifier asserts it as a
// `MISSING_METADATA` warning (§11 — "Unknown stays unknown").

import type { DocumentType, DocumentTypeSpec, SectionType } from "../types";

// ---------------------------------------------------------------------------
// §5 — Registry
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPE_REGISTRY: Record<DocumentType, DocumentTypeSpec> = {
  MOTION: {
    type: "MOTION",
    requiredMetadata: ["court", "caseNumber", "parties"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "arguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "precedents",
      "counterarguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must be addressed to the court handling the case.",
      "Must state the procedural stage at which it is filed.",
      "Relief requested must fall within the court's powers at that stage.",
    ],
    validationRules: [
      "Every factual proposition cites an F-id or CE-id in sourceIds.",
      "Every legal proposition cites an L-id, C-id, CC-id, or E-id.",
      "Relief must match the document goal + verified procedural context.",
    ],
  },

  OBJECTION: {
    type: "OBJECTION",
    requiredMetadata: ["court", "caseNumber", "parties"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "arguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "precedents",
      "counterarguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must be filed in response to a specific motion / action by the opposing party.",
      "Must reference the objected-to procedural act.",
    ],
    validationRules: [
      "Every factual proposition cites an F-id or CE-id in sourceIds.",
      "Every legal proposition cites an L-id, C-id, CC-id, or E-id.",
    ],
  },

  CLAIM: {
    type: "CLAIM",
    requiredMetadata: ["court", "parties"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "arguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "precedents",
      "counterarguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must identify the cause of action and the relief sought.",
      "Procedural posture must reflect the court in which the claim is filed.",
    ],
    validationRules: [
      "Relief must be derived from the document goal + applicable law.",
      "Facts must reflect their status (DOCUMENT_VERIFIED vs ALLEGED).",
    ],
  },

  RESPONSE: {
    type: "RESPONSE",
    requiredMetadata: ["court", "caseNumber", "parties"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "arguments",
      "counterarguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "precedents",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must respond to the opposing party's claims / motion point by point.",
      "Counterarguments must surface serious adverse authority (§20).",
    ],
    validationRules: [
      "Every counterargument cites a counter-authority id or a missing-evidence flag.",
    ],
  },

  APPEAL: {
    type: "APPEAL",
    requiredMetadata: ["court", "caseNumber", "parties", "proceduralStage"],
    requiredSections: [
      "header",
      "procedural_history",
      "facts",
      "legal_issues",
      "applicable_law",
      "arguments",
      "counterarguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "precedents",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must reference the lower court decision being appealed.",
      "Must specify the grounds of appeal (procedural and / or substantive).",
      "Filing deadline must be supported — never inferred (§11).",
    ],
    validationRules: [
      "Procedural history cites a CE-id or a [MISSING_INFORMATION] flag.",
      "Arguments are tied to enumerated grounds of appeal.",
    ],
  },

  CASSATION_APPEAL: {
    type: "CASSATION_APPEAL",
    requiredMetadata: ["court", "caseNumber", "parties", "proceduralStage"],
    requiredSections: [
      "header",
      "procedural_history",
      "facts",
      "legal_issues",
      "applicable_law",
      "precedents",
      "arguments",
      "counterarguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Grounds of cassation must be limited to those recognized by the RA Civil Procedure Code.",
      "Cassation precedents (C-ids) must be cited for every substantive proposition.",
      "Cannot introduce new evidence not presented to lower courts (except narrowly defined exceptions).",
    ],
    validationRules: [
      "Every substantive legal proposition cites a C-id cassation precedent.",
      "Counterarguments cite counter-authority (§20).",
    ],
  },

  CONSTITUTIONAL_COMPLAINT: {
    type: "CONSTITUTIONAL_COMPLAINT",
    requiredMetadata: ["parties", "jurisdiction"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "precedents",
      "arguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "counterarguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Must identify the constitutional right allegedly violated.",
      "Must demonstrate exhaustion of ordinary remedies (or justify the exception).",
      "ConCourt precedents (CC-ids) are required for substantive propositions.",
    ],
    validationRules: [
      "Every substantive legal proposition cites a CC-id ConCourt precedent.",
      "Applicable law must include the constitutional provision invoked.",
    ],
  },

  ECHR_APPLICATION_SUPPORT: {
    type: "ECHR_APPLICATION_SUPPORT",
    requiredMetadata: ["parties", "jurisdiction"],
    requiredSections: [
      "header",
      "facts",
      "legal_issues",
      "applicable_law",
      "precedents",
      "arguments",
      "requested_relief",
    ],
    optionalSections: [
      "introduction",
      "procedural_history",
      "counterarguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "§27 — must NOT replace the official ECHR application form requirements.",
      "Must identify the Convention articles allegedly violated.",
      "Must demonstrate exhaustion of domestic remedies (or justify exception under Article 35).",
      "Must be lodged within six months of the final domestic decision (date must be supported, not inferred).",
    ],
    validationRules: [
      "Every substantive legal proposition cites an E-id ECHR precedent or the Convention article.",
      "Applicable law must include the invoked Convention articles.",
    ],
  },

  LEGAL_MEMORANDUM: {
    type: "LEGAL_MEMORANDUM",
    requiredMetadata: ["parties"],
    requiredSections: [
      "header",
      "introduction",
      "facts",
      "legal_issues",
      "applicable_law",
      "precedents",
      "arguments",
      "counterarguments",
    ],
    optionalSections: [
      "procedural_history",
      "requested_relief",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Internal advisory document — does not need procedural formality.",
      "Counterarguments MUST surface serious adverse authority (§20).",
    ],
    validationRules: [
      "Every substantive proposition cites a fact / authority id.",
      "Missing material facts surfaced in missing_information section.",
    ],
  },

  FACTUAL_STATEMENT: {
    type: "FACTUAL_STATEMENT",
    requiredMetadata: ["parties"],
    requiredSections: ["header", "facts"],
    optionalSections: [
      "introduction",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "No legal arguments — facts only.",
      "Each fact must reflect its status (DOCUMENT_VERIFIED vs ALLEGED per §9).",
    ],
    validationRules: [
      "Every factual proposition cites an F-id or CE-id.",
      "Draft language must match the fact status (DOCUMENT_VERIFIED vs ALLEGED vs DISPUTED).",
    ],
  },

  REQUEST_TO_AUTHORITY: {
    type: "REQUEST_TO_AUTHORITY",
    requiredMetadata: ["parties", "jurisdiction"],
    requiredSections: ["header", "facts", "requested_relief"],
    optionalSections: [
      "introduction",
      "legal_issues",
      "applicable_law",
      "arguments",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Addressed to a specific administrative authority (§11 — never invented).",
      "Request must fall within the authority's statutory powers.",
    ],
    validationRules: [
      "Relief must match the authority's statutory powers + the document goal.",
    ],
  },

  OTHER: {
    type: "OTHER",
    requiredMetadata: ["parties"],
    requiredSections: ["header"],
    optionalSections: [
      "introduction",
      "procedural_history",
      "facts",
      "legal_issues",
      "applicable_law",
      "precedents",
      "arguments",
      "counterarguments",
      "requested_relief",
      "attachments",
      "missing_information",
    ],
    proceduralConstraints: [
      "Document type outside the standard taxonomy — operator must specify the goal clearly.",
    ],
    validationRules: [
      "Every substantive proposition cites an internal source id.",
    ],
  },
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Look up the DocumentTypeSpec for a given document type. */
export function getDocumentTypeSpec(type: DocumentType): DocumentTypeSpec {
  return DOCUMENT_TYPE_REGISTRY[type];
}

/** All sections (required + optional) for a given document type. */
export function allSectionsForType(type: DocumentType): SectionType[] {
  const spec = getDocumentTypeSpec(type);
  return [...spec.requiredSections, ...spec.optionalSections];
}

/**
 * §5 — Validate draft metadata against the document type's required fields.
 * Returns `{ ok, missing }`. Never throws — the planner / verifier surface
 * missing fields as warnings, not exceptions.
 */
export function validateDraftMetadata(
  type: DocumentType,
  metadata: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  const spec = getDocumentTypeSpec(type);
  const missing: string[] = [];
  for (const field of spec.requiredMetadata) {
    const v = metadata[field];
    if (v === undefined || v === null || v === "") {
      missing.push(field);
    } else if (typeof v === "string" && v.trim().length === 0) {
      missing.push(field);
    } else if (Array.isArray(v) && v.length === 0) {
      missing.push(field);
    }
  }
  return { ok: missing.length === 0, missing };
}
