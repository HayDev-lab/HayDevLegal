# HayDevLegal — Architecture

## Overview

HayDevLegal is an Armenian legal research, case-management, drafting, and strategy platform. It uses **NO RAG, NO vector database, NO fabricated facts/law/cases/quotes**. Legal authority comes only from verified official sources (ARLIS, Cassation, Constitutional Court, HUDOC). AI performs extraction, analysis, structuring, and synthesis — it is NEVER a legal source.

## System Architecture

```
                    HAYDEVLEGAL
                         │
          ┌──────────────┼──────────────┐
          │              │              │
   LEGAL RETRIEVAL    AI RUNTIME    CASE WORKSPACE
     (Phase 3)       (Phase 4.1)   (Phase 5/5.1)
          │              │              │
   ┌──────┼──────┐  Z-AI          ┌───┼───┐
   ARLIS  Courts  HUDOC  Ollama    Docs Facts Evidence
   Local   Web         Cloud       Chronology Contradictions
   Laws                 Codex      Issues Research
                    (ChatGPT)
          │              │              │
          └──────┬───────┘      ┌──────┘
                 │              │
          LEGAL RESEARCH    DRAFTING ENGINE
          INTELLIGENCE      (Phase 6/6.1/6.2)
           (Phase 4)             │
     ┌─────┼─────┐        Plan → Draft → Firewall
   Applicability  │        → Review → Export
   Distinguishing │        DOCX/PDF/TXT
   Argument Map   │              │
   Counter-Auth   │      STRATEGY ENGINE
                 └──── (Phase 7)
                        Action Registry
                        Prerequisites
                        Deadlines
                        Evidence Gaps
                        Strategy Map
```

## Phase Summary

| Phase | Module | Purpose |
|-------|--------|---------|
| 3 | `src/lib/legal-search/` | Federated retrieval: ARLIS, Local Laws, Datalex, Cassation, ConCourt, HUDOC, Web |
| 4 | `src/lib/legal-research/` | Issue map, holding extraction, material facts, applicability, distinguishing, argument map |
| 4.1 | `src/lib/ai-runtime/` | Multi-provider AI runtime: Z-AI (fast), Ollama Cloud (structured), Codex CLI+ChatGPT (deep) |
| 5/5.1 | `src/lib/case-workspace/` | Multi-volume ingestion, chronology, fact/evidence matrix, contradictions, search, stress |
| 6/6.1/6.2 | `src/lib/legal-drafting/` | Document plan, deterministic assembly, AI drafting, verification firewalls, DOCX/PDF/TXT export |
| 7 | `src/lib/legal-strategy/` | Action registry, procedural posture, prerequisites, deadline safety, evidence gaps, strategy map |

## Key Design Decisions

### No RAG / No Vector DB
Case material is searched via SQLite FTS5 / LIKE-based full-text search with exact identifiers, lexical matching, headings, dates, entities, case/article numbers. No embeddings, no pgvector, no Pinecone/Qdrant/Milvus/Weaviate.

### Verification Firewalls
Every AI output passes through layered verification:
1. Schema/Zod validation
2. Evidence ID validation (must exist in case workspace)
3. Document/page validation (page number ≤ document pageCount)
4. Case-number/article validation
5. Quote verification (must exist verbatim in cited source)
6. Holding verification
7. Proposition verification

### Source-of-Truth Rules
- **Legal authority**: ARLIS, Cassation decisions, Constitutional Court, HUDOC — verified official sources
- **Case evidence**: user-uploaded documents, extracted facts, chronology — provenance-preserved
- **AI role**: extraction, matching, analysis, structuring, synthesis — NEVER introduces new facts/law/cases/quotes

### No-Silent-Billing-Switch
Codex CLI (ChatGPT plan) is PRIMARY. If AUTH_REQUIRED/RATE_LIMITED → deterministic fallback. Codex SDK (API-key) is OPTIONAL only — never silently enabled when CLI is rate-limited.

### Strategy Informs; User Chooses
Strategy Engine builds non-ranked action candidates with prerequisites, evidence gaps, timing, authorities, counter-authorities, limitations. No "best option", no ranking, no outcome prediction. The user selects which action to pursue.

## Data Flow

```
USER QUESTION
    ↓
VERIFIED RETRIEVAL (ARLIS/Courts/HUDOC)
    ↓
EVIDENCE PACK
    ↓
LEGAL RESEARCH (Phase 4: applicability, distinguishing, argument map)
    ↓
CASE WORKSPACE (Phase 5: facts, evidence, chronology, contradictions)
    ↓
BOUNDED CASE ANALYSIS PACK (≤30 evidence items)
    ↓
CODEX DEEP ANALYSIS (when available) / DETERMINISTIC FALLBACK
    ↓
VERIFICATION FIREWALL
    ↓
LEGAL SYNTHESIS / DRAFT / STRATEGY MAP
```

## Technology Stack

- **Framework**: Next.js 16 (App Router) + TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui (New York style)
- **Database**: Prisma ORM + SQLite (local, no external DB server)
- **AI**: z-ai-web-dev-sdk (bundled), Ollama Cloud (optional), Codex CLI + ChatGPT (optional)
- **Document Export**: docx (DOCX generation), pdfkit (PDF generation)
- **Testing**: bun:test (455 tests, 22 files)
- **CI**: GitHub Actions (deterministic gate + separate live-integration workflow)
