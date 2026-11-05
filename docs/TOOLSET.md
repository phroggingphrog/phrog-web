# phrog-web toolset

Every capability, grouped. Three doors into the same service:

| door | count | how a client reaches it |
|---|---|---|
| **MCP** (`http://127.0.0.1:8890/mcp`) | 44 tools | any MCP client; needs the bearer token |
| **REST** (`http://127.0.0.1:8890/api/…`) | 52 routes | plain HTTP; no token on loopback |
| **Hermes-native** | 2 tools | `web_search`, `web_extract` via the `web-phrog-web` backend plugin |

`GET /api/cookbook` returns the capability index as JSON.

---

## 1. Search — 6 tools · 1 route

| tool | params |
|---|---|
| `quick_search` | query, limit |
| `live_search` | query, time_range, limit |
| `deep_search` | query, domain, limit |
| `academic_search` | query, limit |
| `web_search` (compat shim) | query, limit, time_range, language, categories, near |
| `research_search` | query, preset, sources, limit, stackexchange_site |

`GET /api/search` — q, limit, mode=quick|deep, categories.

Pipeline: TinyFish (Hobby/free first) → Exa keyless → local SearXNG fallback tier; anysearch + firecrawl join in deep mode. Reranker applies to deep only.

## 2. Fetch, scrape, crawl — 7 tools · 7 routes

| tool | params |
|---|---|
| `fetch` | url, mode, max_chars |
| `extract` | urls, schema, instructions |
| `web_crawl` | urls, max_chars, mode, actions, stealth |
| `web_map` | url, limit, search, include_subdomains |
| `web_crawl_start` | url, max_pages, max_depth, include, exclude, include_subdomains, respect_robots, max_chars, mode, stealth |
| `web_batch_start` | urls, max_chars, mode |
| `web_crawl_status` | job_id, include_results, offset, limit |

Routes: `POST /api/fetch` · `POST /api/scrape` (formats: markdown, html, rawHtml, links, screenshot, json) · `POST /api/parse` (PDF/DOCX/XLSX/PPTX → Markdown) · `POST /api/crawl` · `POST /api/crawl/start` · `POST /api/map` · `POST /api/batch` + `GET /api/batch/:id`.

## 3. Research — 7 tools · 3 routes

`research` (question, domain, workflow, callback_url) · `literature_review` (topic, callback_url) · `research_status` (jobId) · `deep_research_start` (topic, workflow, profile, tier, budget_usd, register, inference_depth, domain_notes) · `deep_research_status` (job_id, include_result) · `deep_research_resume` (run_id) · `research_vault` (action, query, note_id, title, body, source, tags, limit, claim, quoted_support, confidence, evidence_type, stance_target, stance, run_id, ranked)

Routes: `POST /api/research` · `GET /api/research/:jobId` · `POST /api/vault`.

## 4. Login state — 0 tools · 4 routes

`GET /api/profiles` · `POST /api/profiles/:site/save` · `DELETE /api/profiles/:site` · `POST /api/fetch-profile`.

Per-site cookie jars under `~/.config/phrog-web/profiles/`, exported from jev-chrome's persistent profile. `POST /api/scrape` and the native `web_extract` use a jar automatically when one exists.

## 5. Browser & agent — 2 tools · 4 routes

| tool | params |
|---|---|
| `browse` | url, goal, max_seconds |
| `web_agent_run` | url, goal, schema, mode, max_steps, timeout_s |

Routes: `POST /api/browse` (local Jev runner) · `POST /api/agent`, `POST /api/agent/stream` (TinyFish agent, Builder key, $0.016/step) · `POST /api/browser` + `DELETE /api/browser/:sessionId` (TinyFish remote browser, $0.002/min — url is mandatory so a session can't be minted by accident).

## 6. Dev & code docs — 6 tools · 5 routes

`github_search` (query, limit) · `github_download` (repo, ref, extract) · `github_patch` (repo, number, kind, max_chars) · `deepwiki_ask` (repo, question) · `deepwiki_structure` (repo) · `deepwiki_read` (repo, max_chars)

Routes: `GET /api/github/search` · `POST /api/github/download` · `GET /api/github/patch` · `POST /api/deepwiki/ask` · `GET /api/deepwiki/structure` · `GET /api/deepwiki/read`.

## 7. Knowledge base — 2 tools · 2 routes

`wiki_save` (title, content, tags, source) · `wiki_search` (query, limit). Routes: `POST /api/wiki/save` · `GET /api/wiki/search`.

## 8. Shopping & local — 6 tools · 5 routes

`secondhand_search` (query, marketplaces, location, radiusKm, minPrice, maxPrice, condition, sort, limit) · `secondhand_listing` (listingId, marketplace) · `marketplace_search` (query, limit) · `marketplace_product` (product, reviews) · `deals_search` (query, limit, includeExpired, near) · `place_search` (query, limit, near)

Routes: `GET /api/secondhand` · `GET /api/marketplace` · `GET /api/deals` · `GET /api/places`.

## 9. Media & social — 5 tools · 4 routes

`media_search` (query, type, limit) · `visual_search` (image, hint, shop, limit, near) · `social_search` (query, sources, limit, timeRange) · `youtube_transcript` (url, lang, maxChars, stt) · `feed` (screenshots, provider, source, limit, cursor)

Routes: `GET /api/media` · `POST /api/visual` · `GET /api/social` · `POST /api/transcript`.

## 10. Books — 2 tools · 2 routes

`book_availability` (query, limit, sources) · `book_download` (ref, source). Routes: `GET /api/books` · `POST /api/books/download`.

## 11. Ops & introspection — 1 tool · 9 routes

`run_log` (limit, tool).

Routes: `GET /health` · `GET /api/cookbook` · `GET /api/keys`, `GET /api/keys/status`, `POST /api/keys`, `DELETE /api/keys/:key` · `GET /api/runs` · `GET /api/monitor`, `POST /api/monitor`, `POST /api/monitor/:id/check` · `GET /api/profiles` · `GET /shots/:file` · `GET /i/:token`.

## 12. Hermes-native — 2 tools

`web_search(query, limit)` → `GET /api/search` · `web_extract(urls)` → `POST /api/scrape` with `profile: true`.

Enabled with `hermes plugins enable web-phrog-web` plus `web.search_backend` / `web.extract_backend` = `phrog-web`. No token, no MCP.
