// HayDevLegal/scripts/debug-phase4.ts — debug failing Phase 4 assertions.
// Run: bun scripts/debug-phase4.ts
import { splitCourtSections, holdingEligibleText, partySubmissionTexts } from "@/lib/legal-research/analysis/document-sections";
import { verifyQuote, normText } from "@/lib/legal-research/verification/holding-verifier";
import { tokenOverlap } from "@/lib/legal-research/analysis/applicability";
import type { LegalIssue } from "@/lib/legal-research/types";

const ARM_TEXT = `ԿՈՂՄԵՐԻ ԴԻՐՔՈՐՈՇՈՒՄ
Մեղադրյալը պնդում է, որ իր իրավունքները խախտված են։
ԴԱՏԱՐԱՆԻ ՎԵՐԼՈՒԾՈՒԹՅՈՒՆ
Դատարանը եզրակացրել է, որ իրավունքները չեն խախտվել։`;

console.log("=== SECTIONS ===");
const sections = splitCourtSections(ARM_TEXT, false);
console.log(JSON.stringify(sections.map((s) => ({ kind: s.kind, title: s.title }))));
console.log("eligible:", JSON.stringify(holdingEligibleText(sections).slice(0, 60)));
console.log("party:", JSON.stringify(partySubmissionTexts(sections).join(" ").slice(0, 60)));

console.log("\n=== VERIFY QUOTE ===");
const text = "Դատարանը եզրակացրել է, որ կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում յուրաքանչյուր դեպքում։";
const q = "Դատարանը եզրակացրել է, որ կալանքի երկարաձգումը պահանջում է ռիսկի գնահատում ամենուր ամեն դեպքում";
const nq = normText(q);
console.log("normQuote len:", nq.length, "head80:", JSON.stringify(nq.slice(0, 80)));
console.log("hay includes head80:", normText(text).includes(nq.slice(0, 80)));
console.log("verdict:", verifyQuote(q, text));

console.log("\n=== TOKEN OVERLAP ===");
const issue: LegalIssue = {
  id: "I1", title: "Կալանքի երկարաձգման կարգը", description: "", category: "PROCEDURAL",
  relevantFacts: [], possibleLegalSources: [], status: "OPEN",
};
const passage = "Դատարանը եզրակացրել է, որ կալանքի երկարաձգման հարցը քննելիս պարտավոր է գնահատել ռիսկը";
console.log("overlap:", tokenOverlap(issue.title, passage));
console.log("issue tokens:", issue.title.toLowerCase().split(/[^\u0561-\u0587a-z0-9§]+/).filter((t) => t.length >= 4));
console.log("passage tokens:", passage.toLowerCase().split(/[^\u0561-\u0587a-z0-9§]+/).filter((t) => t.length >= 4));
