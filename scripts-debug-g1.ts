import { createDraftingFixture } from "./tests/helpers/drafting-fixture-builder";
import { buildDocumentPlan } from "./src/lib/legal-drafting/planning/document-plan";
import { assembleDeterministicSections } from "./src/lib/legal-drafting/assembly/deterministic-sections";
import { assembleFactSection } from "./src/lib/legal-drafting/assembly/fact-sections";
import { assembleLegalSection, assemblePrecedentSection, assembleLegalIssuesSection } from "./src/lib/legal-drafting/assembly/legal-sections";
import { assembleArgumentSection, assembleCounterargumentSection } from "./src/lib/legal-drafting/assembly/argument-sections";
import { assembleRequestSection } from "./src/lib/legal-drafting/assembly/request-sections";
import { runAllVerification } from "./src/lib/legal-drafting/verification";
import type { DraftSection } from "./src/lib/legal-drafting/types";

function mergeSections(det: DraftSection[], prose: DraftSection[]): DraftSection[] {
  const proseTypes = new Set(prose.map((s) => s.sectionType));
  const out: DraftSection[] = [];
  for (const d of det) {
    if (proseTypes.has(d.sectionType)) {
      const p = prose.find((s) => s.sectionType === d.sectionType);
      if (p) { out.push(p); continue; }
    }
    out.push(d);
  }
  for (const p of prose) {
    if (!out.some((s) => s.sectionType === p.sectionType)) out.push(p);
  }
  return out;
}

async function main() {
  const f = await createDraftingFixture("G1");
  const plan = await buildDocumentPlan(f.draftId, f.ctx, f.docType, f.goal);
  const det = await assembleDeterministicSections(f.draftId, plan, f.ctx);
  const prose: DraftSection[] = [
    assembleFactSection(f.ctx, plan, "hy", f.draftId),
    assembleLegalSection(f.ctx, plan, f.draftId),
    assemblePrecedentSection(f.ctx, plan, f.draftId),
    assembleLegalIssuesSection(f.ctx, plan, f.draftId),
    assembleArgumentSection(f.ctx, plan, f.draftId),
    assembleCounterargumentSection(f.ctx, plan, f.draftId),
    assembleRequestSection(f.ctx, plan, f.docType, f.goal, f.draftId),
  ];
  const sections = mergeSections(det, prose);
  console.log("\nfull sections:");
  for (const s of sections) {
    console.log(`  - ${s.sectionType}: sourceIds=${JSON.stringify(s.content.sourceIds)}, text="${s.content.text.slice(0, 100).replace(/\n/g, ' ')}..."`);
  }

  const result = await runAllVerification(f.draftId, sections, f.ctx, plan, f.sourceIdMap, f.goal, f.docType);
  console.log("\nVerification result:");
  console.log("passed:", result.passed);
  const names = ["factual", "legal", "citation", "quote", "relief", "completeness"];
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const failed = r.assertions.filter(a => !a.passed);
    console.log(`  [${i}] ${names[i]}: passed=${r.passed}, failures=${failed.length}`);
    for (const f2 of failed) {
      console.log(`      type=${f2.type}, detail=${f2.detail?.slice(0, 150)}`);
    }
  }
  await f.cleanup();
}
main().catch(console.error);
