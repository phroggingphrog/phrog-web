# Phrog Web

A TypeScript gateway for web search, page extraction, research and feeds. Clients use REST, streamable HTTP MCP or stdio MCP.

## Requirements and setup

Use Node.js 22.20 or newer and pnpm. Embedded engines live under `engines/`; provider availability depends on engine setup and credentials.

```bash
pnpm install
pnpm setup
pnpm build
pnpm start
```

Configuration loads from `~/.config/phrog-web.env`, then local environment files; existing environment variables take precedence. Keep credentials out of Git. Inspect `src/config.ts` and `src/setup.ts` for supported settings and setup checks.

The default gateway is `http://127.0.0.1:8890`. Keep it on a trusted local network; do not expose the whole API publicly without an authenticated access boundary.

## Interfaces

```bash
curl -fsS http://127.0.0.1:8890/health
curl -fsS 'http://127.0.0.1:8890/api/search?q=example&limit=3'
curl -fsS http://127.0.0.1:8890/api/fetch \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
```

- **HTTP MCP:** `http://127.0.0.1:8890/mcp`.
- **Stdio MCP:** run `node dist/adapters/mcp/server.js` from this checkout.
- **CLI:** `node dist/cli.js --help`.
- **Function schemas:** `src/adapters/schemas/hermes-tools.json`.

Search uses SearXNG and TinyFish. Fetch supports plain extraction, rendered pages and document conversion. Research supports Vane and Feynman. Additional providers cover repositories, media, books, social content and places; a provider being implemented does not establish that its credentials or upstream service work on a given deployment.

## Wiki storage

`wiki_save` writes Markdown notes into the wiki inbox and indexes them immediately; `wiki_search` searches that local SQLite library index. Configure `WIKI_DIR` (default `./wiki`), `WIKI_INBOX_DIR` (default `<wiki root>/inbox`), and `WIKI_INDEX_PATH` (default `<wiki root>/.index.db`) in `pnpm setup` or the MCP server environment. Relative paths resolve from the gateway working directory. Configure the same values for each client or gateway that should use the same files. Existing notes and brain-wiki files are not moved automatically.

## Feeds

The `feed` tool and `/api/personal/feed` provide Instagram and RSS feeds in source order, without preference scoring or ranking. Instagram requires a configured collector account; RSS supports RSSHub and public feeds. Feed artifacts and stored items are accessible through the gateway, so deploy behind an appropriate access boundary when using private sources.

## Verification

```bash
pnpm build
pnpm test:personal
curl -fsS http://127.0.0.1:8890/health
```

The feed tests do not cover every upstream provider. Verify the intended MCP client, persistent data, restart behaviour and required credential-backed sources before release.

## Deployment

The portable user-service template is `deploy/units/phrog-web.service`; `scripts/phrog-web-service.sh` renders, installs, releases and rolls back builds. Inspect the rendered unit before installation and run release commands from the checkout the service uses. Keep a database backup separately: rolling back compiled code is not a database rollback.

See [HANDOVER.md](HANDOVER.md) for architecture and historical provider details.
