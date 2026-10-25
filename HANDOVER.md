# Phrog Web — Project Handover

> **Repository**: [https://github.com/phroggingphrog/phrog-web](https://github.com/phroggingphrog/phrog-web)  
> **Status**: Live, tested, and fully functional on `main`  
> **Backlog**: TASK-308 (Done)

---

## 1. What This Repository Is

**Phrog Web** is an agent-agnostic, self-contained web retrieval, deep research, and personal knowledge hub. It provides a unified gateway with two interfaces:
1. **HTTP REST API** on `http://127.0.0.1:8890` (TinyFish-compatible contracts).
2. **Stdio MCP Server** via `node dist/adapters/mcp/server.js` (for Claude Code, Codex, DSH, Cursor).
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
