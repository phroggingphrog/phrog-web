# Phrog Web — Project Handover

> **Repository**: [https://github.com/phroggingphrog/phrog-web](https://github.com/phroggingphrog/phrog-web)  
> **Status**: Live, tested, and fully functional on `main`  
> **Backlog**: TASK-308 (Done)

---

## 1. What This Repository Is

**Phrog Web** is an agent-agnostic, self-contained web retrieval, deep research, and personal knowledge hub. It provides a unified gateway with two interfaces:
1. **HTTP REST API** on `http://127.0.0.1:8890` (TinyFish-compatible contracts).
2. **Streamable HTTP MCP** at `http://127.0.0.1:<port>/mcp` (stateless, one server per request; Claude Code `--transport http`). Tools come from `createMcpServer()` in `src/adapters/mcp/server.ts`.
2b. **Stdio MCP Server** via `node dist/adapters/mcp/server.js` (for Claude Code, Codex, DSH, Cursor).
3. **Hermes Tool Definitions** via `src/adapters/schemas/hermes-tools.json` (OpenAI function-calling format).

---

## 2. Architecture & Pipeline Topology

```
                               [PHROG WEB GATEWAY]
                        (Fastify TypeScript / Port 8890)
                                      │
        ┌───────────────────┬─────────┴─────────┬───────────────────┐
        ▼                   ▼                   ▼                   ▼
  [SEARCH TIER]       [FETCH TIER]       [RESEARCH TIER]     [KNOWLEDGE TIER]
  • Consensus API     • Trafilatura      • Vane (3-5s quick) • Plain Markdown
    (220M+ papers)      (Fast plain)       - Web / Academic    (Agnostic vault)
  • SearXNG Local     • Crawl4AI Headless• Feynman           • Node 22 SQLite
    (arXiv, GitHub)     (Local JS/DOM)     (Autonomous Pi)     (Built-in vector)
  • TinyFish Search   • TinyFish Fetch     - 8 workflows     • Cosine Similarity
    (Cloud fallback)    (Anti-bot cloud)     (lit, audit...)   Semantic Search
```

---

## 3. Verified Endpoints & Examples

### A. General Web Search (`GET /api/search`)
Cascades through SearXNG `general` &rarr; TinyFish Search fallback.
```bash
curl "http://127.0.0.1:8890/api/search?q=fastify+node&limit=3"
```

### B. Academic Literature Search (`GET /api/search?mode=academic`)
Queries **Consensus Academic API** (`api.consensus.app/v1/search`) across 220M+ peer-reviewed papers with study types, sample sizes, and takeaways. Falls back to SearXNG `science` (arXiv, PubMed, OpenAlex, Semantic Scholar).
```bash
curl "http://127.0.0.1:8890/api/search?q=creatine+cognitive+performance&mode=academic&limit=2"
```

### C. GitHub Repository Search (`GET /api/github/search`)
Searches GitHub repositories via local SearXNG GitHub engine with fallback to GitHub REST API.
```bash
curl "http://127.0.0.1:8890/api/github/search?q=fastify&limit=2"
```

### C2. Media, Books, Social, Transcripts
```bash
curl "http://127.0.0.1:8890/api/media?q=dune&type=book&limit=5"        # type=book|film|music
curl "http://127.0.0.1:8890/api/books?q=dune&limit=5"                  # search-only availability
curl "http://127.0.0.1:8890/api/social?q=fastify&sources=reddit,hackernews&limit=5&time_range=month"
curl -X POST http://127.0.0.1:8890/api/transcript -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","lang":"en","max_chars":2000}'
```
MCP tools: `media_search`, `book_availability`, `social_search`, `youtube_transcript`.
Known blockers: Anna's Archive is behind DDoS-Guard; Z-Library needs login; Bluesky search returns 403; keyed ratings need `TMDB_API_KEY`, `OMDB_API_KEY`, `HARDCOVER_API_KEY`, `DISCOGS_TOKEN`.

### D. DeepWiki Codebase Q&A (`POST /api/deepwiki/ask`)
Queries AI-generated, codebase-grounded documentation with inline citations via DeepWiki Streamable MCP (`mcp.deepwiki.com/mcp`). Auth-free for all public repos.
```bash
curl -X POST http://127.0.0.1:8890/api/deepwiki/ask \
  -H "Content-Type: application/json" \
  -d '{"repo": "companion-inc/feynman", "question": "What are the core research workflows?"}'
```

### E. Page Fetching / Markdown Reader (`POST /api/fetch`)
Cascades through: Plain Trafilatura (fast, ~150ms) &rarr; Crawl4AI Headless Chromium (`127.0.0.1:11235`) &rarr; TinyFish Cloud Fetch.
```bash
curl -X POST http://127.0.0.1:8890/api/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### F. Quick Research (`POST /api/research` with `mode: "quick"`)
Fast 3–5 second answer synthesis via Vane engine (`http://127.0.0.1:3000`). Supports `domain: "web"` or `domain: "academic"` (which queries arXiv/PubMed).
```bash
# Quick general synthesis:
curl -X POST http://127.0.0.1:8890/api/research \
  -H "Content-Type: application/json" \
  -d '{"question": "What is SearXNG in one sentence?", "mode": "quick"}'

# Quick academic synthesis:
curl -X POST http://127.0.0.1:8890/api/research \
  -H "Content-Type: application/json" \
  -d '{"question": "What does recent research say about fasting on autophagy?", "mode": "quick", "domain": "academic"}'
```

### G. Autonomous Deep Research (`POST /api/research` with `mode: "deep"`)
Dispatches a background headless Feynman child process (`engines/feynman/bin/feynman.js`). Supports workflows: `lit`, `deepresearch`, `compare`, `audit`, `review`, `draft`, `recipe`, `summarize`. Wakes up the caller via `callback_url` on completion.
```bash
curl -X POST http://127.0.0.1:8890/api/research \
  -H "Content-Type: application/json" \
  -d '{"question": "GLP-1 receptor agonists neuroprotection", "mode": "deep", "workflow": "lit", "callback_url": "http://127.0.0.1:8000/webhook"}'
```

### H. Agnostic LLM Wiki (Karpathy Knowledge Vault)
Saves structured notes with YAML frontmatter to `./wiki/inbox/<slug>.md` and generates vector embeddings stored in `wiki/.index.db` via Node 22's `node:sqlite`.
```bash
# 1. Save note:
curl -X POST http://127.0.0.1:8890/api/wiki/save \
  -H "Content-Type: application/json" \
  -d '{"title": "Attention Is All You Need", "content": "Transformer architecture based solely on attention...", "tags": ["transformers", "nlp"], "source": "https://arxiv.org/abs/1706.03762"}'

# 2. Semantic Vector Search:
curl "http://127.0.0.1:8890/api/wiki/search?q=neural+attention+networks&limit=3"
```

---

## 4. Configuration & Environment

Configuration is centralized in `config.json`.
Environment secrets are auto-loaded from:
1. `~/.config/phrog-web.env`
2. `~/.config/self-hosted-web-mcp.env`
3. `.env` (local workspace)

### Key Environment Variables
| Variable | Description |
| :--- | :--- |
| `CONSENSUS_API_KEY` | Consensus Academic API key (quota: 500 requests/month; guarded). |
| `TINYFISH_API_KEY` | TinyFish Search & Fetch API key (free cloud fallback). |
| `CRAWL4AI_API_TOKEN` | Bearer token for local Crawl4AI container (`127.0.0.1:11235`). |
| `WIKI_DIR` | Optional path override for LLM Wiki root (defaults to `./wiki`). |
| `OPENAI_API_KEY` / `OMNIROUTE_API_KEY` | Optional embedding API key (defaults to zero-config offline TF-IDF if unset). |

---

## 5. Development & Operations

### Build & Run
```bash
pnpm install
pnpm build
pnpm start       # Launches Fastify server on 127.0.0.1:8890
pnpm dev         # Live reload via tsx watch
```

### Run MCP Server
```bash
node dist/adapters/mcp/server.js
```

---

## 6. Embedded Engines Overview
All engines are vendored under `engines/` with zero VPS-specific symlinks:
- `engines/feynman/`: Cloned from `companion-inc/feynman` (Pi-based multi-workflow research agent).
- `engines/vane/`: Cloned from `ItzCrazyKns/Vane` (Perplexica AI answer engine).
- `engines/web_acquisition/`: Extracted Crawl4AI, Trafilatura, and site-crawling client libraries.

---

## 7. Next Work (Phase 2)
1. **Agent Browser Module (`src/browser/`)**: Implement local cookie and `storageState.json` profile manager so external agents (Hermes / Playwright) can launch pre-authenticated browser sessions without Google accounts.
2. **Systemd Service**: When desired, create `~/.config/systemd/user/phrog-web.service` to keep the gateway running persistently.

## Books: search and download (Z-Library, Anna's Archive)
- Engine: `engines/zlibrary-mcp` (vendored rookslog/zlibrary-mcp, stdio MCP; tools `search`, `get_book`, `download`, `get_limits`, `get_history`). Built in place: `npm install && npm run build && UV_PROJECT_ENVIRONMENT=$PWD/.venv uv sync --no-dev` inside it (`node_modules`, `.venv`, `dist` are gitignored, so rebuild after a fresh clone).
- Bridge: `src/providers/books.ts` keeps one long-lived MCP client. Creds pass only from `loadConfig()` env (`ZLIBRARY_EMAIL`, `ZLIBRARY_PASSWORD`, optional `ZLIBRARY_EAPI_DOMAIN`, `ANNAS_SECRET_KEY`, `ANNAS_BASE_URL`).
- Search: `GET /api/books?q=...&limit=` or MCP `book_availability` (rows carry a `ref`). Refs are in-memory in the engine process; they are lost on gateway restart, so search again before downloading.
- Download: `POST /api/books/download` with `{"ref": "<ref from search>"}` or `{"md5"|"id": "...", "source": "annas|zlibrary"}` (md5/id is resolved by a search first). MCP: `book_download`. Returns `{path, bytes}`. Files go to `PHROG_WEB_DOWNLOADS` or `<repo>/downloads` (gitignored).
- Setup: `pnpm setup` (or `node dist/setup.js`) asks for optional keys (hidden input for secrets), merges them into `~/.config/phrog-web.env` (mode 600, existing keys kept, one backup per run in `~/backups/phrog-web/`, newest 3 kept), then prints a check table. `node dist/setup.js --check` only checks. The gateway logs "Run `pnpm setup`..." on start when no setup marker or key exists.
- Blockers: no credentials entered yet (owner adds them). From this VPS Anna's website search fails (403 DDoS-Guard), so Anna search may stay down even with a key; Anna downloads use the member key API and may work. LibGen needs no key but is not in the default sources (pass `sources: ["libgen"]`). Z-Library and Anna success paths are untested without credentials. Failed searches return in about 11s (Anna's internal retries).


## Web-agent parity tools
REST: POST /api/crawl, /api/map, /api/batch, /api/browse, /api/extract, /api/vault; GET /api/batch/:id.
MCP (same names/args as the Python web MCP): web_crawl, web_map, web_batch_start, web_crawl_status, browse, extract, research_vault, plus save_to_wiki (alias of wiki_save).
Job status strings match Python (`running`, `completed`, `failed`).

Remaining gaps:
- `actions` and `stealth` in web_crawl only force browser mode; they are not applied.
- No Trafilatura, PDF or Office conversion.
- `web_crawl_start` (site crawl) is not ported.
- `browse` needs the external Jev runner (JEV_RUNNER / JEV_DIR, see `jevPaths()` in src/config.ts) and a TYPESAFE/OPENROUTER key; it errors clearly if missing.
- `research_vault` needs the Feynman MCP at WEB_AGENT_FEYNMAN_URL (default 127.0.0.1:8910).


## Crawl capabilities added (feat/http-mcp-crawl)
- `web_crawl` `actions` (click/type/press/scroll/wait/wait_for) and `stealth` are sent to Crawl4AI (`/crawl` run config for scroll/wait, `/execute_js` for click/type/press, `enable_stealth` browser config). A click on a link that navigates hangs Crawl4AI `/execute_js` (Python engine has the same limit; Crawl4AI rejects `js_code`/`c4a_script` from API requests). Fix: a click on `<a href>` only marks the target (`data-pw-nav`), then the target is crawled with the remaining actions (`fetchCrawl4ai` in src/providers/fetch.ts). Non-link clicks run normally.
- PDF (`pdftotext`) and Office (MarkItDown in the Python venv, `PHROG_WEB_PYTHON`, default `~/workspace/self-hosted-web-mcp/.venv/bin/python`) are converted in the plain fetcher (`src/providers/document.ts`).
- `web_crawl_start` (also `POST /api/crawl/start`): same args as the Python tool; jobs share the batch job map and are read with `web_crawl_status`. In-process only.
- Plain fetch now uses Trafilatura (`extractMain` in document.ts, per-call subprocess in the same Python venv, 10s timeout, falls back to the regex cleaner). Office conversion verified on real .docx/.xlsx.
- `web_map` (links fallback) and `web_crawl_start` add Crawl4AI rendered `links` when plain HTML has fewer than 4 (map) / 3 (crawl) same-site links (`renderedLinks`); skipped in crawl mode `plain`.
- Not ported: daemon-persisted jobs, Python-style crawl job disk state.

## Deep Agents web agent (self-contained)
- Code: `engines/web_acquisition` (package `web_acquisition`), deps pinned in `engines/pyproject.toml`, venv `engines/.venv` (gitignored).
- Rebuild venv: `cd engines && uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r pyproject.toml`
- Launch: `bin/web-agent-a2a` (A2A + OpenAI-compatible API). Host/port via `WEB_AGENT_A2A_HOST` / `WEB_AGENT_A2A_PORT` (default 127.0.0.1:42619); env file loaded by systemd (`~/.config/self-hosted-web-mcp.env`); token file `~/.config/web-agent-deep/a2a-token`.
- Overrides: `PHROG_WEB_PYTHON` (python for launcher, Trafilatura, MarkItDown), `JEV_DIR` (default `~/apps/jev-ultrafast`), `JEV_RUNNER` (default `engines/jev_run.py`).

## SearXNG-compatible /search (feat/searxng-compat)
- `GET/POST /search` (src/searxng-compat.ts) mimics SearXNG JSON: params q, format, categories, engines, language, pageno, time_range, safesearch. Only `format=json` (others return 403, as the live instance does for csv).
- Backed by `executeSearch`. SearXNG-served results (and answers/infoboxes/suggestions/unresponsive_engines) pass through unchanged via `SearchResult.raw` / `SearchResponse.envelope`. TinyFish/Consensus results get the same keys filled (engine = provider, category general).
- Academic categories (science/academic/papers) go through the existing Consensus -> SearXNG pipeline, so those results carry engine `consensus`.
- Point a SearXNG client (e.g. DeepTutor) at `http://127.0.0.1:8890` as base URL.

## CLI (feat/tinyfish-parity)
- `src/cli.ts` -> `dist/cli.js`, bin `phrog-web`. Node built-ins only; calls the REST API (default `http://127.0.0.1:8890`, override `PHROG_WEB_URL` or `--url`).
- Commands: `search`, `fetch`, `crawl`, `map`, `extract --schema`, `social`, `media --type`, `books`, `transcript`, `agent <url> "<goal>"` (needs `/api/agent`; 404 gives a clear message).
- Full results go to `./phrog-web-out/<cmd>-<timestamp>.json|md` (or `--out`); stdout gets only a short summary and the file path, so model context stays small. `--stdout` prints everything, `--json` prints raw JSON. Non-zero exit on HTTP/network errors.
- `crawl` POSTs `/api/crawl/start`, polls `/api/batch/:id`, then pages results 50 at a time.

---

## Agent endpoint (`POST /api/agent`, `POST /api/agent/stream`, MCP `web_agent_run`)

Research notes (phrog-web search/fetch, 2026-10-26):
- TinyFish Agent API: `POST /v1/automation/run` (blocking), `/run-async` (run_id, poll `GET /v1/runs/{id}`), `/run-sse` (streamed events, no Last-Event-ID reconnect; poll the run instead). Body is url + goal, optional JSON schema. https://docs.tinyfish.ai/agent-api/reference
- TinyFish run-level failures: TASK_FAILED, SITE_BLOCKED, MAX_STEPS_EXCEEDED, TIMEOUT. `agent_config.max_steps` and `mode: strict` are beta-only. Same reference page. Event names (STARTED, PROGRESS, COMPLETE) are from the TinyFish docs and SDK; the per-event list was not rendered by our fetch, so STREAMING_URL/HEARTBEAT are unverified.
- TinyFish structured output uses a restricted JSON Schema keyword allowlist with size/depth limits: https://docs.tinyfish.ai/key-concepts/structured-output
- browser-use: Python agent loop (observe page state, LLM picks action, run, repeat) with custom tools, structured output (pydantic model) and a max_steps cap: https://github.com/browser-use/browser-use
- Stagehand: three primitives, `act` (one action), `observe` (list candidate actions), `extract` (schema-typed data); deterministic code mixed with LLM steps: https://github.com/browserbase/stagehand
- Skyvern: task = prompt/`navigation_goal` + optional `data_extraction_schema`, returns schema-shaped JSON: https://github.com/skyvern-ai/skyvern
- Common pattern: cheap read first, interactive loop only when needed, schema-validated output, hard step/time caps, failure statuses instead of guessing.

Implementation (`src/providers/agent.ts`, no new services): ladder `fetch` (crawl + extract.ts with an `answerable` flag) -> `browse` (Jev runner, output shaped to JSON by the LLM) -> `deep` (A2A agent 127.0.0.1:42619, token from `~/.config/web-agent-deep/a2a-token`). Auto mode starts at browse for interactive goals (click/type/wait...) and at deep for multi-page goals; otherwise escalates only when the fetch level says the page text lacks the answer. `max_steps` caps rungs (1-3), `timeout_s` (default 180) is the overall deadline.
Request `{url, goal, schema?, mode?: auto|fetch|browse|deep, max_steps?, timeout_s?}`; response `{status: COMPLETED|FAILED, result, steps:[{action,detail,ms}], escalated_to, sources, error?}`. Stream events: STARTED, PROGRESS, COMPLETE or ERROR (SSE `data:` lines).
Verified on PORT=8899: quotes.toscrape.com stayed at fetch (5s); the-internet dynamic_loading/1 escalated to browse and returned "Hello World!" (15s); books.toscrape.com cheapest book with schema returned "Starving Hearts (Triangular Trade ...", £13.99 at fetch (7s). The deep rung is wired but not exercised.

---

## Run logs and save_to_wiki (brain)

- `src/runlog.ts`: JSON-lines log (default `~/.local/state/phrog-web/runs.jsonl`, `PHROG_WEB_RUNLOG`; rotates at 10MB, keeps 3). MCP tools are logged by wrapping `server.tool` handlers in `createMcpServer`; REST via Fastify onSend/onResponse hooks for `/api/*`. Keys matching key/token/secret/password/auth/cookie are redacted; strings truncated at 200 chars. Reads: `GET /api/runs?limit=&tool=`, MCP `run_log`. Failed `POST /mcp` (status >= 400) is logged with rpc method and accept/content-type headers (a client without `Accept: application/json, text/event-stream` gets 406).
- `save_to_wiki` now matches the old Python tool (kind, urls, text, question, title, target, job_id) by running `engines/save_to_wiki_cli.py` (wraps `web_acquisition.wiki`) in `engines/.venv`. Output: `$WEB_AGENT_WIKI_INBOX` or `~/brain/wiki/inbox`. `wiki_save`/`wiki_search` stay the local vector wiki.
