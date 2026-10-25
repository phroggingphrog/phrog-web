---
name: use-phrog-web
description: Use the self-hosted phrog-web gateway for any live-web need: search, reading a URL, research, comparing options, current information, docs, papers, books/films/music, Reddit/HN/YouTube, site crawling, structured extraction, and interactive pages. Use whenever the user asks to search, look up, find, research, compare, fetch, summarize a URL, get a transcript, or pull data from the web, instead of the built-in WebSearch/WebFetch.
---

# Using phrog-web

phrog-web is the self-hosted web toolbox (gateway `127.0.0.1:8890`). Prefer it over built-in WebSearch/WebFetch whenever its tools are available. Cite the URLs you used.

MCP server name: `web` (Claude Code, Codex, Pi, OMP), `web-agent` (DSH), `webagent` (Hermes). Tools appear as `mcp__web__<tool>` or similar. If no MCP tools are visible, use the REST API (below).

## When to trigger

Any request that needs live web information or page content, even if the user never says "web": search, look up, find, latest/current, news, docs, pricing, compare options, summarize or read a URL, papers, books/films/music, Reddit/HN/YouTube, crawl a site, extract fields from pages, or work with a page that needs clicks or forms.

## The ladder (lightest first)

Escalate only when the lighter tool fails or returns incomplete content.

| Rung | Tools | Use for |
|------|-------|---------|
| 1. Search | `web_search` / `quick_search` | Find URLs, current facts. `time_range`, `categories` supported. `live_search` for last day/week/month. |
| | `academic_search`, `research_search` | Papers (Consensus; OpenAlex, arXiv, Semantic Scholar, Crossref). |
| | `social_search` | Reddit, Hacker News, Lemmy, Mastodon, YouTube. |
| | `media_search` | Book, film, music metadata and ratings. |
| | `github_search`, `deepwiki_ask` | Repos; grounded Q&A on a GitHub repo. |
| | `research` (mode web) | Short cited answer in seconds (Vane). |
| 2. Fetch | `fetch` | One URL to clean Markdown (plain, then headless JS, then TinyFish). |
| | `web_crawl` | Up to 10 URLs; `actions` (click/type/scroll/wait) and `stealth` force the browser. |
| | `web_map` | List a site's URLs, no content. |
| | `web_crawl_start`, `web_batch_start` + `web_crawl_status` | Background crawl of a whole site or up to 500 URLs. |
| | `youtube_transcript` | Captions for a video. |
| 3. Extract | `extract` | URLs + JSON Schema in, validated JSON out (null for unknowns). |
| 4. Agent / browse | `web_agent_run` (NEW) | url + goal in, JSON out, with escalation built in. REST: `POST /api/agent`. |
| | `browse` | Goal-driven multi-step browsing (Jev runner). |
| 5. Deep research | `deep_research_start`, `deep_research_status`, `deep_research_resume` | Slow staged Feynman runs (deepresearch, lit, compare, review, audit). Returns a job_id; poll. |

`web_agent_run` is new. If the tool is not in your tool list, fall back to `browse` or `web_crawl` with `actions`.

## Common patterns

- **Research:** `web_search` then `fetch` the top 2-3 results, answer from the pages, cite URLs. Use `research` for a quick cited answer.
- **Site docs:** `web_map` to find pages, then `web_crawl` the relevant ones (or `web_crawl_start` with `include`/`exclude` regexes for many).
- **Structured data:** `extract` with a JSON Schema over known URLs.
- **Dynamic or interactive page:** `fetch` first; if content is missing, `web_agent_run` with a clear goal.
- **Papers:** `academic_search` or `research_search` (preset academic), then `fetch` the PDF or abstract page.
- **Long investigation:** `deep_research_start`, poll `deep_research_status` with `include_result=true` when completed.
- **Video:** `youtube_transcript`, then summarize.

## Saving

`save_to_wiki` (urls, text or question; optional title, target, job_id) reads the sources, writes one proposed page into ~/brain/wiki/inbox/ and returns its path. Use it for findings worth keeping, and say what you saved. `wiki_save` is different: it writes to the local vector wiki only. `wiki_search` searches that local wiki; check it before re-researching. `research_vault` holds reusable Feynman evidence.

## REST equivalents

`/api/search`, `/api/fetch`, `/search` (SearXNG-compatible), `/api/crawl`, `/api/map`, `/api/extract`, `/api/browse`, `/api/media`, `/api/books`, `/api/social`, `/api/transcript`, `/api/vault`, `/api/agent`. Health: `curl -s http://127.0.0.1:8890/health`.

## Gotchas

- Reddit goes through public Redlib and can be flaky; retry once, then try `fetch` on the thread URL.
- Anna's Archive and Z-Library (`book_availability`, `book_download`) need credentials from `pnpm setup`; report that if they fail.
- Bluesky search is unavailable.
- Results are public web only. Pages behind bot checks come back as skipped/blocked, not content; try `stealth` or `web_agent_run`.
- Do not send private or personal data into search queries.

`run_log` (MCP) and `GET /api/runs?limit=50&tool=` show recent calls with duration, ok and provider info.
