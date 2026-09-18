# HayDevLegal — Local Setup Guide (Windows-First)

## Prerequisites

| Tool | Required? | Version | Purpose |
|------|-----------|---------|---------|
| **Bun** | Required | ≥1.3 | Package manager + runtime |
| **Node.js** | Required | ≥20 | Next.js server |
| **Git** | Required | ≥2.40 | Clone repository |
| **pdftotext** | Required | any | PDF text extraction (poppler-utils) |
| **LibreOffice** | Optional (QA) | any | DOCX→PDF visual verification |
| **pdftoppm** | Optional (QA) | any | PDF→PNG visual rendering |
| **Codex CLI** | Optional (AI) | ≥0.155 | Deep case analysis (ChatGPT login) |

### Installing pdftotext on Windows

```powershell
# Option 1: Chocolatey
choco install poppler

# Option 2: Manual download
# Download poppler-windows from https://github.com/oschwartz10612/poppler-windows/releases
# Add the bin/ directory to your PATH
```

### Installing Codex CLI on Windows

```powershell
# Codex CLI is installed as a dependency of @openai/codex-sdk
# After `bun install`, it's available at node_modules/.bin/codex
# To sign in:
node_modules\.bin\codex login
# Check status:
node_modules\.bin\codex login status
```

## Clone & Install

```bash
git clone https://github.com/HayDev-lab/HayDevLegal.git
cd HayDevLegal
bun install
```

## Environment

```bash
# Copy the example and adjust paths for your system
copy .env.example .env   # Windows
# cp .env.example .env   # Linux/macOS

# Edit .env:
# - DATABASE_URL: update the path to your local db/ directory
# - CASE_STORAGE_ROOT: update for your OS
# - DRAFT_STORAGE_ROOT: update for your OS
# - Optional: Ollama Cloud, Codex settings
```

## Database

```bash
# Generate Prisma client
bun run db:generate

# Push schema to SQLite (non-destructive — creates tables if missing)
bun run db:push

# Never use --accept-data-loss unless you understand what it does.
# For a fresh database: delete db/custom.db and run db:push again.
```

## Run

```bash
# Start the development server
bun run dev
# Open http://localhost:3000
```

## Verify

```bash
# Full deterministic verification
bun run verify
# (runs typecheck → lint → test)
```

## Optional: Codex ChatGPT Login

```bash
# Sign in with your ChatGPT account (opens browser)
codex login

# Verify login status
codex login status
# Expected: "Logged in as <your-email>" or "Not logged in"
```

## Optional: Ollama Cloud

1. Get an API key from https://ollama.com
2. Edit `.env`:
   ```
   OLLAMA_CLOUD_ENABLED=true
   OLLAMA_API_KEY=your-key
   OLLAMA_CLOUD_MODEL=llama3.1:70b
   ```
3. Restart `bun run dev`
4. Check `/api/health` — `ollama-cloud` should show `HEALTHY`

## Optional: Visual QA Dependencies

Visual QA tests (DOCX→PDF rendering, PDF→PNG inspection) require:
- **LibreOffice** (for DOCX→PDF conversion): https://www.libreoffice.org/download/
- **pdftoppm** (for PDF→PNG rendering): part of poppler-utils (see above)

These are NOT required for normal runtime — only for the `tests/integration/visual-qa.test.ts` suite.

## Troubleshooting

### Database path errors on Windows

Ensure `DATABASE_URL` uses forward slashes or `file:` protocol:
```
DATABASE_URL="file:C:/Users/YourName/HayDevLegal/db/custom.db"
```

### Codex not found

The `codex` binary is installed at `node_modules/.bin/codex` (or `node_modules\.bin\codex.cmd` on Windows). If health reports `UNAVAILABLE`, ensure your `PATH` includes the project's `.bin` directory, or set `CODEX_CLI_PATH` in `.env`.

### pdftotext not found

Install poppler-utils (see Prerequisites). Verify:
```bash
pdftotext -v
```

### Tests failing

```bash
# Run just the unit tests (fast, no external dependencies)
bun test tests/unit/

# Run a specific test file
bun test tests/unit/case-workspace-gold.test.ts
```

## Safe Local DB Reset/Backup

```bash
# Backup
cp db/custom.db db/custom.db.backup

# Reset (deletes all case data — irreversible)
rm db/custom.db
bun run db:push   # recreates fresh
```

## Case-File Storage & Privacy

Uploaded case files are stored at `CASE_STORAGE_ROOT` (default: `/tmp/haydevlegal-case-storage/` on Linux, update for Windows in `.env`).

- Files are stored with opaque IDs (not user filenames) — no path traversal.
- SHA-256 content hashing prevents duplicate storage.
- Archive-first deletion: cases must be archived before hard deletion.
- **Never commit real case files to git** — the `CASE_STORAGE_ROOT` directory is outside the repo.
- Synthetic test fixtures are used in tests — no real confidential data is committed.
