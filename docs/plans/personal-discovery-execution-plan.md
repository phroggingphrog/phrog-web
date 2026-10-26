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
- `items`: id, kind (post/video/track/event/venue/creator/article/feed_entry), title, description, canonical_url, creator_item_id, published_at, published_precision, duration_ms (NULL if unknown), media_type (photo/carousel/video/reel), availability, first_seen_at, updated_at.
- `item_ids`: item_id, provider, native_id. UNIQUE(provider, native_id). Name matches are never auto-merged.
- `event_details`: item_id, starts_at, ends_at, timezone, time_precision, venue_text, venue_item_id, distance_km, price_min, price_max, currency, booking_url, status (scheduled/cancelled/sold_out/unknown), last_checked_at. Post time is not event time.
- `annotations`: item_id, type (topic/ocr/caption_summary/event_extraction), value_json, confidence, model_version, created_at.
- `observations` (new live data only): id, source_account_id, collection_run_id, item_id, action (seen_in_feed/like/save/follow/play/skip/open), feed_position, sponsored, suggested (as shown in that feed session), occurred_at, time_precision, purpose (discovery/research/enquiry/unknown), learn (bool), raw_ref, dedupe_key UNIQUE. Re-collection is idempotent; genuine repeat plays stay separate.
- `discovery_runs`: id, client, intent, constraints_json, ranker_version, started_at, finished_at, status, failed_sources_json.
- `deliveries`: id, discovery_run_id, item_id, position, reason, returned_at, displayed_at (NULL until shown). Returned is not shown; unshown is not disliked.
- `feedback`: id, item_id, delivery_id (NULL ok), type (like/dislike/save/not_now/too_far/too_expensive/want_to_go), scope (this_time/item/creator/topic/venue), reason, created_at, idempotency_key UNIQUE. "Too expensive this time" is not a lasting dislike.
- `preference_rules`: id, subject_type, subject_key, rule (prefer/avoid/exclude/radius/budget), value, valid_until, note, created_at. Explicit rules beat derived scores.
- `predictions`: item_id, collection_run_id, scorer (jev), passed_filter, filter_reason, screenshot_ref, model_version, preference_summary_version, p_match, p_engage, confidence, cost_usd, calibrated, created_at. Kept so owner reactions can check how good past predictions were.
- `agent_decisions`: id, item_id, collection_run_id, prediction_id, client (hermes), decision (interesting/not_interesting/send_to_owner/save_event), reason, created_at, idempotency_key UNIQUE. Never used as owner-taste labels.
- `preferences` (derived, rebuilt from scratch each run, no history): subject_type, subject_key, horizon (long/recent), score, evidence_count, distinct_days, computed_at, ranker_version. Explanations are computed on demand from source tables, not stored per row.

## 5. Interfaces

Auth: one owner bearer token from config (for example `PHROG_PERSONAL_TOKEN`), required by the personal tools and routes only. Anonymous tools are unchanged.

Feed tools come first. They are plain commands any agent can run, like a CLI: ask for a feed, get a page of posts, ask for the next page to keep scrolling. Hermes stores nothing; phrog-web records what was fetched.

- CLI: `phrog-web feed instagram --account <name> [--source home|explore] [--limit 20] [--cursor <c>]`. Same shape later for `x`, `rss <route>`, `youtube`.
- MCP: `feed(provider, account, source, limit, cursor)`.
- The feed behaves like the real app: posts come in the order Instagram served them, with the same mix (photos, carousels, reels, sponsored posts, suggested accounts you don't follow). Scrolling with `cursor` continues the same session, like swiping down; it does not restart from the top. `--order predicted` re-sorts a page by the prediction below; the default keeps Instagram's order.
- `--filter jev` (Phase 2): Jev scores every post from its text first; only posts that pass are rendered as screenshots and returned in full to Hermes. The rest stay in the DB and appear only as a count (`filtered_out`), or in full with `--include-filtered`.
- Optional per-item extras on request: `--ocr`, `--describe` (image text and description), so a caller without vision can still read posters.

Output is one versioned JSON schema (published as a JSON Schema file and in the MCP tool definition), the same for every provider:

```json
{
  "schema_version": "feed.v1",
  "provider": "instagram", "account": "<name>", "source": "home",
  "status": "ok | auth_required | challenge | unsupported | end | partial",
  "fetched_at": "UTC time", "cursor": "...", "next_cursor": "... | null",
  "items": [{
    "position": 1,
    "item_id": "phrog id", "native_id": "instagram id", "url": "post link",
    "type": "photo | carousel | video | reel",
    "sponsored": false, "suggested": false,
    "author": { "handle": "...", "name": "...", "followed": true },
    "caption": "...", "hashtags": [], "mentions": [],
    "media": [{ "type": "image | video", "url": "...", "alt_text": "...", "ocr_text": null, "description": null }],
    "posted_at": "UTC time | null", "posted_precision": "exact | day | unknown",
    "location": null, "like_count": null, "comment_count": null,
    "seen_before": false, "first_seen_at": "UTC time",
    "render": { "screenshot": "artifact URL | null", "width": 1080, "height": 1350, "rendered_at": "UTC time" },
    "filter": { "passed": true, "reason": "above_threshold | exploration | rule_override" },
    "prediction": {
      "p_match": 0.0, "p_engage": 0.0, "confidence": 0.0,
      "calibrated": false, "model_version": "...",
      "scorer": "jev", "preference_summary_version": "...", "cost_usd": 0.0
    }
  }]
}
```

Unknown fields are `null`, never guessed. `prediction` is `null` until Phase 2.

- `feed_decide(item_id, decision, reason)`: Hermes records its judgement on a post (section 5a).

Ranked discovery sits on top of the feed tools (Phase 2):

- `personal_discover(intent, constraints, limit)`: numbered ranked items with links, reasons, uncertainty, failed sources and delivery ids.
- `personal_feedback`: feedback, plus a "shown" acknowledgement Hermes sends when it actually delivers a message.
- `personal_status`: sources, last runs, auth-needed accounts.
- `personal_preferences`: read and set rules.

Matching REST under `/api/personal/`. The Hermes cron can either scroll with `feed` and judge the posts itself, or call `personal_discover` for a ranked list. Either way it sends the message and reports `personal_feedback(shown)`. Booking stays a Hermes action ("book N").

## 5a. Who decides, and how prediction works

**Hermes decides what is interesting.** phrog-web serves the feed and a probability per post; Hermes reads the posts and makes the call. Every call is saved in phrog-web's DB:

- Every `feed` call: a `collection_runs` row plus one `observations` row (`seen_in_feed`) per post, with its position and flags.
- Every Hermes judgement: Hermes calls `feed_decide(item_id, decision, reason)` (MCP + `phrog-web feed decide`), with decision `interesting` / `not_interesting` / `send_to_owner` / `save_event`. Stored in `agent_decisions` with the feed run, the prediction shown at the time, and the client name.
- Every owner reaction to what Hermes sent (reply, "book N", "not this", saved, ignored) arrives through `personal_feedback` and is stored as owner feedback.

**Jev gives the probability.** For each post, phrog-web calls Jev (`typesafe/jev-1.13` via OpenRouter's decisions endpoint, the same service Hermes's `jev_mcp.py` uses) directly, not through Hermes:

- State sent: the post (caption, author, type, OCR/description text, event date/place if found) and a short preference summary built from personal behaviour data (top authors, topics, places and recent changes from the social/behaviour DBs, `taste.md` and explicit rules). Raw history, messages and account credentials are never sent.
- Questions: one `score` question ("how well does this match the owner's preferences": none/low/medium/high) and one `noul` question ("would the owner want to see this today?"). Jev's probabilities fill `prediction.p_match` and `prediction.p_engage`, with its confidence and cost.
- Budget: configured max posts and dollars per day; skip Jev for posts already scored with the same preference-summary version.

**Jev is the filter before screenshots.** Rendering a post visually is the expensive step, so Jev decides which posts are worth it:

1. Fetch the page (text and media links only; no screenshots yet).
2. Jev scores every post from its text: caption, author, type, hashtags, location. A post with almost no text (a poster with an empty caption) gets cheap OCR of its image first so Jev is not judging a blank.
3. Posts with `p_match` at or above a configured threshold (start at medium) pass, capped at a configured number per page, highest first. Explicit `prefer`/`exclude` rules can force a post in or out.
4. Only passing posts are rendered as a screenshot of the post as Instagram shows it (image plus caption), saved as a phrog-web artifact, and sent to Hermes with the full `feed.v1` item. Hermes then looks at the screenshot and decides.
5. Exploration: a small configured share of filtered-out posts (for example 1 in 10) is also rendered and sent, marked `filter.reason = exploration`. Without this, Jev's misses would never be seen and the filter could not be measured or improved.

Every post, passed or not, keeps its Jev score in `predictions`, so the threshold can be tuned from owner reactions later.
- Explicit rules (`exclude`, `avoid`) override Jev.

**Keeping the learning honest:**

- Hermes's decisions are Hermes's guesses, not the owner's taste. They are stored and evaluated but never used as training labels for the owner's preferences; otherwise the system would learn from itself.
- Owner reactions are the truth labels. They update the preference summary and measure how good Jev and Hermes were: per decision type, hit rate, and Jev calibration (Brier score, reliability curve). `calibrated: false` until that check passes.
- Baselines to beat: Instagram's own order and "authors liked before". If Jev ordering does not beat them on owner reactions, keep the feed in Instagram order and leave `prediction` as information only.
- Later, only if Jev plateaus: a small local model trained on owner reactions, using Jev's score as one feature.

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
- `phrog-web feed instagram` CLI + `feed` MCP tool returning `feed.v1`, with cursor paging that continues the same scroll session, for both accounts; owner token; honest status when login is needed. Phase 0 checks whether `opencli instagram feed` can continue a scroll, and whether it exposes sponsored/suggested markers; if not, Phase 1 extends it.
- Every fetched post is saved as an item plus a `seen_in_feed` observation, so repeated scrolls do not duplicate it.
- Exit: Hermes runs `feed` on both accounts, pages through 3 pages, and gets the same posts as the old script; re-running adds no duplicate items.

**Phase 2, prediction and ranked discovery, about 2 to 3 days.**

- Humanitix and Eventbrite through existing phrog-web search and fetch.
- Ranking owned by phrog-web: the same Jev scoring as the feed, plus rules and read-only historical taste. Import `lanes.md` and `taste.md` once into `preference_rules`.
- Jev scoring in phrog-web (section 5a): preference summary from behaviour data, per-post Jev call with budget and caching, `prediction` filled in `feed.v1`, `--order predicted`.
- Jev filter + screenshots: threshold and per-page cap, OCR fallback for text-less posts, screenshot rendering of passing posts only (via the existing browser session), exploration share, `render`/`filter` fields. Exit: on a 3-page sample, screenshot count equals passed + exploration posts, and every post has a stored score.
- `feed_decide` tool and `agent_decisions`; owner reactions via `personal_feedback`; weekly report of Hermes hit rate and Jev calibration against owner reactions.
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
