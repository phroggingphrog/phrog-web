# Phrog Web

A TypeScript gateway for web search, page extraction, research and personal discovery. Clients use REST, streamable HTTP MCP or stdio MCP.

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

## Personal discovery

One owner can use multiple source accounts. The gateway implements feeds, ranked discovery, decisions, feedback, recently shown items and preference modelling. MCP tools include `feed`, `feed_decide`, `personal_discover`, `personal_feedback`, `personal_recent` and `personal_preferences`. RSS/Atom/JSON Feed sources are supported.

Configure the owner token with `PHROG_PERSONAL_TOKEN`. Personal REST routes live under `/api/personal/`; see `src/personalization/routes.ts` for authorization and request shapes. Existing source databases are read in place; use a consistent SQLite backup before deployment or migration.

Hermes cutover and the side-by-side comparison are tracked in TASK-338. Preserve the legacy discovery schedule until comparison evidence supports switching, and disable duplicate schedules when cutting over.

## Verification

```bash
pnpm build
pnpm test:personal
curl -fsS http://127.0.0.1:8890/health
```

The personal tests do not cover every upstream provider. Verify the intended MCP client, persistent data, restart behaviour and required credential-backed sources before release.

## Deployment

The portable user-service template is `deploy/units/phrog-web.service`; `scripts/phrog-web-service.sh` renders, installs, releases and rolls back builds. Inspect the rendered unit before installation and run release commands from the checkout the service uses. Keep a database backup separately: rolling back compiled code is not a database rollback.

See [HANDOVER.md](HANDOVER.md) for architecture and historical provider details. The personal-discovery documents under `docs/plans/` describe the original plan, not proof that the production schedule has switched.
