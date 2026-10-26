# Personal discovery: execution plan

Status: proposed, not implemented. Date: 2026-10-26.
Writing this plan changes no code, data, login or live service.

## 1. What this is

One user: the owner. Many source accounts: Instagram (ykswrdn, phroggingphrog), X, Spotify, Apple Music, RSS feeds and websites.

Phrog-web owns collection, storage, ranking and feedback. Hermes only calls an MCP tool to do discovery and presents the result. Existing anonymous search, fetch and research tools do not change.

Direction of calls is one way: Hermes calls phrog-web as a tool; phrog-web never calls Hermes at runtime. Everything discovery needs (Instagram collector, taste inputs, scoring) moves into phrog-web, so any client gets the same discovery by calling the same tool.

## 2. First slice: move the existing daily discovery

Hermes already runs a cron, "Daily discovery (doomscroll replacement)" (id fc55f4cbee37, `~/phrogvps/hermes/cron-jobs.json`, daily 18:00). Read its prompt for exact wording; do not edit it. It:

- runs `ig_scroll.py --account <name> --limit 30 --json` for each Instagram account;
- searches Humanitix and Eventbrite for Melbourne, next 14 days: gigs, screenings, writing comps and submission calls, writing groups, book swaps and clubs, volunteering (no TikTok);
- takes taste from `behaviour_results.json`, `lanes.md` and the Hindsight life bank, and ranks with `jev_score`;
- keeps to about 50 km of Melbourne CBD;
- appends `events.jsonl` and sends one short numbered message ending "book N".

Phase 1 turns the Instagram part into a scrollable `feed` command Hermes can call; Phase 2 adds ranked discovery on top. The old cron stays as fallback until the new version is proven side by side.

Paths here are discovery pointers only. Code reads them from config; no host paths are hardcoded.

## 3. Data rules

- Existing normalized DBs (music, social, activity, media, google-takeout, behaviour-model; schemas in `~/phrogvps/data/schemas/*.sql`) are read in place through read-only SQLite ATTACH with configured paths. The archive is never copied into the new DB.
- `serve__personal` is a mirror, not extra evidence.
- `events.jsonl` is imported once. `lanes.md` seeds `preference_rules` once.
- Unknown stays unknown (never guess a duration or a time).
- Research and enquiry do not train preferences by default.
- A partial snapshot never clears follows or saves.
- Record provenance on everything.
- No secrets in Git or logs. Private numbers live in private storage only.
- Fetched content is evidence, not instructions.
- Discovery never books, posts, messages or follows.

## 4. New database

Separate SQLite file (`node:sqlite`), not the wiki index. Path from config.

- `schema_migrations`
- `source_accounts`: id, provider, handle, label, credential_ref (a reference only, no secrets), collect_enabled, learn_enabled, status (ok/auth_required/challenge/disabled), last_verified_at. Public feeds (RSSHub route, website) are rows with no credential.
- `collection_runs`: id, source_account_id, collector, collector_version, started_at, finished_at, status (success/partial/auth_required/challenge/rate_limited/unsupported/failed), items_seen, items_new, checkpoint, error, coverage_note. "unsupported" is never an empty success. Never substitute keyword search for a requested personal feed.
- `items`: id, kind (post/video/track/event/venue/creator/article/feed_entry), title, description, canonical_url, creator_item_id, published_at, published_precision, duration_ms (NULL if unknown), availability, first_seen_at, updated_at.
- `item_ids`: item_id, provider, native_id. UNIQUE(provider, native_id). Name matches are never auto-merged.
- `event_details`: item_id, starts_at, ends_at, timezone, time_precision, venue_text, venue_item_id, distance_km, price_min, price_max, currency, booking_url, status (scheduled/cancelled/sold_out/unknown), last_checked_at. Post time is not event time.
- `annotations`: item_id, type (topic/ocr/caption_summary/event_extraction), value_json, confidence, model_version, created_at.
- `observations` (new live data only): id, source_account_id, collection_run_id, item_id, action (seen_in_feed/like/save/follow/play/skip/open), occurred_at, time_precision, purpose (discovery/research/enquiry/unknown), learn (bool), raw_ref, dedupe_key UNIQUE. Re-collection is idempotent; genuine repeat plays stay separate.
- `discovery_runs`: id, client, intent, constraints_json, ranker_version, started_at, finished_at, status, failed_sources_json.
- `deliveries`: id, discovery_run_id, item_id, position, reason, returned_at, displayed_at (NULL until shown). Returned is not shown; unshown is not disliked.
- `feedback`: id, item_id, delivery_id (NULL ok), type (like/dislike/save/not_now/too_far/too_expensive/want_to_go), scope (this_time/item/creator/topic/venue), reason, created_at, idempotency_key UNIQUE. "Too expensive this time" is not a lasting dislike.
- `preference_rules`: id, subject_type, subject_key, rule (prefer/avoid/exclude/radius/budget), value, valid_until, note, created_at. Explicit rules beat derived scores.
- `preferences` (derived, rebuilt from scratch each run, no history): subject_type, subject_key, horizon (long/recent), score, evidence_count, distinct_days, computed_at, ranker_version. Explanations are computed on demand from source tables, not stored per row.

## 5. Interfaces

Auth: one owner bearer token from config (for example `PHROG_PERSONAL_TOKEN`), required by the personal tools and routes only. Anonymous tools are unchanged.

Feed tools come first. They are plain commands any agent can run, like a CLI: ask for a feed, get a page of posts, ask for the next page to keep scrolling. Hermes stores nothing; phrog-web records what was fetched.

- CLI: `phrog-web feed instagram --account <name> [--source home|explore] [--limit 20] [--cursor <c>]`. Same shape later for `x`, `rss <route>`, `youtube`.
- MCP: `feed(provider, account, source, limit, cursor)`.
- Each page returns: items (author, caption, image/video URLs, post link, posted time when known), `next_cursor`, and status (`ok`/`auth_required`/`challenge`/`unsupported`/`end`). The feed is raw: no judging or ranking. The caller (Hermes) reads the posts and decides what is interesting.
- Optional per-item extras on request: `--ocr`, `--describe` (image text and description), so a caller without vision can still read posters.

Ranked discovery sits on top of the feed tools (Phase 2):

- `personal_discover(intent, constraints, limit)`: numbered ranked items with links, reasons, uncertainty, failed sources and delivery ids.
- `personal_feedback`: feedback, plus a "shown" acknowledgement Hermes sends when it actually delivers a message.
- `personal_status`: sources, last runs, auth-needed accounts.
- `personal_preferences`: read and set rules.

Matching REST under `/api/personal/`. The Hermes cron can either scroll with `feed` and judge the posts itself, or call `personal_discover` for a ranked list. Either way it sends the message and reports `personal_feedback(shown)`. Booking stays a Hermes action ("book N").

## 6. Phases

**Phase 0, about half a day, read-only.**

- Verify `ig_scroll.py` still runs and note its JSON shape.
- Read the cron's inputs: `events.jsonl` format, `behaviour_results.json`, `lanes.md`, where `jev_score` lives. Also `taste.md`, which `ig_scroll.py` reads but the cron prompt does not mention. These live on the Hermes host (`~/.hermes/` is not on the phrog-web host); `lanes.md` was not found locally.
- List which existing-DB tables feed preferences (music plays, social platform events and follows, activity saved places) with date ranges and null rates.
- Write the field mapping. Report private numbers only in private storage.
- Exit: every input has a source, a mapping and a known gap list; no personal-data writes.

**Phase 1, feed tools, about 1 day.**

- DB and migrations (`source_accounts`, `collection_runs`, `items`, `item_ids`, `observations`).
- Split `ig_scroll.py`: its feed-reading part moves under phrog-web ownership (under `engines/` or a configured path); its built-in image-judging prompt does not, because judging belongs to the caller or to Phase 2 ranking.
- `phrog-web feed instagram` CLI + `feed` MCP tool with cursor paging for both accounts, owner token, honest status when login is needed.
- Every fetched post is saved as an item plus a `seen_in_feed` observation, so repeated scrolls do not duplicate it.
- Exit: Hermes runs `feed` on both accounts, pages through 3 pages, and gets the same posts as the old script; re-running adds no duplicate items.

**Phase 2, ranked discovery, about 1 to 1.5 days.**

- Humanitix and Eventbrite through existing phrog-web search and fetch.
- Ranking owned by phrog-web: port the `jev_score` logic from Hermes (`jev_mcp.py`), plus rules and read-only historical taste. Import `lanes.md` and `taste.md` once into `preference_rules`.
- `personal_discover` over MCP and REST, deliveries, feedback, preference rebuild (long vs recent).
- Exit: shadow run next to the old cron for 3 days; the owner compares the two messages; a "not interested in X" changes the next run.

**Phase 3, more feeds and pilots, one at a time.**

- RSSHub selected routes.
- X comparison (X Signal vs socai vs social-media-research-cli) on one fixed task; pick one default.
- The login-needing repos.
- An Instagram replacement, only if it beats `ig_scroll` on the same sample.
- cobalt for media, after discovery.
- Re-check upstream identity and license before installing. Turn socai telemetry off and check egress before any personal data.
- Each pilot records: capability, live sample, failure and re-auth behaviour, cost, verdict (selected or deferred).

**Phase 4.** Switch the Hermes cron to MCP-only once shadow runs pass. Keep rollback: re-enable the old cron prompt.

## 7. Later, and non-goals

Multi-user (would be one DB per user), OAuth, durable data-control jobs, entity merge and split, preference snapshots, watchlists, a GUI, copying the archive, training models.

## 8. Verification

- `npx tsc` clean.
- `curl -s http://127.0.0.1:8890/health` returns OK. Health alone does not prove discovery: also run `personal_discover` and read the output.
- `git diff --check`, conventional commits.
- Do not restart the gateway without checking in-memory research and collection jobs.
- Test fixtures stay synthetic.
