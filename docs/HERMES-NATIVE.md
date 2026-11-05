# Using phrog-web as Hermes's native web backend

Hermes's `web_search` and `web_extract` tools are backed by *provider plugins*, not by hardcoded
vendors. phrog-web now ships one, so the native tools call the local service directly — no MCP, no
vendor key in Hermes.

```bash
hermes plugins enable web-phrog-web          # the plugin
hermes config set web.search_backend phrog-web
hermes config set web.extract_backend phrog-web
```

Source lives in `hermes-plugin/web-phrog-web/` and is installed at
`$HERMES_HOME/plugins/web/phrog-web/`.

## Verified against the real tool wrappers

Not just the provider class — the actual functions the model calls:

```
web_search_tool("podman 5 release notes", 3)
  -> {"success": true, "data": {"web": [{"title": "podman/RELEASE_NOTES.md at main", "position": 1, ...}]}}

web_extract_tool(["https://podman.io/", "https://example.com/"])
  -> {"results": [{"url": "https://podman.io/", "title": "Podman", "content": "Podman\n- ..."}]}
```

`phrog-web` also needed `web` restored in `platform_toolsets.cli` — it had been dropped when the
MCP server was wired in, so the native tools were not even present to route.

## Native vs MCP — pick per need

Both doors stay open and neither is redundant:

- **Native** — the model sees familiar `web_search` / `web_extract`. Two tools, zero extra context.
- **MCP** — exposes the whole cookbook: `web_crawl`, `web_map`, `web_batch_start`, profiles, browser,
  keys. More capability, more tool-list weight.

A surface can have both; the backend keys only affect the native pair.

## Gotcha

Changing `platform_toolsets` or `web.*` does not alter a running session's tool list. The desktop
chat needs `/reset` before `web_search` appears.
