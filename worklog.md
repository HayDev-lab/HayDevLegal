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

