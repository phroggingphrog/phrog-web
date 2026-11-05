# Endpoint map: TinyFish / Firecrawl → phrog-web

## "MCP web" is a label, not a product

Two different MCP servers are both named `web` in client configs on this box. The name means nothing;
the URL behind it is everything.

| config | entry | URL | actually is |
|---|---|---|---|
| OpenCode | `mcp.servers.web` | `http://127.0.0.1:8890/mcp` | **phrog-web** |
| Claude Code | `mcpServers.web` | `http://127.0.0.1:18936/mcp/web` | **personal-assistant-mcp** (mcp-use CLI, token-gated) |
| Claude Code / Codex | `phrog-web` | `http://127.0.0.1:8890/mcp` | **phrog-web** (added directly) |

`:8890` → `{"status":"ok","service":"phrog-web"}`. `:18936` → `401 local_owner_token_required`.
Same label, unrelated services — which is exactly why the direct `phrog-web` entry was added.

## The five TinyFish APIs and their phrog-web equivalents

| TinyFish | phrog-web | request | notes |
|---|---|---|---|
| Search | `GET /api/search` | `?q=&limit=&mode=quick\|deep` | free tier first |
| Fetch | `POST /api/fetch` | `{"url","mode":"plain\|browser\|auto","max_chars"}` | escalates when thin |
| — | `POST /api/scrape` | `{"url","formats":["markdown","html","links","screenshot","json"]}` | richer than Fetch |
| TinyAgent | `POST /api/agent` | `{"url","goal","schema?","mode?","max_steps?","timeout_s?"}` | ladder fetch→browse→deep→tinyfish |
| — | `POST /api/agent/stream` | same body | SSE: STARTED / PROGRESS / COMPLETE / ERROR |
| Browser | `POST /api/browser` | `{"url","profile":"lite\|stealth"}` | **url required**, bills $0.002/min |
| — | `DELETE /api/browser/:sessionId` | — | 204, stops the meter |
| Research | `POST /api/research` | `{"question\|topic","mode":"quick\|deep","domain":"web\|academic\|discussions\|all","instructions"}` | deep returns a job id |
| — | `GET /api/research/:jobId` | — | poll |

## Agent ladder: why it is usually free

`mode` defaults to `auto`. The goal text decides the start rung:

```
fetch  →  browse        (interactive goals: click/type/login/submit)
       →  deep          (multi-page: all pages / crawl / compare sites)
       →  tinyfish      (last resort — this is the rung that bills $0.016/step)
```

`max_steps` is clamped to 4 and `timeout_s` defaults to 180, so a runaway goal cannot burn credit
silently. The response names the rung it used: `escalated_to`.

Verified:

```bash
curl -s -X POST localhost:8890/api/agent -H 'Content-Type: application/json' \
  -d '{"url":"https://podman.io/","goal":"What is the latest stable Podman version listed on this page?"}'
# {"status":"COMPLETED","escalated_to":"fetch","result":"6.1.4","steps":[{"action":"fetch+extract","ms":2866}]}
```

An interactive goal on the same page escalates to `browse` (local Jev, still free) because the goal
text contains a click/type verb.

## Response envelope per endpoint

| endpoint | success | failure |
|---|---|---|
| `/api/search` | `{results:[{title,url,snippet}], provider_used, tinyfishPlan, degraded}` | 400/502 `{error}` |
| `/api/fetch` | `{url,title,markdown,length,provider_used,outcome}` | `{error}` |
| `/api/agent` | `{status:"COMPLETED"\|"FAILED", result, steps, escalated_to, sources}` | 400 `{error}` |
| `/api/browser` | `{session_id, cdp_url, base_url, plan:"paid"}` | 400 `{error}` |
| `/api/research` quick | `{answer, sources, …}` | 502 `{error}` |
| `/api/research` deep | `{job_id, status}` | 502 `{error}` |
