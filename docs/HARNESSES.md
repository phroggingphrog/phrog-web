# phrog-web in coding harnesses

phrog-web speaks three protocols, so every harness can use it one way or another. The MCP endpoint
needs **no token on loopback** (`POST /mcp` returns 200 unauthenticated), so wiring is just a URL.

| harness | how it reaches phrog-web | state |
|---|---|---|
| Hermes | native `web_search` / `web_extract` via the `web-phrog-web` backend plugin | wired (`web.search_backend=phrog-web`) |
| Codex CLI | MCP streamable HTTP | `codex mcp add phrog-web --url http://127.0.0.1:8890/mcp` |
| Claude Code | MCP http | `~/.claude.json` → `mcpServers.phrog-web` |
| OpenCode | MCP http | `opencode.json` → `mcp.servers.web` (already present) |
| dsh | MCP, or its own `dsh-web-search` plugin format | not installed on PATH here |
| anything with a shell | REST `http://127.0.0.1:8890/api/…` | no token on loopback |

## Why MCP rather than a bespoke plugin per harness

Hermes is the only harness that exposes a documented "web search provider plugin" seam, so it gets
the native two-tool treatment (`web_search`, `web_extract`). Every other harness speaks MCP, so one
endpoint serves them all and exposes the full 44-tool surface instead of a two-tool subset.

## Verification

```
$ codex mcp list
Name       Url                        Bearer Token Env Var  Status   Auth
phrog-web  http://127.0.0.1:8890/mcp  -                     enabled  Unsupported

$ curl -s -X POST http://127.0.0.1:8890/mcp -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
-> 44 tools ("Auth: Unsupported" only means no OAuth flow, which is correct for loopback)
```

## Caveats

- Loopback-only and unauthenticated: anything on this box can call it. That is the deliberate
  single-owner trade-off, not an oversight — do not publish this port.
- `platform_toolsets` and MCP config are read at session start. A running Hermes/Codex/Claude
  session does not gain the new tools until it is restarted.
- Claude Code already routes `web` through the `:18936` gateway (token-gated). The new `phrog-web`
  entry is a direct path that does not depend on that gateway being up.
