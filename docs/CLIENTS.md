# Client identity

`/mcp` used to accept any request that could reach the port. Anything on the box — or on the VM bridge,
since Hermes reaches it over `192.168.122.1` — could spend Builder credit, and the usage report could not
say who did it. Each caller now gets a token, which both gates the metered doors and stamps every run.

## Doors

| door | token |
|---|---|
| `/mcp` (all 51 tools) | required |
| `POST /api/agent`, `/api/browse`, `/api/browser` | required |
| `/api/research*`, `/api/crawl*`, `/api/batch*` | required |
| `/api/search`, `/api/fetch`, `/api/scrape`, `/api/parse`, `/api/profiles` | not required |
| `/api/clients`, `/health`, `/docs`, `/openapi.json` | not required |

Free endpoints stay open on purpose: gating search and fetch would tax every harness and buy nothing, since
neither spends credit. They still **record** identity when a token is present, so a report can say who the
traffic belongs to.

## Auth modes

`PHROG_WEB_MCP_AUTH` — set in the unit to `enforce`.

| mode | behaviour |
|---|---|
| `off` | tokens ignored, pre-identity behaviour |
| `warn` | anonymous calls allowed but recorded as `anonymous` (the default) |
| `enforce` | metered doors answer 401 without a valid token |

`warn` exists so the change could be rolled out and watched before closing the door; `enforce` is what is
deployed.

## Managing clients

```
GET    /api/clients            → { mode, clients:[{name, created_at, last_seen, calls}] }   (never a token)
POST   /api/clients {"name":"codex"} → { name, token, created_at, rotated }                 (token shown once)
DELETE /api/clients/:name      → { revoked } | 404
```

Tokens are 24 random bytes, base64url. The registry at `~/.config/phrog-web/clients.json` (0600) stores only
their SHA-256 — the plaintext is returned by `POST` and never again. Re-creating an existing name **rotates**
it and invalidates the old token.

Client management is deliberately **not** an MCP tool: an agent holding a token must not be able to mint
more tokens. It is loopback REST only, which means local shell access is the bar for issuing one.

## Wiring a harness

The token goes in the harness's own config, not in this service:

| harness | where |
|---|---|
| Hermes | `mcp_servers.phrog-web.headers.Authorization` in `~/.hermes/config.yaml` and the profile config |
| Codex | `[mcp_servers.phrog-web.http_headers] Authorization` in its `config.toml` (snap: `~/snap/codex/<rev>/config.toml`) |
| Claude Code | `mcpServers["phrog-web"].headers.Authorization` in `~/.claude.json` |
| OpenCode | `mcp.servers.web.headers.Authorization` in `~/.config/opencode/opencode.json` |

An unexpanded `${VAR}` in an authorization header is treated as no token rather than as a bad one, so a
config that references a variable nobody set fails the honest way — 401 with a hint — instead of sending a
literal string as if it were a credential.

## Attribution

Every run record now carries `client`. `GET /api/usage` reports:

```
by_client: [{client:"hermes",calls:2,errors:0,metered_sessions:0}, ...]
```

Two buckets are not names: `anonymous` (a call that carried no token) and `unknown` (a record written before
identity existed — it will age out of any window).
