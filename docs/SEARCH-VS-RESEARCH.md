# "Deep" means four different things here

This name collision caused real confusion, so here is the map. Only one of them is Feynman/Vane.

| # | what you call | actual endpoint | engine | returns | duration |
|---|---|---|---|---|---|
| 1 | **deep search** | `GET /api/search?mode=deep` | TinyFish → Exa → **anysearch + firecrawl** added | **ranked links** | 2–6 s |
| 2 | **deep agent** (page) | `POST /api/agent {url, goal, mode:"deep"}` | **A2A web-agent** at `:42619` | answer + steps | ~20–60 s |
| 3 | **deep search agent** (query) | `POST /api/agent {query}` | #1 then an LLM shapes an answer | answer + sources | ~14 s |
| 4 | **research (quick)** | `POST /api/research {mode:"quick"}` | **Vane** (`:3000`, AI answer engine) | answer + citations | 15-60 s |
| 5 | **research (deep)** | `POST /api/research {mode:"deep"}`, `deep_research_start`, `literature_review` | **Feynman** (local engine, workflow subprocess) | job id + report + vault | minutes |

## So: was it Feynman/Vane?

**Only #4 and #5.** Vane is a container (`itzcrazykns1337/vane:slim-latest`) on `127.0.0.1:3000` that returns a synthesised answer plus 20 retrieved sources; `executeQuickResearch` posts to its `/api/search` with the omniroute chat model. Feynman is a local engine at `engines/feynman/bin/feynman.js`, spawned as a child
process with a workflow name (`deepresearch` by default) — see `providers/research.ts`. Its vault
calls are `feynman_vault_*`. Vane is a separate HTTP research service at
`http://127.0.0.1:3000/api/search`, used as a research provider, not as a web search engine.

**None of #1, #2, #3 touch Feynman or Vane.**

## A wart this exposed, now removed

`search.ts` used to read:

```ts
const deepRequest = options.mode === 'deep' || isAcademic
  || options.provider === 'feynman' || options.provider === 'vane';
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
