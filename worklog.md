# Armenian Legal Search — Worklog

Source spec: `upload/Pasted Content_1787796407764.txt` (ARLIS live search + AI legal answer, Google-style UI).

---
Task ID: 0-discovery
Agent: main
Task: Phase 0 — DISCOVERY. Probe real ARLIS transport from sandbox, confirm outbound access, record endpoint + HTML structure.

Work Log:
- Probed `https://arlis.am/` → 302 → `https://arlis.am/hy/` (HTTP 200, 1.4MB HTML). SPA built with Vx components, locale `hy`.
- Inspected `/static/js/search.js`: home search form `POST /hy/search` renders results page; list fetched via AJAX `GET /{locale}/search/page/{page}?{encodeURIComponent(JSON.stringify(data))}&order_by={order}`.
- `request()` helper sends headers `X-REQUESTED-WITH: XMLHttpRequest`, `Accept: application/json`. Response JSON: `{status:number, message, html:string}`. `status===0` = OK; `status===-1` = error.
- Search `data` fields: `simple_text`, `number`, `year`, `act_type`, `enactment_org`, `signing_org`, `ratification_org`, `status`, `source`, `relevance`, `text_filter` (radio title|content), `exclude_changing_acts`, `official`, `exact_match`, `include_old_versions`, `catalog_id`.
- Verified real searches from sandbox:
  - `օրենք` → 88410-char HTML (many results)
  - `քրեական` → 48107-char HTML
  - `քրեական դատավարության օրենսգիրք` → 44096-char HTML, top hit `/hy/acts/6/latest` = ՀՀ ՔՐԵԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ
  - `ձերբակալում` (single word) → 458-char no-results HTML (ARLIS matches act titles/numbers, not arbitrary body words — important for query parser strategy)
  - `ՔԴՕ 108` → no-results (abbreviation not expanded by ARLIS; we must expand client-side)
- Act detail page `GET /hy/acts/{id}/latest` returns full HTML (1MB+) as a giant `<table>`; each article is a `<TR>` containing `<TD>Հոդված {N}. {title}</TD><TD>{body}</TD>`. Article 108 extracted cleanly.
- Act-card HTML structure (search result list):
  - `.act-card` container
  - `.act-card__title a[href="/hy/acts/{id}/latest"]` → canonical URL + title text
  - `.act-card__about-item` blocks: Ակտի համար (number), Ընդունման ամսաթիվ (adoption), Ուժի մեջ մտնելու ամսաթիվ (effective), Կարգավիճակ (status: Գործունակ/Չի գործունակ)
- AI runtime: use `z-ai-web-dev-sdk` (OpenCloud substitute in this sandbox). `chat.completions.create({messages, stream:true})` returns a `ReadableStream` of SSE frames when response content-type is `text/event-stream` or `text/plain`. Non-stream returns JSON `{choices:[{message:{content}}]}`.

Stage Summary:
- ARLIS_GATE: PASS — real outbound HTTP works, real JSON search endpoint confirmed, real canonical URLs confirmed, real article text extractable.
- Endpoint contract locked:
  - Search: `GET https://arlis.am/hy/search/page/1?{encodeURIComponent(JSON.stringify({simple_text:q}))}&order_by=` + headers `X-REQUESTED-WITH: XMLHttpRequest`, `Accept: application/json`.
  - Detail: `GET https://arlis.am/hy/acts/{actId}/latest`.
- URL allowlist: `https://arlis.am`, `https://www.arlis.am`.
- Next: build legal library + ARLIS adapter + API routes + UI.

---
Task ID: 1-build
Agent: main
Task: Phases 1-5 — Build the full Armenian Legal Search application (retrieval engine, Google-style UI, AI grounding, streaming, citations, E2E).

Work Log:
- Built Armenian legal library under `src/lib/legal/`:
  - `types.ts` — LegalSource, LegalQuery, SearchResponse, AnswerChunk, CitationRef, SourceLabel, QuestionType
  - `abbreviations.ts` — controlled dictionary (ՔԴՕ, ՔՕ, ՔՔՕ, ՔՔԴՕ, ՎԴՕ, ԱՕ, ՍԱ, ՍԴ, ՎԴ, ՄԻԵՎԴ…) + Unicode-aware tokenizer (JS \b does not work with Armenian; manual tokenization)
  - `normalizer.ts` — NFC, dash/quote/digit normalization, Armenian punctuation, article-notation normalization, abbreviation expansion, stripHtml
  - `query-parser.ts` — detects case numbers, exact articles (հոդված N / N հոդված / հ.N), act titles via abbreviation, dates, historical/current flags, questionType (exact_article / legal_rule / case_law / definition / procedure); builds ARLIS query variants (act-title-first to surface the primary code)
  - `url-security.ts` — ARLIS origin allowlist, canonicalizeArlisUrl, arlisActUrl
  - `cache.ts` — TtlCache with request coalescing (search 5 min, act detail 30 min)
- Built ARLIS adapter under `src/lib/arlis/`:
  - `arlis-client.ts` — bounded concurrency (4), retry w/ exp backoff, timeout, proper `X-REQUESTED-WITH` + `Accept: application/json` headers, JSON-encoded simple_text contract
  - `arlis-parser.ts` — parseSearchHtml (act-card → title/url/number/dates/status), extractArticle (table-row article extraction), extractActTitle/Status
  - `arlis-ranker.ts` — deterministic scoring (exactActTitle +55, exactActAndArticle +100, abbreviationMatch +30, title token overlap, body keyword match, status bonus/penalty), two-pass dedup (by actId, then by normalized title so the same code at different incorporations appears once)
  - `arlis-search.ts` — orchestrator: parse → build variants → arlisSearch each → merge → rank/dedup → top 4 → fetch article text for grounding → assign S1..S4
- Built API routes:
  - `POST /api/search` — returns SearchResponse with top 4 LegalSource[] + parsed query + retrieval status
  - `POST /api/answer` — SSE stream of AnswerChunk; Armenian system prompt (Կանոններ + Անվտանգություն + Պատասխանի կառուցվածք); grounds LLM with `<legal_source id="Sn">` blocks; hallucination firewall strips any [Sn] not in the valid source set; builds citations list from actually-used source IDs; defensive stream controller (guards against double-close + client disconnect); upstream reader cancelled on disconnect
  - `GET /api/health` — status pill / ops
- Built UI (`src/app/` + `src/components/legal/`):
  - `layout.tsx` — lang="hy", Armenian font stack (Noto Sans Armenian), SEO metadata, OpenGraph, viewport
  - `page.tsx` — single-route SPA; home (centered hero + search) ↔ results (sticky header search + 4 results + AI below); URL state via `?q=`; sticky footer via `min-h-screen flex flex-col` + `mt-auto`
  - `SearchBox.tsx` — Google-style; hero/compact sizes; Enter submits; Esc clears; example chips; loading spinner; Armenian IME/paste compatible
  - `SearchResults.tsx` — 4 result cards; ARLIS badge, source-label icon, article chip, status pill (emerald=գործունակ, amber=չի գործունակ), real ARLIS link, collapsible full text, metadata row, relevance %
  - `AgentAnswer.tsx` — SSE consumer; thinking→streaming→done/error states; abort (Stop) + retry; inline [Sn] citations rendered as superscript links to ARLIS; citations footer with used sources + request_id; auto-scroll; aria-live
  - `States.tsx` — SearchingState, ErrorState (retry), EmptyState, HomeHero
- SEO: `public/robots.txt`, `public/sitemap.xml`, canonical URL, Armenian meta description
- Styling: clean white/neutral palette (no indigo/blue per spec), custom scrollbar, streaming caret, entrance animations, `:lang(hy)` line-height 1.65

E2E verification (agent-browser):
- Home page renders: Armenian title, search box, 4 example chips, footer with ARLIS.am link. Sticky footer confirmed (scrollH=577=winH, footerBottom=577).
- Search "ՔԴՕ 108 հոդված": abbreviation expanded → 4 results, S1 = ՀՀ ՔՐԵԱԿԱՆ ԴԱՏԱՎԱՐՈՒԹՅԱՆ ՕՐԵՆՍԳԻՐՔ (act 228566, Գործում է). DOM order: search(0) → r1(168) → r2(470) → r3(772) → r4(1074) → AI(1392). AI NEVER above primary results (spec §49 ✓).
- AI streams Armenian text token-by-token; inline [S1] rendered as clickable superscript link → https://arlis.am/hy/acts/228566/latest with title tooltip. Done event fires → "Կրկին" button + "Օգտագործված աղբյուրներ" citations footer + request_id render.
- Hallucination firewall: only [S1] (valid) appears; no [S5]+ leaked.
- Empty state: query "zzznonexistent12345" → "համապատասխան վստահելի աղբյուր չի գտնվել" message.
- No horizontal scroll (scrollW=clientW). No console errors after stream-controller fix.
- Real ARLIS retrieval confirmed: every result URL is `https://arlis.am/hy/acts/{id}/latest` (validated origin allowlist).
- API smoke: `/api/search` returns 4 results in ~1.7-3.4s; `/api/answer` streams in ~27-33s with done+citations.

Stage Summary:
- REAL_ARLIS_SEARCH_PASS ✓ (real JSON endpoint, real titles, real canonical URLs, real article text)
- RETRIEVAL_PASS ✓ (normalization, parser, ranking, dedup, top 4, cache)
- SEARCH_UI_PASS ✓ (home + results, 4 results before AI, responsive, loading/errors/empty)
- AI_GROUNDING_PASS ✓ (Armenian system prompt, source-delimited context, citation firewall, streaming)
- REAL_E2E_PASS ✓ (browser → query → ARLIS → top 4 → AI → citations → ARLIS links)
- Definition-of-done items satisfied: public app loads ✓, Armenian search ✓, real ARLIS retrieval ✓, URLs to real ARLIS ✓, exact article search ✓, four results before AI ✓, AI streams ✓, citations map to sources ✓, unsupported claims prevented ✓, ARLIS/AI failure handled ✓, mobile responsive ✓, browser E2E ✓, no API keys in frontend ✓, no fabricated URLs ✓.
- Note: OpenCloud AI runtime is substituted by z-ai-web-dev-sdk (the supported AI runtime in this sandbox). The system prompt, grounding, and citation contract are provider-agnostic and identical to the spec.
- Next: create 15-minute webDevReview cron job for ongoing QA + feature expansion.


---
Task ID: 2-webdevreview
Agent: main (cron-triggered webDevReview)
Task: QA testing + bug fixes + new features (dark mode, follow-up questions, filter chips, markdown rendering, keyboard shortcut) + styling polish.

Work Log:

**QA Findings (via agent-browser):**
- Bug 1 (CRITICAL): Rapid re-search while AI streaming didn't reset the stream — old AI kept running with stale sources after query change. Root cause: `startedRef.current = true` blocked the effect from re-firing on new sources.
- Bug 2 (MEDIUM): After clicking Stop (abort), state went to "idle" with no way to restart — no Retry/Start button visible.
- Bug 3 (MEDIUM): AI streams could take 80-111s (runaway verbosity), risking timeouts.
- Bug 4 (CRITICAL): Auto-start effect had `start` in its deps. When `start()` called `setTurns([])`, the callback was recreated → effect cleanup ran → aborted the in-flight fetch. Root cause: effect cleanup aborting fetch on dep change, not just unmount.

**Bug Fixes:**
1. Rapid re-search: added `key={query}` prop to `<AgentAnswer>` in page.tsx → forces clean remount on every new search, tearing down old stream completely.
2. Abort/Retry UX: added "Սկսել վերլուծությունը" (Start analysis) button when `state === "idle"` and sources exist; after abort, state goes to "done" (not "idle") so Retry button shows.
3. max_tokens cap: added `max_tokens: 1200` to both streaming and fallback LLM calls → streams now complete in 11-23s (was 80-111s).
4. Auto-start abort: decoupled effect from `start` callback using `startRef` pattern — effect deps are `[autoStart, sources.length]` only; `start` is called via `startRef.current()`; cleanup only aborts on unmount.

**New Features:**
1. **Dark mode** (spec suggestion e): `ThemeProvider` using `useSyncExternalStore` (React-recommended for external stores — no hydration mismatch, no setState-in-effect). Theme toggle button in header. Persists to `localStorage('arlis-legal-theme')`. Respects OS `prefers-color-scheme` on first visit. Inline script in `<head>` sets `.dark` class before hydration to prevent flash. All components have `dark:` Tailwind variants.
2. **Follow-up clarifying question** (spec §52): Input field below AI answer ("Հստակեցնող հարց տալ աղբյուրների հիման վրա..."). Reuses current sources, maintains conversation history (up to 6 turns). API `/api/answer` accepts optional `history: {role, content}[]` parameter. System prompt adjusts for follow-ups (more concise). Prior turns shown as compact context above the latest answer.
3. **Source-type filter chips** (spec §50): When results span >1 source type (Օրենսդրություն / Վճռաբեկ դատարան / Սահմանադրական դատարան / ՄԻԵՎԴ), filter chips appear with per-type counts. Active filter highlighted; "Բոլորը" (All) resets.
4. **Markdown rendering** for AI answer: New `MarkdownAnswer` component parses headings (#/##/###), bullet lists (-/*/•), numbered lists (1.), **bold**, *italic*, `code`, > blockquote, and inline [Sn] citations. Citations rendered as superscript links to ARLIS. No raw HTML injection (XSS-safe).
5. **Keyboard shortcut** `/` (spec suggestion d): Pressing `/` anywhere (except when already in an input) focuses the search box and selects text. Hint shown in compact search bar on desktop.
6. **Collapsible AI answer**: Chevron up/down toggle to collapse/expand the answer body when done.
7. **Skeleton loading**: Shimmer-animated placeholder cards during "searching" state (replaces simple spinner-only state).

**Styling Polish:**
- Full dark mode across all components (SearchBox, SearchResults, AgentAnswer, States, footer, header)
- Result cards: left accent bar that darkens on hover, improved shadow/border transitions
- AI answer: proper prose typography (`.prose-legal` utility class with h1-h3, ul/ol, strong, code, blockquote styling)
- Status pills: emerald (գործունակ) / amber (չի գործունակ) with dark mode variants
- Smooth theme transitions (150ms cubic-bezier on bg/border/color)
- Enhanced entrance animations: `enter-legal` (cards), `enter-slide-up` (follow-up, filters)
- Shimmer skeleton: `shimmer-legal` with gradient animation (light + dark)
- Custom scrollbar with dark mode thumb colors
- Focus-visible outlines for keyboard navigation
- `:lang(hy)` line-height 1.65 for Armenian readability

**API Changes:**
- `POST /api/answer` now accepts optional `history: [{role: "user"|"assistant", content: string}]` (max 6 entries, 2000 chars each)
- `max_tokens: 1200` on all LLM calls (streaming + fallback)
- Follow-up-aware prompt: `buildUserPrompt(query, sources, isFollowUp)` — uses concise header/footer for follow-ups
- GET handler documents new `history` param + `max_tokens`

**E2E Verification (agent-browser):**
- Dark mode toggle: `.dark` class applied, `localStorage` persisted, persists across search navigation ✓
- Auto-start: fires immediately on results mount, no manual click needed ✓ (after startRef fix)
- AI streams to completion: 11-23s, done event received, citations footer + request_id render ✓
- Markdown: h2 headings, ul lists, inline [S1] citation links all render ✓
- Follow-up question: submitted via input, new stream starts with conversation context, answer appears below the follow-up question ✓ (5 citation links in follow-up answer)
- Rapid re-search: `key={query}` forces remount → new query gets fresh AI stream about the correct topic (Civil Code, not old Criminal Code) ✓
- Source-type filter chips: appear when >1 type present ✓
- Keyboard shortcut `/`: focuses search input, selects text ✓
- Skeleton loading: shimmer cards during search ✓
- Collapsible AI answer: expand/collapse toggle works ✓
- Lint: clean (0 errors, 0 warnings) ✓
- No console errors in dev log ✓

Stage Summary:
- All 4 bugs fixed and verified ✓
- 7 new features implemented and verified ✓
- 10+ styling improvements (dark mode, animations, typography, skeleton) ✓
- Core invariant maintained: 4 ARLIS results BEFORE AI answer ✓
- max_tokens cap keeps streams under 25s (was 80-111s) ✓
- Follow-up questions work with conversation history ✓
- Dark mode persists across navigation ✓
- Next: potential future features (historical-version awareness §16, query autocomplete, relevance gold-set test harness)


---
Task ID: 3-webdevreview
Agent: main (cron-triggered webDevReview)
Task: QA testing + new features (query autocomplete, recent searches, per-result deep-links, copy/share buttons) + styling polish (home hero redesign, contrast improvements, footer padding).

Work Log:

**QA Findings (via agent-browser + vision model):**
- No runtime bugs found — all previous fixes (rapid re-search, auto-start, max_tokens) remain stable
- Empty query → home page ✓; very long query (640 chars) → "չափազանց երկար" error ✓
- XSS attempt (`<script>alert(1)`) → blocked, no script injection ✓
- Mobile responsive → no horizontal scroll ✓
- Vision model review identified contrast/polish opportunities (home hero, CTA button, footer padding)
- Copy/share buttons initially didn't show success state in headless browser (clipboard API hangs) → fixed with Promise.race timeout + always-show feedback

**New Features:**
1. **Query autocomplete** (spec suggestion c): Curated dictionary of 120+ Armenian legal terms across 6 categories (օրենսգիրք, օրենք, դատական, հասկացություն, ընթացակարգ, կազմակերպություն). Smart matching: exact abbreviation → starts-with → word-boundary → loose contains. Dropdown shows term + expansion hint + category icon + category label. Highlighted matches in the dropdown. Keyboard navigation (↑↓ to navigate, Tab to fill, Enter to select, Esc to close).
2. **Recent searches** (localStorage): Last 8 searches persisted in `arlis-recent-searches`. Shown in autocomplete dropdown when search box is focused with empty query. Each entry has remove (×) button. "Մաքրել" (Clear) button to clear all. Uses lazy initializer (no setState-in-effect).
3. **Per-result deep-links** (spec suggestion g): Each result card now has an action row with "Բացել ակտը" (Open act) button linking to the full ARLIS act page, plus a "Հոդված {N}" button with `#article-{N}` anchor deep-link when an article is detected.
4. **Copy answer button**: Copies the AI answer text to clipboard. Shows checkmark (✓) for 2s after copy. Clipboard API with execCommand fallback + text-selection fallback + Promise.race timeout (never hangs).
5. **Share query link button**: Copies the shareable `?q=` URL to clipboard. Shows checkmark for 2s.

**Styling Polish:**
- Home hero redesign: larger 5xl bold heading with gradient text on "իրավական", badge with shadow-sm, 3 feature pills with icons (Scale, Sparkles, FileText), improved contrast (text-neutral-600/300 instead of 500/400)
- Search box: stronger border (neutral-300 instead of 200), 4px ring on focus (ring-neutral-100), more prominent CTA button (shadow-sm, px-6), darker placeholder text (neutral-500)
- Footer: increased padding (py-6/py-5), better contrast (text-neutral-500/400, links neutral-700/300), larger icon
- Autocomplete dropdown: clean white/dark card with shadow-xl, category-colored icons, highlighted match text, footer hint with keyboard shortcuts (↑↓ Esc)
- Result card action row: border-t separator, "Բացել ակտը" + "Հոդված {N}" buttons with BookOpen/ChevronRight icons, ARLIS act ID badge

**Files Created/Modified:**
- NEW: `src/lib/legal/legal-terms.ts` — 120+ curated Armenian legal terms + suggestTerms() + CATEGORY_META
- NEW: `src/components/legal/useRecentSearches.ts` — localStorage hook (lazy initializer, add/remove/clear)
- NEW: `src/components/legal/Autocomplete.tsx` — dropdown with suggestions + recent searches + keyboard nav + highlight
- MODIFIED: `src/components/legal/SearchBox.tsx` — integrated autocomplete, keyboard nav, recent searches, click-outside close, stronger styling
- MODIFIED: `src/components/legal/SearchResults.tsx` — added action row with deep-links (Բացել ակտը + Հոդված anchor)
- MODIFIED: `src/components/legal/AgentAnswer.tsx` — added copy/share buttons with clipboard fallbacks + timeout race
- MODIFIED: `src/components/legal/States.tsx` — redesigned HomeHero (gradient text, 3 feature pills, better contrast)
- MODIFIED: `src/app/page.tsx` — improved footer padding + contrast

**E2E Verification (agent-browser):**
- Autocomplete: typing "քդօ" → 4 suggestions, first = Criminal Procedure Code with expansion hint ✓
- Keyboard nav: ↑↓ navigates, aria-selected updates, Enter selects and searches ✓
- Recent searches: appear when search focused + empty, show previous queries with remove/clear buttons ✓
- Copy button: click → aria-label changes to "Պատճենվեց", checkmark icon appears ✓
- Share button: click → aria-label changes to "Հղումը պատճենվեց", checkmark appears ✓
- Deep-links: "Բացել ակտը" → ARLIS act URL; "Հոդված 108" → URL with #article-108 anchor ✓
- Home hero: gradient text, 3 feature pills, improved contrast ✓
- Mobile: no horizontal scroll ✓
- Lint: clean (0 errors, 0 warnings) ✓
- No new console errors ✓

Stage Summary:
- 5 new features implemented and verified ✓
- 4 styling improvements (hero, search box, footer, autocomplete) ✓
- Core invariant maintained: 4 ARLIS results BEFORE AI answer ✓
- Autocomplete with 120+ legal terms + keyboard navigation ✓
- Recent searches in localStorage with lazy initializer ✓
- Per-result deep-links with article anchors ✓
- Copy/share buttons with robust clipboard fallbacks ✓
- Next: potential future features (historical-version awareness §16, relevance gold-set test harness, query autocomplete from live ARLIS search API)


---
Task ID: 4-webdevreview
Agent: main (cron-triggered webDevReview)
Task: QA testing + bug fix (example chips regression) + new features (historical-version awareness §16, search insights panel, gold-set test harness §45) + styling polish.

Work Log:

**QA Findings:**
- Bug (REGRESSION): Example chips on home page disappeared after autocomplete integration. Root cause: `showExamples` initialized to `false`, only set to `true` on focus, but `autoFocus=true` on home meant `focused=true` from start, so condition `showExamples && !focused` never succeeded.
- Fix: Changed condition to `isHero && !value && !showDropdown` — examples show whenever the hero search box has no value and no autocomplete dropdown, regardless of focus state.
- No other runtime bugs found.

**New Features:**
1. **Historical-version awareness** (spec §16):
   - `DateSensitivityBanner` component: shows amber WARNING when user asks about a historical version ("նախկին խմբագրությամբ") or specific date ("2024 թվականին") — warns that ARLIS returns current version and historical applicability may differ. Shows emerald INFO note when user explicitly asks for current law ("գործող").
   - Token-based date-sensitivity detection: fixed JS `\b` word boundary issue with Armenian Unicode — now uses `keywords.includes("գործող")` / `keywords.includes("նախկին")` for standalone word detection.
   - API `/api/answer` accepts optional `dateContext: {date, wantsHistorical, wantsCurrent}` parameter. When present, injects a `⏰ ԺԱՄԱՆԱԿԱՅԻՆ ՈՒՇԱԴՐՈՒԹՅՈՒՆ` section into the LLM prompt instructing it to state temporal limitations.
   - `AgentAnswer` passes `dateContext` from the parsed query to the API.
   - Page passes `parsedQuery` date info to `AgentAnswer` and renders `DateSensitivityBanner` above results.

2. **Search insights panel** (spec §31):
   - `SearchInsights` component: compact panel showing parsed query structure — act title, article number, date, case number, question type (exact_article / legal_rule / case_law / definition / procedure), keywords, result count, retrieval time.
   - Appears between the query line and the results, helping users understand how the system interpreted their query.
   - Uses Armenian-localized labels and icons (Scale, Hash, Calendar, FileText, Lightbulb, Tag).

3. **Relevance gold-set test harness** (spec §45, §46):
   - `src/lib/legal/gold-set.ts`: 14 curated test queries across 7 categories (exact_code_article, natural_question, cassation, constitutional, law_title, abbreviation, no_result).
   - `GET /api/test/gold-set`: developer-facing endpoint that runs all gold-set queries against the real ARLIS pipeline and returns Recall@4, Exact Article Recall@4, pass/fail per query, avg duration.
   - **Results**: Total 14, Passed 11, Failed 3. Recall@4: 83.3%. Exact Article Recall@4: 100% ✓ (spec target ≥95%). Avg duration: 557ms (well under 1.5s target).
   - The 3 failures are natural-language queries that ARLIS doesn't match well (body-text searches return no results) — this is an ARLIS limitation, not a retrieval bug.

**Bug Fixes:**
- Example chips regression: fixed display condition to `isHero && !value && !showDropdown`
- Date-sensitivity detection: fixed Armenian word-boundary issue using token-based check instead of `\b` regex

**Files Created/Modified:**
- NEW: `src/components/legal/DateSensitivityBanner.tsx` — amber/emerald banner for date-sensitive queries
- NEW: `src/components/legal/SearchInsights.tsx` — parsed query structure panel
- NEW: `src/lib/legal/gold-set.ts` — 14 curated test queries + GoldTestResult/GoldSetSummary types
- NEW: `src/app/api/test/gold-set/route.ts` — test harness endpoint
- MODIFIED: `src/lib/legal/query-parser.ts` — token-based date-sensitivity detection (նախկին, հին, գործող, ընթացիկ, գործունակ)
- MODIFIED: `src/app/api/answer/route.ts` — accepts `dateContext`, injects temporal warning into LLM prompt
- MODIFIED: `src/components/legal/AgentAnswer.tsx` — accepts + passes `dateContext` prop
- MODIFIED: `src/app/page.tsx` — renders DateSensitivityBanner + SearchInsights, passes parsedQuery + dateContext
- MODIFIED: `src/components/legal/SearchBox.tsx` — fixed example chips display condition

**E2E Verification (agent-browser + curl):**
- Example chips: 4 chips visible on home page ✓
- Search insights: shows act title, article, question type, keywords, result count, retrieval time ✓
- Date-sensitivity banner: shows for "2024 թվականի ՔԴՕ 108 հոդված" with warning text mentioning the date ✓
- Date detection: `wantsCurrentLaw=true` for "գործող քրեական...", `date=2024` for year queries ✓
- Gold-set API: 14 tests run in 8s, 11 passed, Recall@4=83.3%, Exact Article Recall@4=100% ✓
- Lint: clean ✓
- No new console errors ✓

Stage Summary:
- 3 new features (historical-version awareness, search insights, gold-set test harness) ✓
- 2 bug fixes (example chips regression, Armenian word-boundary detection) ✓
- Gold-set metrics: Recall@4=83.3%, Exact Article Recall@4=100%, avg 557ms ✓
- Core invariant maintained: 4 ARLIS results BEFORE AI answer ✓
- Date-sensitivity context flows from query parser → API → AI prompt → user-visible banner ✓
- Next: potential future features (live ARLIS autocomplete API, per-result article text preview, search result export)


---
Task ID: 5-federated-search
Agent: main
Task: LIVE FEDERATED LEGAL SEARCH — implement online semantic-by-meaning search across Armenian legal internet sources WITHOUT RAG/vector DB/mirrors (master spec): query understanding, semantic + multilingual expansion, parallel live source adapters, document fetch, passage extraction, legal reranking, dedup, temporal validation, evidence pack, hallucination firewall, QUICK/DEEP modes, search trace UI.

Work Log:

**Phase 0 — Source reconnaissance (live probes from sandbox):**
- ARLIS: existing pipeline intact (search JSON + act detail HTML + article extraction).
- Datalex (datalex.am): REVERSED the BARL framework RPC — POST /json.php envelope {appName, moduleID:Common/ModGrid, function:getGridDataList, arg:[filterData, jqGrid, gridSearchDescription, sortByPrecedent]}. Session bootstrap via PHPSESSID. Grids: datalex_{civ,crim,adm,bankr}_case_info + _prec_ (precedents). VERIFIED live: civil "ծանուցում" → 727 precedents; criminal "խուզարկություն ապացույց" → 99,289 cases. Case VIEWING is CAPTCHA-gated → fetchDocument returns RESTRICTED, canonical URL provided (never bypassed).
- Constitutional Court (concourt.am): Symfony CSRF form — GET /decisions/advanced-search (session cookie + token) + GET with decision_text[type/description] params → server-rendered mainDecision blocks (dates, ՍԴՈ numbers, titles, matched passages, PDF links). PDFs public → pdftotext extraction works. VERIFIED live.
- HUDOC/echr.coe.int: Cloudflare 403 on ALL paths; Datalex HUDOC app is an iframe of the same blocked site → adapter reports honest RESTRICTED + builds user-openable deep links (eng#fragment state). No fabrication.
- judiciary.am: down/blocked; court.am: Nuxt SPA without server search → Cassation precedent practice served through Datalex _prec_ indices (official judicial-info-system mirror).
- Web: z-ai-web-dev-sdk functions.invoke("web_search") for general web results.

**Phase 1 — Architecture (src/lib/legal-search/, existing ARLIS untouched):**
- types.ts — LegalSourceAdapter contract (id/name/authority/sourceType/supports/search/fetchDocument/timeoutMultiplier), SearchContext, LegalSearchResult, LegalEvidence, SearchTrace, SourceStatus (SUCCESS/EMPTY/TIMEOUT/RATE_LIMITED/RESTRICTED/ERROR/UNSUPPORTED), FederatedSearchResponse.
- config.ts — ALL weights centralized: TIMEOUTS (per-source/document/total, env-tunable), STAGES (candidates 12/source, 60 total → rerank 15 → fetch 5/10 → evidence 8), RANK_WEIGHTS (exactRef 100 + lexical 60 + concept 50 + authority 40 + temporal 25 + citationQuality 20), AUTHORITY hierarchy (legislation 100 > ConCourt 95 > court 90 > HUDOC 85 > Datalex 75 > local 70 > web 20), POLICY (concurrency, query limits).
- security/url-policy.ts — SSRF hardening: scheme allowlist, localhost/0.0.0.0/::1/private ranges/link-local 169.254/metadata host blocks, IPv4-mapped-IPv6 whole-range block (URL API normalizes to hex — found via test), DNS resolution pinning (every address must be public, 60s cache), fetchGuarded() with timeout+size caps, readBodyCapped 3MB, contentHash.
- security/content-sanitizer.ts — nav/script/style removal, entity decode, structural newlines, truncatePassage at sentence boundaries.

**Phase 2 — Source adapters (engine knows nothing about sites):**
- arlis/adapter.ts — wraps existing retrieveLegalSources (topN=12, no article fetch in search; fetchDocument does act-detail + extractArticle).
- datalex/{client,adapter}.ts — RPC client (session cache 20min, grid cache 5min), case-law adapter (civil/criminal/admin/bankruptcy tabs by query intent, exact case-number mode 5), parties/claim/judge metadata, canonical case URLs.
- judiciary/adapter.ts — Cassation precedents via _prec_ grids + sortByPrecedent, authority=OFFICIAL_COURT, deep-mode only.
- constitutional-court/{client,adapter}.ts — CSRF bootstrap (module-load warm-up), word-root search, mainDecision block parser, PDF fetch + pdftotext, timeoutMultiplier 1.9 (1.5MB result pages).
- hudoc/adapter.ts — RESTRICTED + respondent=ARM deep links from multilingual EN concepts.
- web/adapter.ts — z-ai web_search (hy+en queries), official-domain boost, guarded doc fetch.
- local-laws/{loader,search,adapter}.ts — curated corpus loader (frontmatter, article index), NO-RAG search: exact article by alias/title/fuzzy (Levenshtein), lexical+concept scoring.

**Phase 3 — Engine (src/lib/legal-search/engine/):**
- query-understanding.ts — deterministic (existing parser + exact-reference extraction) + LLM-assisted deep mode (concepts + 3-5 subquestions, JSON-only contract, fence-stripping, truncated-JSON salvage, 20s budget, silent fallback).
- concept-lexicon.ts — 55 bilingual legal concepts (hy/en/ru + inflected forms + stems for Armenian morphology), domain tags.
- query-expansion.ts — exact references FIRST (§10), concept combos, related phrases, keyword fallback, LLM subquestion variants, multilingual EN/RU concept translation (§11), explosion caps (8 quick / 12 deep).
- source-orchestrator.ts — Promise.allSettled fan-out, per-source deadline race (multiplier-aware), stage-1 caps, trace entries.
- passage-extractor.ts — article-boundary splitting, token+concept scoring (multilingual tokens), top-3 passages.
- legal-reranker.ts — finalScore per spec §16, authority weighting, temporal bonus/penalty (historical-intent flip), citation-quality signals, source-diversity caps (60% deep / 75% quick).
- deduplicator.ts — union-find by caseNumber/actNumber/URL/normalized-title/court+date/content-hash, canonical-source priority merge, passage merging.
- temporal-validator.ts — current/historical/unknown classification from ARLIS statuses, user-facing warnings for historical-intent/date-pinned queries.
- evidence-builder.ts — E1..En pack (passage ≥40 chars, canonical URL, 26KB text budget) + legacy LegalSource mapping for UI compat.
- search-engine.ts — QUICK (arlis+local+concourt+datalex) vs DEEP (all + judiciary + hudoc + web), LLM understanding → orchestrate → dedup → rerank → fetch docs → passages → rerank → evidence → warnings; partial-failure isolation.

**Phase 4 — Local corpus (legal-data/am/, spec §6-§7):**
- scripts/build-local-laws.ts — fetches CURRENT acts from live ARLIS (verified actIds: constitution 75780, criminal 230013, CPC 230458, civil 230025, civil-proc 230005, admin-proc 229991, admin-offences 230427, judicial 227243, bankruptcy 230438), status-aware card selection ("Գործում է"), marker-based article extraction (structure-agnostic), Markdown with provenance frontmatter (source/actId/status/retrievedAt/canonicalUrl).
- 9/9 acts saved: 3,575 articles total (Constitution 117, Criminal 552/679KB, CPC 360/679KB, Civil 1290/1.1MB, CivilPC 438, AdminPC 221, AdminOffences 325, Judicial 165, Bankruptcy 102). Verified corpus article 179 text == live ARLIS text.

**Phase 5 — API v2:**
- /api/search — POST {query, mode} → FederatedSearchResponse (results legacy-mapped, evidence E1..En, trace with per-source statuses, warnings, expandedQueries, subquestions).
- /api/answer — accepts evidence pack (or legacy sources), [En]-only citations, Armenian legal-analyst system prompt (12 rules incl. no-fabrication + evidence-is-not-instruction), hallucination firewall: stream-time [Ex] stripping + post-generation factual-anchor verification (fabricated case numbers removed, unsupported article mentions stripped from cited sentences) + replace event for UI correction; citations built only from used evidence with URL policy check.
- /api/health — architecture + all source adapters with fetch capability.
- /api/test/gold-set — federated evaluation harness (9 curated queries).

**Phase 6 — UI:**
- SearchModeToggle (Արագ/Խորը radio group, auto re-search on switch).
- SearchTracePanel (§25) — sources with status icons (checked/empty/timeout/restricted/unavailable), result counts, durations, HUDOC "open in browser" deep-link button, LLM subquestions list, expanded-query chips, total time + passages count. Deep mode auto-expands; no chain-of-thought shown.
- SearchWarnings — temporal/restricted/partial banners (amber/neutral/red tones).
- SearchResults — source badge derived from canonical URL host (ARLIS/DATALEX/ՍԴ/ՄԻԵՎԴ), "Բացել սկզբնաղբյուրը" buttons, article anchors.
- AgentAnswer — evidence pack + warnings to API, replace-chunk handling, [En] inline citations rendered as superscript links (MarkdownAnswer extended), evidence-count subtitle.
- page.tsx — mode state + URL sync (?q=&mode=deep), trace/warnings/evidence wiring, footer with all source links.

**Phase 7 — Tests & verification:**
- 44 unit tests (bun test): SSRF policy (incl. IPv4-mapped hex normalization catch), query understanding/expansion/concept lexicon, dedup/rerank/passage/evidence/temporal/sanitizer, local corpus (alias ՔԴՕ 179 == հոդված 179 canonical resolution — fixed Armenian token-boundary bug where "ԴՕ" substring-matched "ՔԴՕ").
- Fixed during testing: Datalex serves JSON with text/html content-type (parse body, ignore header), LLM output fenced/truncated (strip + salvage), ConCourt timeout under parallel load (multiplier + session warm-up), horizontal overflow from HUDOC deep-link URL (removed inline URL, break-words), mobile widths (SearchInsights keywords, citations truncation, header search min-w-0).
- LIVE gold-set: 9/9 PASSED, Recall@N 100%, avg 7.4s. Source availability: arlis 5/9 (natural-language queries legitimately empty — ARLIS matches act titles), local-laws 7/9, datalex 5/5, constitutional-court 3/4, judiciary 3/3, hudoc 0/3 (honest RESTRICTED), web 3/3.
- LIVE deep search (master-spec example "ոստիկանությունը խուզարկության ժամանակ..."): 22s, evidence mix {ConCourt 3, judiciary 4, local 1}, 5 LLM subquestions, 4 docs fetched, HUDOC RESTRICTED warning + deep link.
- LIVE answer streaming: 752 events, citations only real evidence ids ([E3] CPC art 483), zero fabricated citations, replace-event pipeline verified.
- Browser E2E (agent-browser): home + mode toggle render; quick search → 6 ARLIS evidence cards with E1..E6, "Բացել սկզբնաղբյուրը" + "Հոդված 108" links, AI streams to done with citations footer; deep toggle → trace panel (4 sources, HUDOC restricted, 8.5s cached); dark mode toggle works; mobile 375px no horizontal scroll; desktop 1280px no horizontal scroll; console clean; tsc 0 errors; eslint 0 problems; dev.log 0 errors.

Stage Summary:
- LIVE_FEDERATED_SEARCH_PASS ✓ (6 working live sources + honest RESTRICTED for HUDOC; no RAG, no mirrors, no crawlers)
- QUERY_UNDERSTANDING_PASS ✓ (concepts + subquestions + multilingual, exact references override)
- EVIDENCE_PACK_PASS ✓ (E1..En with canonical URLs, passages, temporal status)
- HALLUCINATION_FIREWALL_PASS ✓ ([En]-only citations, anchor verification, replace correction)
- QUICK_DEEP_MODES_PASS ✓ (mode toggle, source sets, trace UI)
- LOCAL_CORPUS_PASS ✓ (9 current acts, 3,575 articles, provenance frontmatter)
- SECURITY_PASS ✓ (SSRF policy + tests)
- TESTS_PASS ✓ (44 unit + gold-set 9/9 live)
- E2E_PASS ✓ (browser-verified interactivity, responsive, dark mode)

---
Task ID: 6-phase3-full-document-resolution
Agent: main
Task: PHASE 3 MASTER PROMPT — Full Document Resolution + HUDOC + Datalex Session Flow + Cassation Multi-Source. Maximize the share of queries where HayDevLegal obtains the REAL FULL TEXT of the primary source (not just metadata/snippets), with honest gated-access states, identity-verified fallback resolution, and zero wrong documents.

Work Log:

**Phase 0 — Inspect & baseline:**
- Verified Phase 2 baseline per worklog: dev server healthy, 44/44 unit tests PASS. Trusted the code over the description.
- Read all core modules: types, config, url-policy, source-registry, search-engine, evidence-builder, passage-extractor, all 7 adapters, answer route, UI components.

**Phase 1 — Live probes (fresh, not from old data):**
- HUDOC: curl → Cloudflare 403 everywhere (browser UI + /app/query/results POST + ks.echr.coe.int). BUT Node/undici fetch PASSES Cloudflare! Discovered /app/query/results POST form is dead (404) — HUDOC was re-platformed.
- Reverse-engineered the CURRENT HUDOC API from compiled.js + live probes: GET /app/query/results?query=(contentsitename=ECHR) AND (appno="11275/07")...&select=...&sort=importance%20Desc — Solr-style chain; article facets use DASH form (article="5-3"); free-text = unfielded terms; response {resultcount, results:[{itemid, columns}]}. VERIFIED live: MURADYAN 11275/07 exact → real metadata; article 5-3 ARM → 192 results; /app/conversion/docx/html/body returns FULL JUDGMENT HTML (171KB).
- Datalex: showCase RPC contract reverse-engineered from ModCaseViewer/mod-case-view.js + BARL base.js: POST /json.php moduleID=ModCaseViewer function=showCase arg=["<captcha>"] module_params={caseID,...} → result:false + system_note errorType:"captcha" = CAPTCHA_REQUIRED; result.html = full case. Captcha image = plain GIF proxied per-session.
- CRITICAL Datalex regression found: the old flat filter (data[verdict][value][]) is SILENTLY IGNORED by the current backend — every query returned the same default listing (1051 rows). Live-verified NEW contract: NESTED {verdict:{value:[],type:[]}} + structured {case_number:"ՎԴ/0008/05/23"} (exact, total=1).
- court.am = Nuxt CMS portal (no decision DB; /api/v1 404s) — only useful for web-discovery. judiciary.am unreachable. echrcaselaw.com 403. worldcourts 404.
- z-ai web_search: HTTP 429 when >2 invocations run concurrently (live-reproduced) — HUDOC discovery silently degraded in the pipeline.

**Phase 2 — Implementation (all knobs in config.ts RESOLUTION/CONCURRENCY/SESSION_STORE):**
- types.ts: PARTIAL status; AccessState (DIRECT/SESSION_REQUIRED/CAPTCHA_REQUIRED/AUTH_REQUIRED/RATE_LIMITED/RESTRICTED); ExternalErrorKind (TIMEOUT/INVALID_RESPONSE/SERVER_ERROR/CLOUDFLARE_CHALLENGE/ACCESS_RESTRICTED/NOT_FOUND); ResolutionMethod ladder; evidence grades (PRIMARY_VERIFIED/PRIMARY_METADATA/SECONDARY_VERIFIED/DISCOVERY_ONLY); fullTextVerified/metadataVerified/identityVerified flags; RetrievalCompleteness; ResumableDocument; ResolutionCandidate/ResolvedLegalDocument; trace stages (search/metadata/document + resolutionNote).
- sources/session-store.ts (§26-27): bounded (16, LRU), TTL'd sessions; cookies server-side only; captcha keys expire independently; diagnostics never expose cookie values (tested).
- sources/web-search-client.ts: shared rate-limit-aware web_search queue (semaphore=2, 429 retry+backoff) — all three call sites (web adapter, HUDOC discovery, document resolver) now share it.
- hudoc/query-builder.ts (§7-10): HudocQueryBuilder — toApiFilter() builds the live-verified Solr chain (exact appno / respondent / dash-form article / documentType / free-text), toWebDiscoveryQueries() yields up to 3 sequential variants (exact first). normalizeConventionArticle handles Article 5 §3 / Art 5(3) / P1-1 / 6-րդ հոդված.
- hudoc/client.ts (§5-6, §11-20): searchHudocApi (GET contract, defensive parsing, language dedup EN>FR>translations), fetchHudocDocumentApi (conversion endpoint, 120KB cap), searchHudocViaWebDiscovery (official-domain discovery parsing real hudoc links+snippets into metadata-grade HudocDocuments; sequential variants with early exit), searchHudoc ladder (API → web discovery), getHudocMetadata. Outcome kinds incl. cloudflare_challenge (never confused with NOT_FOUND).
- hudoc/adapter.ts (§4, §8-10): exact-appno-first query building, respondent=ARM signal, PARTIAL/RESTRICTED mapped honestly, fetchDocument attempts the native doc endpoint. timeoutMultiplier 2.
- datalex/client.ts (§21-25): NESTED filter + structured case_number exact lookup (datalexExactCaseLookup across 4 grids); showCase RPC with captcha classification; bootstrapDatalexSession (dedicated per-user sessions); captcha image URL helper; grid cache keyed incl. caseNumber.
- datalex/adapter.ts (§22-23, §28): PARTIAL + CAPTCHA_REQUIRED outcome (case EXISTS, metadata valid); fetchDocument reuses valid session captchaKey (§24), else honest PARTIAL; exact lookup wired (guarded against ECHR appnos).
- judiciary/adapter.ts (§34-36): precedent grids + datalexExactCaseLookup (cassation numbers are primary identifiers §29); session-aware fetchDocument.
- engine/reference-extractor.ts (§37-39): extractLegalReferences (Armenian case numbers with proper Unicode-aware boundaries + 3-4 segments, ՍԴՈ, ECHR appnos, ECLI, articles, act numbers), rankReferences, buildCitationGraph (per-request only), selectFollowableReferences (follows only identifiers NOT already held).
- engine/document-resolver.ts (§30-33, §58-60, §65-67): resolveLegalDocument ladder (DIRECT API [adapters include ACTIVE_SESSION] → official-domain search → web discovery → SECONDARY → METADATA_ONLY); verifyIdentity (exact unique identifier auto-accept; strong combo court+date+title with title required + ≥2 signals); in-flight coalescing; bounded LRU doc cache; PDF path with pdfMaxBytes cap; official hosts preferred; SSRF policy on every fetch; health recording per capability.
- engine/search-engine.ts v2: resolver-based stage 3 (bounded CONCURRENCY.maxConcurrentDocumentFetches pool); PASS 2 reference following (deep mode, ≤maxReferenceFollows, ECHR appno → HUDOC exact, Armenian case → Datalex exact, ՍԴՈ → concourt); completeness computation; resumable collection; trace v2 enrichment; PARTIAL-aware warnings; captcha note (§51).
- engine/evidence-builder.ts v2 (§45-46): evidenceGrade + flags + documentRef + resolvedVia/Url/Source propagation to legacy UI mapping.
- engine/passage-extractor.ts 2.0 (§43): scorePassage now weighs exactReference, heading structure, term proximity, query intent (rule/practice), court-reasoning markers (hy+en), source authority; extractPassages passes per-document signals.
- engine/source-health.ts (§61-62): per-capability (search/document) health registry + circuit breaker (3 fails → 60s open, half-open).
- engine/resume-store.ts (§63-64): bounded resume tokens (random, TTL, attempt-capped, count-capped).
- app/api/resolve/* (§25, §63-64): GET bootstrap (dedicated Datalex session + token), GET captcha image proxy (token-bound cookies, no-store), POST resume (captcha submit → showCase retry → session retained for reuse → passages extracted against the original query). SSRF-checked; never blocks normal search.
- app/api/health: per-source SEARCH vs DOCUMENT health + session diagnostics (no cookie values).
- app/api/answer (§47-48, §15): evidence blocks now carry «Ամբողջական տեքստ՝ ՍՏՈՒԳՎԱԾ Է/ՉԷ»; system prompt rules 13-15 (no "court held" claims without verified full text; quotes only from verified passages; AI Armenian renderings of ECHR texts must be marked ոչ պաշտոնական թարգմանություն); verifyFactualAnchors now strips unverified «...» quotes to "(ոչ բառացի)".
- UI (§50-53, §25): SearchTracePanel v2 (per-source ✓/△/✕ stages for որոնում/մետատվյալներ/ամբողջական տեքստ + resolution notes + factual completeness block — no fake confidence); SearchResults access chips (§51 labels) + caseNumber chip + «Բացել ամբողջական տեքստը» unlock button + «Տեքստի աղբյուրը» link for fallback-resolved; SourceConfirmDialog (captcha image + input + refresh + confirm; in-place card upgrade on success); page.tsx wiring.
- query-parser fix (§29): CASE_NUMBER_RE now matches RAW text with uppercase-only Armenian court codes (the normalizer's abbreviation expansion destroyed ՎԴ prefixes — «դատարան/0008/05» bug) + 3-4 numeric segments; ECHR appno extraction (ՄԻԵՎԴ 11275/07 → caseNumber=11275/07). Datalex/Judiciary guarded against treating appnos as Datalex numbers.
- concourt adapter: supports()/wantsCc extended to cassation-precedent concepts (ConCourt legal positions are the primary definitional source for նախադեփ questions — live-verified).

**Phase 3 — Tests:**
- tests/unit/phase3-resolution.test.ts: 31 new tests (HUDOC query builder + article normalization + exact-appno priority; web-discovery parsing contract incl. press links and rejects; reference extractor incl. Armenian Unicode boundaries, ՍԴՈ, ECLI, self-reference exclusion, followable selection; resolver identity verification incl. wrong-doc rejection and strong-combo; session store lifecycle + cookie secrecy; evidence grading; Datalex PARTIAL+CAPTCHA_REQUIRED classification; resume-store parsing/lifecycle/expiry).
- Fixed during testing: JS \b doesn't work with Armenian letters (switched to lookarounds); Armenian case numbers have 3-4 segments; HUDOC press itemIds (00x- with extra dash); selectFollowableReferences must not filter cited identifiers (only held documents).
- Totals: 75 unit tests PASS (44 old + 31 new). tsc clean. eslint clean. build PASS.

**Phase 4 — Live verification (all against the running app):**
- QUICK ՔԴՕ 179: 6 evidence, 5 full texts, PRIMARY_VERIFIED.
- DEEP ձերբակալություն: judiciary precedent full texts RESOLVED VIA arlis.am fallback (identifiers verified); ConCourt PDFs; completeness {40 found, 8 metadata, 8 fullTexts, 5 via fallback}; resumable list populated.
- DEEP Article 5 §3 Armenia: HUDOC native API SUCCESS (5 cases, KUYUMJYAN PRIMARY_VERIFIED with operative-part passage) — §79 criteria met end-to-end.
- DEEP ՄԻԵՎԴ 11275/07: MURADYAN v. ARMENIA PRIMARY_VERIFIED via DIRECT_API with real passage; exactIdentifier found.
- Cassation exact ՎԴ/0008/05/23: exact case found via structured lookup (E1 judiciary, PRIMARY_METADATA + unlock button).
- /api/resolve live flow: bootstrap 200 → captcha GIF proxied (image/gif 200x60) → wrong captcha → captcha_required (correct classification) — the real solve is user-only by design.
- Answer engine live: 773 events, citations [E1 E2 E4 E5] all valid; NO invented case numbers/articles/URLs; no unverified quotes; replace-event pipeline works.
- RESOLUTION GOLD SET (§76-78): 8/8 PASSED; metrics: metadataHitRate 100%, fullTextResolutionRate 87.5%, primaryFullTextRate 87.5%, fallbackResolutionRate varies (0-62.5% run-dependent), wrongDocumentRate 0.0%, exactIdentifierAccuracy 100%.
- ORIGINAL GOLD SET (§84 regression): 9/9 PASSED, recall@N 100%.
- Browser E2E (agent-browser): home; quick results with access chips; deep results with trace stages (✓/△/✕) + completeness line + resolution notes; VD-exact deep: 8 cards — 1 «Պահանջվում է աղբյուրի հաստատում» + 7 «Պաշտոնական ամբողջական տեքստ»; captcha dialog opens (title, case number, image, input, confirm button verified in DOM); HUDOC case card (MURADYAN) with ՄԻԵՎԴ badge; dark mode; mobile 375px scrollWidth=375 (no overflow); console clean.

Stage Summary:
- FULL_DOCUMENT_RESOLUTION_PASS ✓ (resolver 2.0 with identity verification; coalescing+cache; §59-60)
- HUDOC_LIVE_PASS ✓ (native GET API + conversion endpoint work from Node egress; web-discovery fallback; language dedup; §79 chain verified)
- DATALEX_SESSION_FLOW_PASS ✓ (nested-filter fix; structured exact lookup; showCase captcha contract; dedicated sessions; interactive resume; PARTIAL honesty §23)
- CASSATION_MULTI_SOURCE_PASS ✓ (precedent grids + exact numbers + official-domain discovery; passages prioritize court reasoning §36)
- EVIDENCE_V2_PASS ✓ (grades, fullTextVerified≠metadataVerified, completeness §52, no fake confidence §53)
- ANSWER_RULES_PASS ✓ (§47-48 quote/citation firewall extended and live-verified)
- SECURITY_PASS ✓ (SSRF tests intact; session cookies server-only; resume tokens bounded; captcha proxy fixed-URL)
- NO_REGRESSION_PASS ✓ (gold 9/9, resolution gold 8/8, 75 unit tests)
- BUILD_GATE_PASS ✓ (tsc, eslint, bun test, next build, browser E2E)
- Remaining external limitations: HUDOC API/conversion reachable only from egresss where Cloudflare clears Node/undici (this runtime: OK); Datalex full texts remain user-captcha-gated by design (never bypassed); web_search rate limit (429) handled via shared serialized queue.

---
Task ID: restore-lost-modules
Agent: main (Super Z)
Task: Post-sandbox-reset restoration — the `local-*` and `test` .gitignore patterns had silently excluded two source trees from every commit. Reconstructed them from the surviving worklog + probe artifacts, then re-ran all quality gates.

Work Log:
- ROOT CAUSE: `.gitignore` line `local-*` (bare prefix pattern) matched `src/lib/legal-search/local-laws/`, and line `test` matched `src/app/api/test/`. Both modules existed only in dead sandboxes: a fresh clone failed tsc (TS2307 Cannot find module '../local-laws/adapter') and `phase3-resolution.test.ts` could not even load (36 tests missing).
- Reconstructed `src/lib/legal-search/local-laws/` (loader/search/adapter, spec §6-§7 + worklog description):
  - loader.ts — frontmatter + `## Հոդված N` parsing of legal-data/am (9 acts, 3,570 articles + 9 prefaces), curated short titles/aliases per category, flat article list + inverted indexes (exact word form + 5-char inflection-prefix + title), lazy/memoized per-directory loading, LOCAL_LAWS_DIR exclusive override, fail-closed empty corpus.
  - search.ts — deterministic NO-RAG ladder: (1) act resolution via ABBREVIATIONS token-exact (ՔԴՕ/ՔՕ/ՍԱ…, the historic ԴՕ-substring bug impossible by construction), boundary-regex phrase aliases, parser actTitle/exactRefs hints, Armenian prefix-stem (2/3 rule) + Levenshtein-1 fuzzy; (2) exact articles — «հոդված 179»/«179-րդ հոդված» both orders, guarded «ՔԴՕ 179» bare-number convention (case-number/part/year/hyphen guards), bare numbers WITHOUT act hint require per-article lexical support (fixes the English «Article 5» cross-act flood found live in r7); (3) lexical + concept scoring via inverted indexes with exact-reference band separation (0.98 alias+article / 0.88 supported bare / ≤0.85 lexical — no fake confidence).
  - adapter.ts — LegalSourceAdapter (id local-laws, authority localCuratedLaws 70, sourceType local_laws), fullText + fullTextVerified at search time (zero network), ARLIS canonicalUrl + snapshot provenance in meta, fetchDocument from corpus by externalId/meta/URL, honest EMPTY degradation.
- Rebuilt `src/app/api/test/` QA harness routes (never committed due to the `test` pattern), reconstructed from recorded probe outputs:
  - gold-set/route.ts — 9 federated queries (quick/deep), anyOfTerms + expectedArticle + expectEmpty criteria, sourceAvailability counting PARTIAL as available.
  - resolution-gold-set/route.ts — 8 deep scenarios with per-scenario exactIdentifier / expectTerms / minFullTexts / minMetadata, wrong-document guard, the 6 Phase-3 metrics.
- .gitignore fixed: `local-*` → `/local-*`, `test`/`prompt` → `/test`//prompt, with explanatory comments + `!src/lib/legal-search/local-laws/` belt-and-suspenders.
- Tests: tests/unit/local-laws.test.ts — 19 tests (loader counts/provenance/fail-closed, ՔԴՕ 179 + ՔՕ 179 historic regression, ՍԱ 42 + inflected սահմանադրության, civil-code genitive, bare-number support rules, Article-5 flood regression, adapter contract, fetchDocument by all three keys, unknown-doc EMPTY).

Verification (all live against the running dev server):
- tsc clean; eslint clean; bun test 134/134 PASS; next build PASS (routes list includes both /api/test/* harnesses).
- LIVE retrieval gold set: 9/9 PASS, recall@N 100% (g1 ՔԴՕ 179 → 6 evidence, article 179 targeted; g9 no_result → 0 evidence).
- LIVE resolution gold set: 8/8 PASS — metadataHitRate 100%, fullTextResolutionRate 100% (r2 ԵԴ/36723/02/21 got 1 full text this run; captcha-gated metadata otherwise), primaryFullTextRate 100%, fallbackResolutionRate 0%, wrongDocumentRate 0.0%, exactIdentifierAccuracy 100%.
- LIVE quick ՔԴՕ 179 via /api/search: local-laws SUCCESS (12 results, ~5ms), engine-level behavior identical to the recorded gold (6 evidence, 5 full texts, PRIMARY_VERIFIED — dedup merges article-level local hits into the higher-priority ARLIS act result by design).
- /api/answer under the still-429-exhausted SDK quota degrades honestly («AI վերլուծությունն այս պահին հասանելի չէ…», evidence preserved) — documented fail-closed behavior; live deep-answer E2E remains pending the quota window.

Stage Summary:
- LOST_MODULES_RESTORED: local-laws source (3 files) + both QA harness routes, from recorded artifacts.
- GITIGNORE_HARDENED: bare `local-*`/`test`/`prompt` patterns root-anchored; nested source can never be silently ignored again.
- ALL_GATES_GREEN: unit 134/134, build PASS, retrieval gold 9/9, resolution gold 8/8 (wrongDocumentRate 0, exactIdentifierAccuracy 100%).
- KNOWN LIMITATION (unchanged, environmental): z-ai SDK chat quota 429-exhausted; research/answer layers degrade honestly and auto-recover.
