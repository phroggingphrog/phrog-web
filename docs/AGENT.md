# One agent door

`POST /api/agent` is the only agent entry point. Two shapes, one implementation:

| you have | send | what runs |
|---|---|---|
| a page and a task | `{url, goal}` | ladder: fetch → browse → deep → tinyfish |
| a question, no page | `{query}` | deep search + synthesis, `escalated_to: "deep"` |

```bash
# page-bound
curl -s -X POST localhost:8890/api/agent -H 'Content-Type: application/json' \
  -d '{"url":"https://podman.io/","goal":"latest stable version?"}'
# {"status":"COMPLETED","escalated_to":"fetch","result":"6.1.4"}

# query-only — the deep-search shape, answered instead of listed
curl -s -X POST localhost:8890/api/agent -H 'Content-Type: application/json' \
  -d '{"query":"what changed in podman 6 rootless networking","schema":{"type":"object","properties":{"answer":{"type":"string"}}}}'
# {"status":"COMPLETED","escalated_to":"deep","sources":[8 urls],"result":{"answer":"…Pasta replaced slirp4netns…"}}
```

## What got pruned

`browse` was never its own capability — it is agent `mode: "browse"`. It is now an alias, not a
second code path:

| surface | before | now |
|---|---|---|
| `POST /api/browse` | called `browse()` directly, returned a page dump | same door as `/api/agent`, `mode: "browse"`, returns the agent envelope |
| MCP `browse` | separate implementation | deprecated alias → `runAgent({mode:'browse'})` |
| MCP `web_agent_run` | the agent | deprecated alias → same `runAgent` |
| MCP `agent` | did not exist | **canonical**, `url`+`goal` or `query` |

Tool count went 44 → 45: one canonical name added, two kept as aliases so existing clients do not
break mid-flight. A hard removal would have been tidier on paper and a broken client in practice.

## Refusals rather than silent coercion

```
{"query":"x","mode":"browse"}  -> mode browse needs a url; use deep, tinyfish or auto for a query
{"goal":"x"}                   -> url is required unless query is given
{}                             -> goal (or query) must be 1-2000 characters
```

`fetch` and `browse` are page rungs; asking for them without a page is a mistake worth naming, not
something to quietly upgrade into a search.

## What is deliberately NOT merged

| thing | why it stays separate |
|---|---|
| `deep_search` (MCP) / `GET /api/search?mode=deep` | returns **ranked links**, no LLM synthesis. An agent call spends an LLM to answer; a search does not. Different outputs, different costs. |
| `deep_research_start` / `research_status` | a durable background job with a vault; not a synchronous call |
| `web_map`, `web_crawl_*`, `web_batch_*` | crawl mechanics, not agentic goals |
| `POST /api/browser` | a raw CDP session you drive yourself; the agent decides *what* to do, this hands you the browser |

## Where the deep rung still lives

The `deep` rung calls the A2A web agent at `127.0.0.1:42619`. That service is now an implementation
detail behind the ladder — not a public door anyone should call directly. Its token lives at
`~/.config/web-agent-deep/a2a-token`.

## Cost of each shape

- `{url, goal}` on a static page: free (`fetch` rung, one extract).
- `{url, goal}` needing interaction: `browse` (local Jev, free).
- `{query}`: one deep search + one LLM shaping call, ~14 s, no vendor credit.
- Anything that reports `escalated_to: "tinyfish"` cost $0.016/step — that field is the receipt.
