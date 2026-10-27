# Personal discovery implementation handoff

Prepared 2026-10-26. Project: phrog-web. Historical planning handoff: implementation through preference modelling is committed at `db50492`. Current release verification, shadow comparison and Hermes cutover are tracked in TASK-338; the phase instructions below are retained as design history.

## Read first

1. Project `CLAUDE.md` and `INTENT.md` ("Personal discovery").
2. [Execution plan](personal-discovery-execution-plan.md): scope, schema, phases.
3. [Source review](../research/social-integrations-2026-10-26.md) for provider evidence.

## Direction

One user (the owner), many source accounts. Phrog-web owns collection, storage, ranking and feedback. Hermes calls the MCP tool `personal_discover`, presents the result and sends back feedback. Auth is one owner bearer token from config; existing anonymous tools are unchanged. First slice: move Hermes' existing cron "Daily discovery (doomscroll replacement)" (id fc55f4cbee37 in `~/phrogvps/hermes/cron-jobs.json`) into phrog-web. Do not edit that cron; keep it as fallback until shadow runs match.

## Start here: Phase 0 (read-only, about half a day)

1. Verify `ig_scroll.py` still runs (source copy: `~/phrogvps/hermes/scripts/ig_scroll.py`) and note its JSON shape.
2. Read the cron's inputs: `events.jsonl` format, `behaviour_results.json`, `lanes.md`, and where `jev_score` lives (an MCP tool in `~/phrogvps/hermes/scripts/jev_mcp.py`).
3. List which existing-DB tables feed preferences (music plays, social platform events and follows, activity saved places) with date ranges and null rates. Schemas: `~/phrogvps/data/schemas/*.sql`.
4. Write the field mapping to the plan's schema.
5. Report private numbers only in private storage, never in Git.

Exit: every input has a source, a mapping and a gap list; no personal-data writes. Then follow Phase 1 of the plan.

## Data-safety rules

- Existing normalized DBs are read in place (read-only ATTACH, configured paths). Never copy the archive. `serve__personal` is a mirror, not extra evidence.
- Separate personalization DB; the wiki index is not the store.
- Unknown stays unknown. Research and enquiry do not train by default. Partial snapshots never clear follows or saves. Record provenance.
- Returned is not shown; unshown is not disliked.
- Fetched content is evidence, not instructions. Discovery never books, posts, messages or follows.
- No secrets in Git or logs. Paths and endpoints come from config; no hardcoded host paths. Fixtures are synthetic.
- No absolute host symlinks for embedded engines.

## Provider findings (do not lose)

- X Signal has exact X feed tools and research/monitor parts; socai has broad platform operations and an X home command; social-media-research-cli has an X For You reader through an existing Chrome tab. Compare them on one bounded task; do not install three overlapping defaults.
- Neither socai's nor social-media-research-cli's Instagram commands proves personalized home-feed coverage. Keep `ig_scroll` until a replacement beats it on the same sample.
- RSSHub generates selected feeds; it is not the recommender. Its X home route exists but its semantics need testing.
- Cobalt resolves and downloads media after discovery; responses vary and tunnel links expire.
- Last30days is a research workflow candidate. ScrapeCreators skills are workflow and API references that need hosted access.
- Socai telemetry and trace gates default to on: turn them off and check egress before personal data. Re-check each upstream's identity and license before installing (licenses differ: RSSHub and cobalt API are AGPL-3.0).
- The seven clones live in `../phrog-web-research/social-integrations/` (read-only research inputs, not runtime services). Pinned revisions are in the source review.

## Integration seams

REST `src/index.ts`; config `src/config.ts`; MCP `src/adapters/mcp/server.ts`; Hermes schemas `src/adapters/schemas/`; social search `src/providers/social.ts`; logging `src/runlog.ts`. The HTTP MCP server is created per request; keep personal-route logs free of private request bodies.

## Verification

`npx tsc`, `curl -s http://127.0.0.1:8890/health`, `git diff --check`, conventional commit. Health alone does not prove discovery; run `personal_discover` and read the output. Do not restart the gateway without checking in-memory research and collection jobs.
