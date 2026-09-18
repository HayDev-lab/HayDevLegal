# HayDevLegal — Local Continuation Guide

## What is Complete

| Phase | Status | Tests |
|-------|--------|-------|
| 3 — Retrieval | ✅ Complete | 7 tests (engine-core, local-laws, url-policy) |
| 4 — Legal Research | ✅ Complete | 4 tests (phase3-resolution, phase4-gold, phase4-research) |
| 4.1 — AI Runtime | ✅ Complete | 11 tests (ai-result-states, codex-routing, router-fallback, codex-chatgpt-auth) |
| 5/5.1 — Case Workspace | ✅ Complete | 53 tests (gold, stress, failure, security, health-three-providers) |
| 6/6.1 — Drafting | ✅ Complete | 56 tests (gold, formatting, invalidation) |
| 6.2 — Visual QA | ✅ Certified | 135 tests (DOCX/PDF/TXT round-trip, Armenian glyphs, rendering) |
| 7 — Strategy Engine | ✅ Foundation | Strategy gold/evaluator/negative-tests as library code |
| **Total** | | **455 tests, 0 failures** |

## What Was Independently Tested Now

- ✅ 455/455 deterministic tests pass
- ✅ Typecheck (0 errors in src/ + tests/)
- ✅ Lint (0 errors)
- ✅ Browser E2E (all tabs render, search/answer works, strategy tab works)
- ✅ Security regression (SSRF, path traversal, cross-case, secret scan — all clean)
- ✅ Gold fabrication metrics (all 13 drafting metrics = 0)
- ✅ Visual QA (DOCX/PDF generated, round-trip verified, Armenian glyphs preserved)

## What Remains External/Unverified

| Item | Status | Action Needed |
|------|--------|---------------|
| **Codex CLI live** | AUTH_REQUIRED | Run `codex login` locally with your ChatGPT account |
| **Ollama Cloud** | UNCONFIGURED | Set `OLLAMA_CLOUD_ENABLED=true` + `OLLAMA_API_KEY` in `.env` |
| **Live legal sources** | Not smoke-tested in sandbox | Run `bun test tests/unit/local-laws.test.ts` (uses local corpus) |
| **Visual QA with real documents** | Synthetic fixtures only | Test with sanitized copies of real case documents |

## Current Codex/Ollama Status

```
Codex:    AUTH_REQUIRED / cli-chatgpt  (not signed in)
Ollama:   UNCONFIGURED               (no API key set)
Z-AI:     HEALTHY                    (bundled SDK, always available)
```

## Recommended First Local Steps

1. **Clone and install**: Follow `LOCAL_SETUP.md`
2. **Authenticate Codex**: Run `codex login` → verify with `codex login status`
3. **Configure Ollama Cloud** (optional): Set env vars in `.env` → verify `/api/health`
4. **Test with sanitized real case**: Upload a copy of a real case document (PDF/DOCX) → verify ingestion → chronology → facts → evidence
5. **Fix issues from real use**: Document any bugs found with real data
6. **Only then decide next product phase**: Do NOT start Phase 8 prematurely

## Commands Before Every Change

```bash
# After any code change:
bun run typecheck   # TypeScript must pass
bun run lint        # ESLint must pass
bun run test        # All 455 tests must pass
bun run dev         # Dev server must start on port 3000
```

## How to Preserve Gold Metrics

- **Drafting gold metrics** (13 fabrication rates): Run `bun test tests/unit/legal-drafting-gold.test.ts`
- **Strategy metrics** (11 fabrication rates): Run `bun test tests/unit/legal-strategy-gold.test.ts` (if added) or check `src/lib/legal-strategy/evaluation/evaluator.ts`
- **Case workspace metrics** (12 metrics): Run `bun test tests/unit/case-workspace-gold.test.ts`
- All metrics must remain 0 for fabrication/invalid/silent-ranking/silent-billing categories.

## Where Real Case Data Should Live

- **Never commit real case files to git** — they are stored in `CASE_STORAGE_ROOT` (outside the repo)
- Use synthetic Armenian legal-style content for tests (already implemented)
- For real-case testing: create a local directory like `C:/Users/You/case-data/` and upload via the UI
- The `.gitignore` excludes `/upload/` and `CASE_STORAGE_ROOT` — real case data stays local

## What NOT to Commit

- `.env` (contains your API keys — gitignored)
- `db/custom.db` (contains real case data — not committed)
- `CASE_STORAGE_ROOT/` (uploaded case files — outside repo)
- `DRAFT_STORAGE_ROOT/` (generated drafts — outside repo)
- `agent-ctx/` (sandbox agent work records — gitignored)
- `tool-results/` (sandbox tool output — gitignored)
- `.zscripts/` (sandbox dev scripts — gitignored)
- Any file containing `ghp_`, `sk-`, `OPENAI_API_KEY`, `OLLAMA_API_KEY`, `CODEX_API_KEY` values

## Do NOT Invent Phase 8

Phase 7 (Strategy Engine) is the final planned product phase. Do NOT start:
- ❌ Phase 8 (autonomous filing)
- ❌ Electronic signature automation
- ❌ Auto-send to courts
- ❌ RAG/vector infrastructure
- ❌ More product features without a release blocker

The repository is ready to clone/download and continue locally.
