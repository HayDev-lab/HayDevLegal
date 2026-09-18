# HayDevLegal

Armenian legal research, case-management, drafting, and strategy platform.

**NO RAG. NO vector database. NO fabricated facts/law/cases/quotes.** Legal authority comes only from verified official sources. AI performs extraction, analysis, and synthesis — it is never a legal source.

## What HayDevLegal Does

### Legal Search (Phase 3)
Federated retrieval from ARLIS, Local Laws, Datalex, Cassation, Constitutional Court, HUDOC, and Web. Universal Document Resolver handles full-text retrieval with CAPTCHA-gated interactive resume.

### Legal Research Intelligence (Phase 4)
Issue decomposition, holding extraction, material fact identification, precedent applicability analysis, distinguishing, counter-authority detection, argument map construction, temporal validation.

### AI Runtime (Phase 4.1)
Multi-provider AI with sequential fallback routing:
- **Z-AI** — fast/light analysis (bundled, always available)
- **Ollama Cloud** — structured extraction + cloud fallback (optional, API key required)
- **Codex CLI + ChatGPT** — PRIMARY deep case analysis (ChatGPT login, no API key needed)
- **Codex SDK/API** — OPTIONAL only, never silently enabled

### Case Workspace (Phase 5/5.1)
Multi-volume document ingestion (PDF/DOCX/TXT, 16+ volumes, 10,000+ pages). Incremental/resumable processing. Chronology with Armenian/Russian/English date extraction. Fact Matrix with status tracking. Evidence Matrix. Contradiction detection. Legal issue linking. Bounded CaseAnalysisPack for Codex.

### Legal Document Drafting (Phase 6/6.1/6.2)
Verified drafting engine: DocumentPlan → deterministic assembly → AI drafting (Codex primary) → factual/legal/citation/quote/relief firewalls → human review → DOCX/PDF/TXT export. Court-ready formatting with Armenian Unicode. 13 fabrication metrics (all = 0). Visual QA certified.

### Strategy Engine (Phase 7)
Non-ranked action candidates from verified case data. Procedural posture analysis. Prerequisite evaluation (SATISFIED/NOT_SATISFIED/UNKNOWN/DISPUTED). Deadline safety (never invent). Evidence gap analysis. Counter-authority surfacing. Strategy map (no ranking, no outcome prediction). Phase 6 draft mapping.

## Quick Start

```bash
git clone https://github.com/HayDev-lab/HayDevLegal.git
cd HayDevLegal
bun install
copy .env.example .env   # Windows — adjust paths
bun run db:push
bun run verify            # typecheck + lint + test
bun run dev               # http://localhost:3000
```

See **[LOCAL_SETUP.md](LOCAL_SETUP.md)** for detailed setup including Codex login, Ollama Cloud, and visual QA dependencies.

## Documentation

- **[LOCAL_SETUP.md](LOCAL_SETUP.md)** — Prerequisites, installation, Codex/Ollama setup, troubleshooting
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System architecture, data flow, design decisions
- **[LOCAL_CONTINUATION.md](LOCAL_CONTINUATION.md)** — What's complete, what remains, recommended local steps

## Limitations

- **Codex live**: AUTH_REQUIRED in sandbox — run `codex login` locally to activate
- **Ollama Cloud**: UNCONFIGURED — set `OLLAMA_API_KEY` in `.env` to activate
- **No autonomous filing**: HayDevLegal does not submit to courts or authorities
- **No RAG/vector DB**: Case search uses SQLite FTS5/LIKE, not embeddings
- **Strategy informs; user chooses**: No ranking, no outcome prediction, no "best option"

## Technology

Next.js 16 · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · Prisma + SQLite · z-ai-web-dev-sdk · @openai/codex-sdk · docx · pdfkit · bun:test (455 tests)

## License

Private repository. See repository settings for details.
