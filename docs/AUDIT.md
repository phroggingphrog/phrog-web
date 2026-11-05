# MCP audit — every tool, exercised

Method: all 51 tools listed over the real MCP protocol (`initialize` → `tools/list` → `tools/call`) against
the running service, each called with the smallest arguments that prove it works, and each failure path
called deliberately. A "crash" verdict means the response contained a TypeError/undefined/NaN instead of a
message; "empty" means success with no content. Neither occurred.

Tools that cost money or write data were driven with the cheapest arguments that still exercise the real
path: `agent` on its free `fetch` rung, `research` in quick mode, `browse` against one page. Nothing that
opens a billed browser session was called.

## Result

| tool | arguments | verdict | time |
|---|---|---|---|
| `quick_search` | query | ok | 839 ms |
| `academic_search` | query, limit | ok | 2083 ms |
| `live_search` | query, time_range, limit | ok | 720 ms |
| `deep_search` | query, limit | ok | 6338 ms |
| `web_search` | query, limit | ok | 733 ms |
| `research_search` | query, preset, limit | ok | 799 ms |
| `github_search` | query, limit | ok | 560 ms |
| `deepwiki_structure` | repo | ok | 680 ms |
| `deepwiki_ask` | repo, question | ok | 11267 ms |
| `deepwiki_read` | repo, max_chars | ok | 2240 ms |
| `deepwiki_structure` | repo | err-clean | 302 ms |
| `wiki_search` | query, limit | ok | 4 ms |
| `media_search` | query, type, limit | ok | 4261 ms |
| `book_availability` | query, limit | ok | 3744 ms |
| `github_download` | repo | ok | 292 ms |
| `github_patch` | repo, number, kind | err-clean | 652 ms |
| `secondhand_search` | query | ok | 6296 ms |
| `secondhand_listing` | listingId, marketplace | err-clean | 258 ms |
| `marketplace_search` | query, limit | ok | 664 ms |
| `marketplace_product` | product | err-clean | 7 ms |
| `deals_search` | — | ok | 180 ms |
| `place_search` | query | ok | 5714 ms |
| `social_search` | query, limit | ok | 2419 ms |
| `youtube_transcript` | url, maxChars | ok | 5188 ms |
| `feed` | source, limit | ok | 1265 ms |
| `feed` | — | err-clean | 7 ms |
| `fetch` | url, max_chars | ok | 732 ms |
| `web_map` | url, limit | ok | 48 ms |
| `web_crawl` | urls, max_chars | ok | 413 ms |
| `web_crawl_start` | url, max_pages | ok | 9 ms |
| `web_batch_start` | urls, max_chars | ok | 10 ms |
| `extract` | urls, schema | ok | 7998 ms |
| `research` | question, workflow | ok | 7338 ms |
| `browse` | url, goal, max_seconds | ok | 20528 ms |
| `agent` | query, timeout_s | ok | 20224 ms |
| `research_vault` | action | ok | 2560 ms |
| `run_log` | limit | ok | 67 ms |
| `usage` | days | ok | 18 ms |
| `keys` | action | ok | 2 ms |
| `login_state` | action | ok | 21 ms |
| `monitor` | action | ok | 2 ms |
| `wiki_save` | — | err-clean | 2 ms |
| `research_status` | jobId | err-clean | 2 ms |
| `deep_research_status` | job_id | err-clean | 1 ms |
| `deep_research_resume` | run_id | err-clean | 2180 ms |
| `research_resume` | job_id | err-clean | 3 ms |
| `research_cancel` | job_id | err-clean | 2 ms |
| `web_crawl_status` | job_id | err-clean | 2 ms |
| `keys` | action, key, value | err-clean | 2 ms |
| `login_state` | action, url | err-clean | 2 ms |
| `monitor` | action | err-clean | 2 ms |
| `visual_search` | image | err-clean | 113 ms |

Totals: **36 ok, 16 clean errors, 0 crashes, 0 empty successes, 0 wrong results.**

Three tools are not in the table and were not called: `deep_research_start` and `literature_review` because
they start Feynman runs (they were verified separately by starting a job and cancelling it immediately —
see below), and `book_download`, which was verified separately with a real ref: 800,094 bytes written to
`downloads/` in 58 s.

## Defects found and fixed

**1. Deep research had two implementations.** `deep_research_start` used an in-memory map in
`providers/compat.ts` with UUID job ids; `research` and `literature_review` used the durable registry in
`providers/research.ts`. The consequence: a job started by `deep_research_start` could not be read by
`research_status`, could not be cancelled, and vanished on restart — and it reported
`runs_in: "this process (ends with the session)"`, which was accurate and useless. The compat entry points
now delegate to the one implementation, keep their old response shapes, and accept either a `fey_…` job id
or a raw Feynman run id (adopting the latter so it becomes trackable). The old machinery — a
`Map`, a promise gate, an `fcall` poller — is deleted.

**2. No single-run gate after that merge.** The old path deliberately ran one Feynman job at a time; the
new one did not, which risks two runs against one vault. Added a queue, then found a race in my own fix:
the slot was reserved only *after* the manifest was created, so two dispatches inside ~2 s both started.
Reservation is now synchronous at dispatch. Verified: the second start reports `queued`, and a job
cancelled while queued stays cancelled when the active job ends.

**3. Books were broken by an omission.** `book_availability` failed for every query. The cause was not
upstream: `ALL_SOURCES` listed only `zlibrary` (needs `ZLIBRARY_EMAIL`/`ZLIBRARY_PASSWORD`) and `annas`
(HTTP error here), while the engine's keyless **libgen** source — which works — was never asked. Added
libgen first. Verified with real rows: "dune" and "designing data intensive applications" both return
books, and `book_download` fetched an 800 KB epub.

The engine itself was also not built (`engines/zlibrary-mcp` had no `node_modules`, no `dist`, no `.venv`),
so every call failed with "is not built". Built it (`npm install`, `npm run build`, `uv sync --no-dev`).

**4. DeepWiki reported failures as successes.** For a repo without a wiki, DeepWiki answers HTTP 200 with
the failure as prose, and that prose was returned as `structure`/`contents` with `isError` unset — so an
agent read "Error fetching wiki for …: Repository not found" as content. Now detected and raised.
Verified both ways: `facebook/react` still returns real structure and answers; an unindexed repo errors.

**5. A "no results" that was really "nothing answered".** `book_availability` returned an empty list plus
`sources_failed`. If every source fails, that is a failure, not an absence of books; it now throws with the
per-source reasons.

**6. `feed` declared an optional field its provider requires.** The schema said `source` was optional while
the provider rejects a missing source, so the no-argument call failed with a schema-shaped error. The field
is now required and documented.

**7. Stale copy.** The `research` tool description still advertised "Vane", removed earlier in the session;
the book tools still said "needs credentials from `pnpm setup`". Both rewritten.

**8. Unknown job ids answered as data.** `deep_research_status` and `web_crawl_status` returned
`{"status":"unknown","error":"no such job"}` with `isError` unset, while `research_status` threw. Unified:
all three now error.

## Verified separately (not in the sweep)

| what | evidence |
|---|---|
| `deep_research_start` → `deep_research_status` → `research_cancel` | job created as `fey_…`, status readable with `feynman_run_id`, cancel reported "3 processes stopped", 0 workers left |
| second concurrent start | reports `queued`, not `running` |
| `literature_review` | dispatched `fey_…` with workflow `lit`, cancelled immediately |
| `book_download` | 800,094 bytes, source libgen |
| `deep_research_resume` with an unknown run | clean error: "Research run 'no-such-run' was not found" |
| `web_agent_run` (deprecated alias) | delegates to `agent`, returns the same envelope |
