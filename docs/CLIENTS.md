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
| `POST`/`DELETE` `/api/clients` | **admin token** (`x-phrog-admin`), never a client token |
| `GET /api/clients`, `/health`, `/docs`, `/openapi.json` | not required |
| `POST`/`DELETE` `/api/keys`, `POST /api/extract` | required (they change credentials or spend an LLM call) |

Free endpoints (search, fetch, scrape, parse, profiles) stay open on purpose: gating them would tax every
harness and buy nothing. They still **record** identity when a token is present, so a report can say who the
traffic belongs to.

**The door is matched on the normalised path, not the raw URL.** find-my-way percent-decodes and strips an
absolute-form prefix before routing, so an earlier version that tested `req.raw.url` let `/api/%72esearch/…`
and `GET /%6Dcp` through with no token. `src/auth-policy.ts` now tests every candidate form and treats an
undecodable path as metered; `tests/providers/auth-policy.test.ts` pins those exact strings.

**There is no loopback check and there cannot be one.** `ss -ltnp` shows a `socat` relay on
`192.168.122.1:8890` forwarding to `127.0.0.1:8890`, so every bridge caller arrives as `127.0.0.1`. Identity
is the only boundary that means anything here.

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

Client management is deliberately **not** an MCP tool, and not open REST either: `POST`/`DELETE` require the
service's admin token in `x-phrog-admin`, which is `PHROG_WEB_ADMIN_TOKEN` from
`~/.config/phrog-web.env` (0600). If that variable is unset, management answers 403 rather than falling open.
Reading the token from the file is the bar for minting a client — an agent holding a client token is
explicitly not enough.

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

Three buckets are not names: `anonymous` (a call that carried no token), `admin` (a management call) and
`unknown` (a record written before identity existed, plus any route that skips `enterClient` — `/api/clients`
and the static pages — so it never fully ages out).

Refusals are recorded too (`kind: "auth"`), so a blocked attempt is visible. They used to leave no trace: the
run log only instrumented `/api/*`, and a 401 on `/mcp` was invisible.

`PHROG_WEB_MCP_AUTH` defaults to `warn`, which means running the service by hand
(`node dist/index.js`, as `CLAUDE.md` suggests) leaves the metered doors open. Only the systemd unit sets
`enforce`.
