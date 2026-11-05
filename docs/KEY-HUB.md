# The key hub

phrog-web is the one place API keys live. Nothing downstream — Hermes profiles, dsh, the job
crawler, ad-hoc curl — should ever hold an upstream provider key. They hold **phrog-web's own
token** and call phrog-web.

## Where keys live

`~/.config/phrog-web.env`, mode `0600`. Two loaders read it: the app's own `loadEnvFile()` at
startup, and the systemd unit's `EnvironmentFile=-%h/.config/phrog-web.env`. A shell `export` is
invisible to a service started at boot, so put keys in the file, not your terminal.

## Managing keys

```bash
# what is configured (never the values)
curl -s localhost:8890/api/keys | jq '.keys[] | {key, provider, configured, length}'

# add or rotate — hot reloads, no restart, previous file backed up
curl -s -X POST localhost:8890/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"key":"TINYFISH_API_KEY_2","value":"..."}'

# remove
curl -s -X DELETE localhost:8890/api/keys/TMDB_API_KEY

# free-vs-paid visibility for TinyFish specifically
curl -s localhost:8890/api/keys/status | jq .tinyfish
```

`GET` reports `configured`, `length` and `source` (`env-file` / `process` / `none`) — enough to
spot a truncated paste without revealing anything. `secret: false` entries (location, mirror URLs,
email addresses) are still returned the same way.

## Plans and routing

TinyFish has two plans with different economics:

| Env var | Plan | Used for |
|---|---|---|
| `TINYFISH_API_KEY_2` | Hobby (free, 30 search/min) | search + fetch, tried first |
| `TINYFISH_API_KEY` | Builder (paid, 150 search/min, Agent 5 concurrent) | agent/browser work such as job crawling |

Search and fetch spend the free allowance first and fall through to Builder only on
`401/402/403/429`. Agent and browser calls prefer Builder. Every search response carries
`tinyfishPlan` so the plan that paid is visible per query.

## Provider route order (search)

`tinyfish` → `exa` (keyless) → *fallback tier* `searxng` (local fan-in), with `anysearch` and
`firecrawl` added in deep mode. Firecrawl itself tries: direct key → omniroute `/v1/search` →
crawl-egress tunnel → keyless direct.

## Rotating a leaked key

Anything pasted into a chat or a log is leaked. Rotate at the provider, then:

```bash
curl -s -X POST localhost:8890/api/keys -H 'Content-Type: application/json' \
  -d '{"key":"TINYFISH_API_KEY","value":"<new>"}'
```

No restart, no other config to touch.
