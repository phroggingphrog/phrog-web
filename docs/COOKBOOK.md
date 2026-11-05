# The cookbook surface

Both the Firecrawl and the TinyFish cookbooks advertise the same eight or so verbs. phrog-web now
serves all of them behind one token, so nothing downstream needs either vendor's key. `GET
/api/cookbook` returns this table as JSON — it is the machine-readable version of this file.

## Firecrawl cookbook → phrog-web

| Cookbook | phrog-web | Notes |
|---|---|---|
| Search | `GET /api/search?q=&limit=` | TinyFish free tier first, Exa keyless, local SearXNG as fallback |
| Scrape | `POST /api/fetch {url}` | escalates plain → crawl4ai → jina → tinyfish on thin results |
| Interact | `POST /api/browse {url, goal}` | local Jev runner |
| **Parse** | `POST /api/parse {url}` or `{base64, filename}` | PDF/DOCX/XLSX/PPTX → Markdown, `maxChars` caps output |
| Agent | `POST /api/agent {goal, url}` | TinyFish agent, Builder key, $0.016/step |
| Crawl | `POST /api/crawl/start {url, maxDepth, limit}` | crawl4ai, background job |
| Crawl status | `GET /api/batch/:id` | |
| Map | `POST /api/map {url, limit}` | sitemap + page links |
| Batch scrape | `POST /api/batch {urls[]}` | max 50 |
| **Monitor** | `POST /api/monitor {url, selector}` · `POST /api/monitor/:id/check` · `GET /api/monitor` | content hash; reports changed yes/no |

## TinyFish cookbook → phrog-web

| API | phrog-web | Notes |
|---|---|---|
| Search | `GET /api/search` | Hobby key first |
| Fetch | `POST /api/fetch` | |
| TinyAgent | `POST /api/agent`, `POST /api/agent/stream` | Builder key |
| Research | `POST /api/research` + `GET /api/research/:jobId` | |
| **Browser** | `POST /api/browser {url}` → `{session_id, cdp_url, base_url}` | **billed $0.002/min** |
| Browser close | `DELETE /api/browser/:sessionId` | |

## Three rules this surface enforces

1. **`/api/browser` requires `url`.** An empty body used to mint a metered session; it is now a
   400. TinyFish has no session-listing endpoint, so an orphan cannot be found after the fact.
2. **Every session open and close is written to the run log** (`browser.session.open` /
   `.close`, with the `session_id`). That log line is the only recovery path for a session a
   caller forgot to close.
3. **`DELETE /api/browser/:sessionId` is not optional.** Sessions bill per minute until closed;
   `204` plus a `404` on the session's `/pages` is how you confirm the meter stopped.

## Example: scrape → parse → monitor

```bash
curl -s 'localhost:8890/api/search?q=podman+rootless&limit=5' | jq '.results[0]'
curl -s -X POST localhost:8890/api/fetch  -d '{"url":"https://podman.io/"}' -H 'Content-Type: application/json'
curl -s -X POST localhost:8890/api/parse  -d '{"url":"https://arxiv.org/pdf/1706.03762"}' -H 'Content-Type: application/json' | jq -r .length
curl -s -X POST localhost:8890/api/monitor -d '{"url":"https://podman.io/"}' -H 'Content-Type: application/json' | jq .id
curl -s -X POST localhost:8890/api/monitor/<id>/check | jq .changed
```

## Cost of each verb

Free: search (free tier), scrape, parse, map, crawl, batch, monitor, interact.
Paid: agent ($0.016/step), browser ($0.002/min), and any fetch that escalates to a paid provider.
