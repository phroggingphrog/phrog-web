# Hermes native backend for phrog-web

Makes Hermes's built-in **`web_search`** and **`web_extract`** tools call phrog-web over its REST
API — no MCP server, no vendor key in Hermes.

## Install

```bash
mkdir -p "$HERMES_HOME/plugins/web"
cp -r hermes-plugin/web-phrog-web "$HERMES_HOME/plugins/web/"
hermes plugins enable web-phrog-web
hermes config set web.search_backend phrog-web
hermes config set web.extract_backend phrog-web
```

`web` must also be in `platform_toolsets.<surface>` for the surface you use.

## Why a provider plugin and not MCP

Both work, but they are different doors:

| | native (`web_search`/`web_extract`) | MCP (`mcp_servers.phrog-web`) |
|---|---|---|
| tool names the model sees | Hermes's own | `quick_search`, `web_fetch`, … |
| config | `web.search_backend` | MCP server block |
| auth | none (loopback) | bearer token |
| extra tools | only the 2 web tools | the whole 15-capability surface |

Keep MCP for the cookbook verbs (crawl, map, batch, profiles, browser); use the native backend when
you want Hermes's web tools to just be phrog-web.

## Mapping

| Hermes | phrog-web |
|---|---|
| `web_search(query, limit)` | `GET /api/search?q=&limit=` |
| `web_extract(urls)` | `POST /api/scrape {url, formats:["markdown","links"], profile:true}` per URL |

`profile: true` means extract automatically uses a saved login jar for that site when one exists.
Per-URL failures come back as `{"url", "error"}` entries, never as an exception.

## Rules this plugin follows

- Imports only the public `agent.web_search_provider.WebSearchProvider` ABC. Hermes's
  `plugins.web._common` is an in-tree seam; a third-party plugin importing it fails
  `hermes plugins validate` with "private core imports".
- `is_available()` makes no network calls (it runs on every `hermes tools` repaint).
- `PHROG_WEB_URL` defaults to `http://127.0.0.1:8890`.
