# "Deep" means four different things here

This name collision caused real confusion, so here is the map. Only research touches Feynman, and Vane is gone.

| # | what you call | actual endpoint | engine | returns | duration |
|---|---|---|---|---|---|
| 1 | **deep search** | `GET /api/search?mode=deep` | TinyFish → Exa → **anysearch + firecrawl** added | **ranked links** | 2–6 s |
| 2 | **deep agent** (page) | `POST /api/agent {url, goal, mode:"deep"}` | **A2A web-agent** at `:42619` | answer + steps | ~20–60 s |
| 3 | **deep search agent** (query) | `POST /api/agent {query}` | #1 then an LLM shapes an answer | answer + sources | ~14 s |
| 4 | **research (quick)** | `POST /api/research {mode:"quick"}` | **phrog-web search** + one LLM pass | answer + citations | ~5 s |
| 5 | **research (deep)** | `POST /api/research {mode:"deep"}`, `deep_research_start`, `literature_review` | **Feynman** (local engine, workflow subprocess) | job id + report + vault | minutes |

## So: was it Feynman?

**Yes for #5, no for #4.** Feynman is a local engine at `engines/feynman/bin/feynman.js`, spawned as a child
process with a workflow name (`deepresearch` by default) — see `providers/research.ts`. Its vault calls
are `feynman_vault_*`.

**None of #1, #2, #3 touch Feynman.**

## Vane was removed (2026-11-05)

Quick research used to POST to a self-hosted Vane container (`itzcrazykns1337/vane:slim-latest`,
`:3000`) and to a companion MCP wrapper on `:8931`. Measured against our own pipeline it lost on every
axis: **44-59 s** per question versus **4.7 s**, and worse sources — asked what Podman's pasta backend
is, Vane returned an IPv6-networking article, while search+LLM cited the Podman pasta docs.

So `executeQuickResearch` now runs `executeSearch()` and one LLM pass over the retrieved snippets.
The citations are the ranked search hits, which means quick-research quality is bounded by the same
pipeline the benchmark measures, instead of by a second retrieval stack nobody was tuning.

Removed: container `vane`, image (8.33 GB), `mcp-http-vane.service` (nothing referenced `:8931`,
checked in Hermes, Claude Code, Codex and OpenCode configs), `research.vane` config, and the vendored
`engines/vane` tree (37 MB, no code references). `~/projects/vane-mcp` was left untouched — that is a
working copy, not part of this service.

Restoring it, if ever wanted: `cd ~/projects/vane-mcp/vane && podman-compose up -d`, then restore the
unit from `~/backups/vane-removal-20261105/`.

## A wart this exposed, now removed

`search.ts` used to read:

```ts
const deepRequest = options.mode === 'deep' || isAcademic
  || options.provider === 'feynman' || options.provider === 'vane';  // BUG: neither is a search engine
```

That implied `provider: 'feynman'` was a valid way to select a search engine. It is not: `provider`
replaces the whole pipeline with that one name, and neither Feynman nor Vane is a search engine — the
call would have failed. The two terms are gone from that condition.

## And the response now tells you which one ran

Query-only agent used to report `escalated_to: "deep"`, identical to the A2A page rung — so two
completely different mechanisms were indistinguishable in the logs.

| call | `escalated_to` | steps |
|---|---|---|
| `{query}` | **`deep-search`** | `search`, `shape` |
| `{url, goal, mode:"deep"}` | `deep` | `deep-agent`, `shape` |
| `{url, goal}` on a static page | `fetch` | `fetch+extract` |

Verified live:

```
{"query":"what is pasta in podman rootless networking"}   -> escalated_to: deep-search, steps: [search, shape]
{"url":"https://podman.io/","mode":"deep"}                -> escalated_to: deep,        steps: [deep-agent(21.6s), shape]
GET /api/search?mode=deep -> provider_used: tinyfish,exa,anysearch,firecrawl, 3 links
```

## Which should you call?

| you want | call |
|---|---|
| links to read yourself | `GET /api/search?mode=deep` |
| an answer about one page | `POST /api/agent {url, goal}` |
| an answer from the web, no page in mind | `POST /api/agent {query}` |
| a long sourced report you can resume | `deep_research_start` |

## Deep jobs now survive a restart (as records, not as processes)

`GET /api/research/:jobId` used to read an in-memory `Map`, so a service restart erased every job and
the id you were polling became a 404. Each job is now written to
`~/.local/state/phrog-web/research-jobs/<jobId>.json` (atomic temp+rename) at creation, when the PID is
assigned, and again when it settles, and lookups read through to disk.

The Feynman child process is still a child of the service, so a restart kills the *work* even though the
record survives. Those jobs are reconciled on boot and reported as **`interrupted`** with an explicit
message rather than `running` forever:

```
{"status":"interrupted","error":"The service restarted while this run was in progress; the Feynman child
  did not survive. Re-run, or use `feynman research run` for a durable run."}
```

Verified: a job dispatched and completed before `systemctl --user restart phrog-web` is still readable
afterwards with its 10,072-character deliverable and `exitCode: 0`; an orphaned `running` record becomes
`interrupted` on the next boot; a genuinely completed record is left alone.

Feynman itself already has durable runs (`feynman research run` — create/observe/checkpoint/resume).
Wiring the deep branch onto those subcommands instead of a bare spawn is the remaining step, and is what
would make a deep job actually resumable rather than merely recorded.

## Is quick research worth delegating to Feynman? No.

Feynman exposes no single-pass mode. Its workflows are `audit`, `autoresearch`, `compare`,
`deepresearch`, `draft`, `lit`, `recipe`, `replicate`, `review`, `summarize` — every one a multi-step
agent loop on `omni/openai/sol`. Delegating quick research to it would make quick cost the same as deep,
against the 4.7 s the search + one-LLM-pass path takes.
