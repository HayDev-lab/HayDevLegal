// src/lib/legal-research/evaluation/precedent-gold-set.ts
// Precedent relation gold tests (master prompt §29-§32, §68-§69).
//
// Safe default: a bare citation is REFERENCES (§30). Strong labels
// (APPLIES / FOLLOWS / DISTINGUISHES / LIMITS) require textual confirmation
// within the context window of the citation. Negative treatment (§69) is
// surfaced from DISTINGUISHES/LIMITS.

import { analyzePrecedentRelations, contextWindow } from "../analysis/precedent-relations";
import type { LegalEvidence } from "@/lib/legal-search/types";
import { ev } from "./gold-fixtures";

function pair(a: Partial<LegalEvidence> & { id: string; passage: string }, b: Partial<LegalEvidence> & { id: string; passage: string }) {
  return [ev({ sourceType: "cassation", court: "Վճռաբեկ դատարան", ...a }), ev({ sourceType: "cassation", court: "Վճռաբեկ դատարան", ...b })];
}

export interface PrecedentGoldCase {
  id: string;
  pack: LegalEvidence[];
  expect: { from: string; to: string; kind: string }[];
  mustNot?: { from: string; to: string; kind: string }[];
}

export const PRECEDENT_GOLD_CASES: PrecedentGoldCase[] = [
  {
    id: "P1-safe-default-references",
    pack: pair(
      {
        id: "A",
        caseNumber: "ՎԴ/0001/01/24",
        passage: "Դատարանը քննել է ՎԴ/0002/01/22 գործը և այլ հարցեր։",
      },
      { id: "B", caseNumber: "ՎԴ/0002/01/22", passage: "Դատարանի եզրակացություն։" },
    ),
    expect: [{ from: "A", to: "B", kind: "REFERENCES" }],
    mustNot: [{ from: "A", to: "B", kind: "FOLLOWS" }],
  },
  {
    id: "P2-applies-with-confirmation",
    pack: pair(
      {
        id: "A",
        caseNumber: "ՎԴ/0001/01/24",
        passage: "Դատարանը կիրառել է ՎԴ/0002/01/22 գործով ձևավորված իրավական դիրքը։",
      },
      { id: "B", caseNumber: "ՎԴ/0002/01/22", passage: "Դատարանի եզրակացություն։" },
    ),
    expect: [{ from: "A", to: "B", kind: "APPLIES" }],
  },
  {
    id: "P3-distinguishes-with-confirmation",
    pack: pair(
      {
        id: "A",
        caseNumber: "ՎԴ/0001/01/24",
        passage: "Դատարանը տարբերակել է ՎԴ/0002/01/22 գործի փաստական կողմը։",
      },
      { id: "B", caseNumber: "ՎԴ/0002/01/22", passage: "Դատարանի եզրակացություն։" },
    ),
    expect: [{ from: "A", to: "B", kind: "DISTINGUISHES" }],
  },
  {
    id: "P4-limits-negative-treatment",
    pack: pair(
      {
        id: "A",
        caseNumber: "ՎԴ/0001/01/24",
        passage: "Դատարանը սահմանափակել է ՎԴ/0002/01/22 գործի դիրքի կիրառությունը նոր պայմաններում։",
      },
      { id: "B", caseNumber: "ՎԴ/0002/01/22", passage: "Դատարանի եզրակացություն։" },
    ),
    expect: [{ from: "A", to: "B", kind: "LIMITS" }],
  },
  {
    id: "P5-no-self-relation",
    pack: [
      ev({
        id: "A",
        sourceType: "cassation",
        caseNumber: "ՎԴ/0001/01/24",
        passage: "Դատարանը հղում է կատարել ՎԴ/0001/01/24 գործին և քննել հարցը։",
      }),
    ],
    expect: [],
  },
];

export function runPrecedentGoldSet(): { total: number; passed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  for (const c of PRECEDENT_GOLD_CASES) {
    const relations = analyzePrecedentRelations(c.pack);
    let ok = true;

    for (const e of c.expect) {
      const found = relations.some((r) => r.fromId === e.from && r.toId === e.to && r.kind === e.kind);
      if (!found) {
        failures.push(`${c.id}: expected ${e.from} -[${e.kind}]-> ${e.to}, got [${relations.map((r) => `${r.fromId}:${r.kind}:${r.toId}`).join(", ")}]`);
        ok = false;
      }
    }
    for (const n of c.mustNot ?? []) {
      const found = relations.some((r) => r.fromId === n.from && r.toId === n.to && r.kind === n.kind);
      if (found) {
        failures.push(`${c.id}: forbidden relation ${n.from} -[${n.kind}]-> ${n.to} was claimed (§30 violation)`);
        ok = false;
      }
    }

    if (ok) passed++;
  }

  return { total: PRECEDENT_GOLD_CASES.length, passed, failures };
}

/** Context-window sanity: confirmation markers far away must not count. */
export function contextWindowIsolation(): boolean {
  const hay = `${"ա".repeat(400)} ՎԴ/0002/01/22 ${"բ".repeat(400)} տարբերակել է`;
  const win = contextWindow(hay, "ՎԴ/0002/01/22", 100);
  return !/տարբերակել/.test(win);
}
