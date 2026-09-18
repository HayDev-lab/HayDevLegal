import { createDraftingFixture } from "./tests/helpers/drafting-fixture-builder";
import { buildDocumentPlan } from "./src/lib/legal-drafting/planning/document-plan";
import { assembleDeterministicSections } from "./src/lib/legal-drafting/assembly/deterministic-sections";
import { assembleFactSection } from "./src/lib/legal-drafting/assembly/fact-sections";
import { assembleLegalSection, assemblePrecedentSection } from "./src/lib/legal-drafting/assembly/legal-sections";
import { assembleArgumentSection, assembleCounterargumentSection } from "./src/lib/legal-drafting/assembly/argument-sections";
import { assembleRequestSection } from "./src/lib/legal-drafting/assembly/request-sections";
import { runAllVerification } from "./src/lib/legal-drafting/verification";
import type { DraftSection, DocumentPlan } from "./src/lib/legal-drafting/types";

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

function normalizeText(t: string): string {
  let out = t.replace(/\[SUPPORT_REQUIRED:[^\]]*\]/g, "[SUPPORT_REQUIRED]");
  out = out.replace(/\[MISSING_INFORMATION:[^\]]*\]/g, "[MISSING_INFORMATION]");
  return out;
}

function normalizeSection(s: DraftSection): DraftSection {
  let text = s.content.text ?? "";
  let paragraphs = s.content.paragraphs;
  text = normalizeText(text);
  if (paragraphs) paragraphs = paragraphs.map(normalizeText);
  const sourceIds = s.content.sourceIds ?? [];
  if (text.trim().length > 0 && sourceIds.length === 0) {
    if (!text.includes("[SUPPORT_REQUIRED]") && !text.includes("[MISSING_INFORMATION]")) {
      text = `${text} [SUPPORT_REQUIRED]`;
    }
  }
  return { ...s, content: { ...s.content, text, paragraphs } };
}

async function main() {
  const f = await createDraftingFixture("G8");
  const plan = await buildDocumentPlan(f.draftId, f.ctx, f.docType, f.goal);
  const det = (await assembleDeterministicSections(f.draftId, plan, f.ctx)).filter(s => s.sectionType !== "procedural_history");
  const prose: DraftSection[] = [
    assembleFactSection(f.ctx, plan, "hy", f.draftId),
    assembleLegalSection(f.ctx, plan, f.draftId),
    assemblePrecedentSection(f.ctx, plan, f.draftId),
    assembleArgumentSection(f.ctx, plan, f.draftId),
    assembleCounterargumentSection(f.ctx, plan, f.draftId),
    assembleRequestSection(f.ctx, plan, f.docType, f.goal, f.draftId),
  ];
  const sections = mergeSections(det, prose).map(normalizeSection);
  console.log("\nfull sections:");
  for (const s of sections) {
    console.log(`  - ${s.sectionType}: sourceIds=${JSON.stringify(s.content.sourceIds)}`);
    console.log(`    text="${s.content.text.slice(0, 200).replace(/\n/g, " ")}"`);
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
      console.log(`      type=${f2.type}, detail=${f2.detail?.slice(0, 200)}`);
    }
  }
  await f.cleanup();
}
main().catch(console.error);
