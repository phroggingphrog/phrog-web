# Shared MCP portal — 2026-10-26

Target connection: `https://mcp.phroggingphrog.com/mcp`.

## Applied change

Attached the existing Cloudflare MCP server `webagent` to portal `phrog`, with an explicit allowlist of its current 45 tools and `default_disabled: true` to prevent future tools being exposed automatically. Preserved the existing `context` (11 tools) and `task-control` (8 tools) settings. No source, tunnel, Access policy, client configuration or systemd service changes were made. No restart or push was performed.

Backup of the complete prior portal configuration (mode 600):
`~/.config/cloudflare/portal-phrog.json.bak-2026-10-26T10-36-06-257Z`.
Undo: restore the writable portal configuration fields and server settings from that backup through the Cloudflare portal API; remove only the added `webagent` attachment. Retain the original context and task settings.

## Verified architecture

`mcp.phroggingphrog.com` is an Access MCP portal, not a PHROG_LOCAL tunnel ingress. Its owner-email allow policy and service-token policy remain intact. OAuth protected-resource discovery points to the same public hostname as authorization server.

The existing `webagent` registration uses `https://mcp-webagent.phroggingphrog.com/mcp`. Tunnel version 95 routes that hostname to `http://127.0.0.1:8890`, with origin Host `127.0.0.1:8890`. Its remote capability sync succeeded and reported all 45 Phrog Web tools, including `deepwiki_read`, `github_download`, and `youtube_transcript`.

Context ingress routes to port 8929, overriding the historical 8916 unit setting. The separate self-hosted-web-mcp service on 8902 remains separate. No assistant service or route was changed or added.

Client inspection found Claude Code, Codex, Pi and Opencode2 global `web` entries pointing to local 8890. Codex also has the public `phrog` entry. All were preserved because public per-client verification has not passed. ChatGPT account-side connection settings were not accessible in this session; server-side portal metadata alone does not prove its installed connection state.

## Sanitized raw evidence

```
Unauthenticated public /mcp: HTTP 401
Cloudflare portal PUT: success true, HTTP 200
Portal server settings: task-control 8, webagent 45, context 11
Authenticated initialize: HTTP 200
Authenticated notifications/initialized: HTTP 202
Authenticated tools/list: HTTP 200, 14 tools, no nextCursor
Required web-tool matches in public tools/list: none
Existing context_context_search: present
portal_list_servers: Available MCP Servers: PHROG unified context (context): enabled
portal_toggle_single_server(webagent, toggle):
  Server with ID "webagent" not found. Available servers:
  DSH project tasks (task-control), Web agent (Deep Agents) (webagent),
  PHROG unified context (context)
npx tsc: exit 0
Local /health: {"status":"ok","service":"phrog-web","version":"0.1.0"}
```

The credentialed protocol probe used the existing Access service credential without printing it. Python's default user agent initially received HTTP 403 / Cloudflare error 1010 (`browser_signature_banned`); the curl protocol probe above succeeded. The publishing skill's generic API token received HTTP 401 on tunnel reads; the connected Cloudflare integration successfully read the live tunnel configuration. No OAuth Cloudflare login was attempted.

## Required owner action

1. Open the portal's server selection page and sign in with the owner Google account. A selection URL returned during this session is `https://mcp.phroggingphrog.com/authorize?elicitationId=8ce39750-7db3-4615-ac33-a9d1bf8f693d`. If expired, invoke `portal_toggle_servers` through the desired connection to obtain a fresh URL.
2. Retain PHROG unified context; enable Web agent (Deep Agents). Retain any existing task selection. Save the selection.
3. In ChatGPT Settings → Apps, open the existing Phrog connection's details and refresh its tools. If no Phrog connection exists, create one using the target URL and OAuth, then complete owner sign-in and server selection.
4. Verify authenticated public tools/list contains webagent-prefixed deepwiki_read, github_download and youtube_transcript and retains context tools. This is still a required check, not a completed claim.
5. Verify OAuth and tools/list separately in Claude Code and Opencode2 before changing their working local entries. Only after those proofs consolidate each onto the public connection. No local entry has yet been migrated.

ChatGPT refresh guidance: https://developers.openai.com/api/docs/guides/custom-mcp-server . OAuth guidance: https://developers.openai.com/plugins/build/auth .

## DSH trace

The vanilla DSH configuration's `mcp-web-agent` points to `http://127.0.0.1:8890/mcp`. In `src/providers/github.ts`, `provider_used: 'searxng-github'` is returned after a successful nonempty SearXNG request with `engines=github`; GitHub API is the fallback. This explains that provider label's code path. No specific historical DSH transcript was supplied or correlated, so this is not proof of a particular past call.
