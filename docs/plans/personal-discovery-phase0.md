# Personal discovery: Phase 0 audit

Date: 2026-10-26. Read-only audit. Nothing was run against Instagram, Jev or any paid API, and no personal database was written. Private numbers and samples are in private storage outside this repo. This note holds no personal values.

Facts below were read from source or from file metadata. Items marked (inference) were not tested.

## 1. Input inventory

| Input | Where | Status |
|---|---|---|
| `opencli instagram feed` | Hermes VM only. Local adapter `~/.opencli/clis/instagram/feed.js` (not upstream), OpenCLI 1.8.8 | canonical for live feed; not on the phrog-web host |
| Logged-in Instagram browser | Hermes VM, user service `opencli-chrome` (virtual display, CDP on VM loopback). Shared with the Hermes cron | canonical; unreachable from phrog-web except over ssh |
| Account switch | VM `~/.opencli/igswitch.py`: swaps saved cookie files and restarts the shared Chrome | canonical; disruptive (see gaps) |
| `ig_scroll.py` | Source copy `~/phrogvps/hermes/scripts/ig_scroll.py`; runs on the VM | canonical; mixes feed reading with LLM judging |
| `events.jsonl` | Hermes VM `~/.hermes/assistant/` | canonical, VM only; one-time import |
| `taste.md` | same directory | canonical, VM only; seeds rules once |
| `lanes.md` | same directory (not on the phrog-web host) | canonical, VM only; seeds rules once |
| `behaviour_results.json` | `~/brain/data/analysis/behaviour-model/` on the phrog-web host, byte-identical copy on the VM | derived (from `behaviour.sqlite`); usable in place |
| Hindsight `life` bank | VM read-write MCP; read-only `hermes-memory` MCP from the host | canonical; contents not inspected |
| Jev | `typesafe/jev-1.13` via OpenRouter `/api/alpha/decisions`; wrapper `jev_mcp.py` | external service; key file on Hermes side, not read |
| `social.sqlite` | `~/brain/data/social/` (host) | raw observations, built from exports |
| `music.sqlite` | `~/brain/data/music/` (host) | raw observations, built from exports |
| `activity.sqlite` | `~/brain/data/activity/` (host) | raw observations (saved places has no timestamp) |
| `media.sqlite` | `~/brain/data/media/` (host) | derived (OCR and descriptions) plus file index |
| `behaviour.sqlite` | `~/brain/data/analysis/behaviour-model/` (host) | derived |
| `serve/personal.sqlite` | `~/brain/data/serve/` (host) | mirror of the above plus derived views; do not attach as evidence |
| Post screenshots | no source | unavailable (see section 4) |
| Sponsored/suggested exposure history | `social.platform_events` ad-view rows | exists for 2026 only, up to the export date |

All canonical DB files are on the phrog-web host. The Instagram, Hermes and cron inputs are on the Hermes VM.

## 2. Field mapping

### 2.1 `opencli instagram feed` output to `feed.v1`

Observed output columns: rank, user, date (day only), place, caption (cut at 400 characters), type (photo, video or carousel), url, image (first image only). `ig_scroll --json` adds what, event, worth, why (LLM judging).

| feed.v1 field | opencli feed source | Gap |
|---|---|---|
| `position` | rank | rank is after filtering ads, so it is not the position Instagram served |
| `native_id` | shortcode inside `url` | the numeric id is available in the API response but not output |
| `url` | url | always built as a `/p/` link, even for reels |
| `type` | type | reel cannot be told from video; carousel is "anything else" |
| `sponsored` | none | ads are dropped before output, never flagged |
| `suggested` | none | not detected |
| `author.handle` | user | name and followed flag missing |
| `caption` | caption | truncated; hashtags and mentions must be parsed from it |
| `media[].url` | image | first image only; no video URL, no other carousel slides, no alt text |
| `posted_at`, `posted_precision` | date | day precision only (`posted_precision: day`) |
| `location` | place | name only |
| `like_count`, `comment_count` | none | `null` |
| `cursor`, `next_cursor` | none | the adapter keeps a cursor internally and discards it |
| `render` | none | no screenshot capability (section 4) |
| `filter`, `prediction` | none | Phase 2 |

### 2.2 Existing tables to the plan's tables

| Existing | Plan table | Notes |
|---|---|---|
| `social.platform_events` (instagram, like/save/comment-like/not-interested; author in `counterparty`) | read-only evidence for `preferences`; not copied into `observations` | account labels are anonymised: `ig-account1` is ykswrdn, `ig-account2` is phroggingphrog (from the build script) |
| `social.platform_events` ad-view and post-view rows | read-only evidence for `sponsored`/exposure rates | 2026 only |
| `social.follows` (following, unfollowed, close_friend) | `preferences` evidence and the `author.followed` flag | partial-snapshot rule applies: a bulk unfollow month must not clear follows |
| `social.my_comments` | `preferences` evidence | URL missing |
| `music.plays` (service, account, artist, track, ms_played, skip flags) | `preferences` evidence | two services; duration unknown for part of one service, so keep NULL |
| `music.apple_favorites`, `spotify_library` | `preferences` evidence | |
| `activity.saved_places` | `preferences` evidence (places, venues) | no save date; do not guess one |
| `activity.event_places`, Maps events | place evidence for distance | |
| `behaviour.events`, `topic_flags` | topic evidence | derived; account separation lost; do not mix with raw counts |
| `media.media_text` | none in Phase 1 | cannot be joined to Instagram posts (post URL and author columns are empty) |
| `events.jsonl` | one-time import into `items` + `event_details` | keys are inconsistent (some rows have `source` instead of account/user, a few have extra keys); date and time are free text, so keep precision `unknown` unless parsed |
| `lanes.md`, `taste.md` | one-time seed of `preference_rules` | free markdown; needs hand mapping to subject/rule pairs |

Observed null behaviour that affects mapping: like and save rows always have an author and a timestamp; post text (title) is empty for almost all Instagram actions; saved-post URLs are often missing; media rows for Instagram have no author or URL.

Time coverage: the exports stop in early September 2026 (Spotify earlier, January 2026). Nothing in these DBs reflects the last weeks, so recent taste must come from new live observations and owner feedback.

## 3. Jev call shape (described, not called)

- Request: POST to the OpenRouter decisions endpoint with `{model, state, questions}`. `state` is arbitrary JSON (the Hermes wrapper sends `{"text": ...}`). `questions` maps an id to `{type, instructions, criteria?}`.
- `noul`: yes/no, `instructions` only. Existing callers read `answers[id]["noul"]` as a probability from 0 to 1.
- `score`: `criteria` is an ordered list of level names, lowest first. The wrapper documents score, per-level probabilities and confidence in the reply. The exact reply key names for `score` were not verified.
- Cost is read from `usage.cost`. Errors return the HTTP body.
- The wiki guide says 1.14 is current and 1.13 is still available. Probabilities are not calibrated. The plan names 1.13; Phase 2 should pick the version deliberately.

## 4. Gaps and blockers

1. **No cursor.** `opencli instagram feed` starts a fresh feed on every call (cold start) and discards the continuation token. `--limit` is the only paging control. The plan's "continue the same scroll" cannot work with this adapter.
2. **Sponsored removed, suggested absent.** The adapter filters ads out, so `sponsored` cannot be reported. There is no marker for suggested posts.
3. **Thin item data.** No numeric id, day-precision date, caption truncated, one image per post, reels reported as video, no counts, no author name or followed flag.
4. **Collector and browser are on the Hermes VM.** phrog-web runs on the host. The host can reach the VM over ssh, but the logged-in Chrome is on the VM loopback.
5. **Shared browser and account switching.** Switching ykswrdn to phroggingphrog swaps cookies and restarts the Chrome the Hermes cron also uses. Attaching raw CDP leaves the OpenCLI extension unusable until restart. Phase 1 needs one lock shared with the cron, and must not switch accounts while the cron runs.
6. **No honest status.** An empty or failed feed becomes an empty list; ig_scroll then restarts Chrome blindly and, after the second failure, carries on with nothing. Login expiry, challenge and rate limit are not distinguishable.
7. **Current cron never shows images to Hermes.** `ig_scroll` sends the first image to a cheap vision model and returns only a digest; Hermes judges text. Plan section 5a has Hermes looking at a screenshot. That changes behaviour relative to the working baseline and should be decided before building (see recommendation 6).
8. **No screenshot capability in phrog-web.** Existing browser code uses fresh anonymous headless Chromium without a profile (places, visual, marketplace, browse). None holds an Instagram login. `src/browser/` is empty.
9. **Raw feed JSON is not kept.** Cron outputs hold only the final message. Past raw feeds survive only inside Hermes's session store. There is no saved sample for fixtures, so synthetic fixtures must be written from the observed shape.
10. **`lanes.md`, `taste.md`, `events.jsonl` exist only on the VM**, and `events.jsonl` has mixed shapes.
11. **Hindsight life bank contents were not inspected**, so its usable fields are unknown.
12. **History is stale and thin for text.** No like or save row carries post text, and ids link only through author and URL.

## 5. Recommendation for Phase 1

1. Keep `ig_scroll` as the fallback. Do not edit the cron.
2. Replace the adapter instead of wrapping it: write a phrog-web-owned Instagram timeline reader (a small script run inside the existing logged-in tab) that returns the raw fields in 2.1, keeps ad and suggested markers as flags, and returns `next_max_id` so `--cursor` can continue. Drop the 400-character caption cap; keep the full media list and numeric id. Everything else in feed-reading stays unchanged.
3. Run the collector on the Hermes VM and call it from the host over ssh (or move the HTTP service next to it). Pick one and record it in config; no host paths in code.
4. Add a shared lock with the Hermes cron for the browser, and make account switching an explicit, locked step, not a side effect of every call. Return `auth_required`, `challenge`, `rate_limited` and `unsupported` instead of an empty list.
5. Seed the DB from nothing: Phase 1 tables only (`source_accounts`, `collection_runs`, `items`, `item_ids`, `observations`). Read the existing DBs through read-only attach in Phase 2, not Phase 1. Import `events.jsonl`, `lanes.md` and `taste.md` in Phase 2 with hand-checked mapping.
6. Before Phase 2, decide the baseline for judging: the working system judges images with a cheap vision model, then Hermes decides on text. Matching that exactly (OCR/vision text in `media.description`, no screenshot) is closer to parity than screenshots. Screenshots can stay a later option, built from the fetched image plus caption in the existing headless puppeteer, or from the anonymous embed page (inference, untested).
7. Save a few synthetic feed.v1 fixtures from the field list above; do not copy real posts.
8. Do not use `serve/personal.sqlite` or `behaviour.sqlite` as independent evidence of preferences; use the raw tables and read-only access.
