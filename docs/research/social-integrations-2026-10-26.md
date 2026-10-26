# Social integrations: source review and recovered project intent

Reviewed 2026-10-26. Scope: clone and explore the five shortlisted upstream repositories, recover the older doomscroll/social-replacement ideas, and identify integration boundaries. No provider installation, account access, service deployment, or implementation was performed.

## Conclusion

The older goal is to have Hermes read the owner's feeds, find relevant local events and useful material, learn preferences, and deliver a small selection with source links. Topic search is one input to that goal; it does not replace a personalized feed.

For that goal, X Signal is the most directly matched X component in this shortlist. Socai offers broader platform operations, but its Instagram adapter does not expose a home-feed command at the reviewed revision. RSSHub supplies selected account/channel feeds and an authenticated X home route. Last30days supplies research planning, evidence fusion, watchlists, and briefing code. ScrapeCreators supplies workflow instructions and API documentation, not a self-hosted acquisition engine.

The proposed division is phrog-web for retrieval, Hermes for personal relevance, scheduling, preference feedback, and delivery. This is a proposal, not a description of a completed integration.

## Clone inventory and review limits

The clones live outside the application checkout, in the sibling directory `../phrog-web-research/social-integrations/`. They are shallow Git clones of the upstream repositories, with no dependency installation or build scripts run.

- `socai`: `socai-io/socai`, commit `778bdd1669a460c9beff80cd9faf8efb1bc5ef23`, 427 tracked files.
- `x-signal`: `anotb/x-signal`, commit `ceb281d2928550bcf1e3ae832d0becac214b0cc3`, 110 tracked files.
- `RSSHub`: `DIYgod/RSSHub`, commit `1f481e461da07398cdbc3961414e397b9eb91948`, 7,179 tracked files.
- `last30days-skill`: `mvanhorn/last30days-skill`, commit `6f9052cca8fcafad9055c438b7b3f9112f2ee20f`, 597 tracked files.
- `social-media-research-skills`: `ScrapeCreators/social-media-research-skills`, commit `64ba7b4dea71e130d2712ffb6c1c1024b3b7c4b2`, 20 tracked files.

Each clone has a sibling `<repo>-inventory.json` containing every tracked path, file size, and SHA-256 for source/configuration/documentation text formats. `inventory-summary.json` records origins, revisions, counts, and top-level module distribution. These inventories fingerprint the snapshots; hashes are not a security audit.

The checked-in license files identify socai as Apache-2.0, X Signal/last30days/ScrapeCreators skills as MIT, and RSSHub as AGPL-3.0. Preserve those upstream licenses when evaluating reuse; RSSHub should not be assumed to share the licensing of the other candidates.

This is a repository-wide architectural exploration with focused reading of acquisition, authentication, interfaces, persistence, and relevant tests. It is not a line-by-line audit of every file. In particular, RSSHub has 1,980 namespace files and 3,571 literal `export const route` declarations across 6,187 route-tree TypeScript files; those are source inventory counts, not tested working endpoints. Website assets, desktop styling, and unrelated route implementations were inventoried but not exhaustively reviewed. No upstream test suite or live authenticated capability was verified.

## Recovered ideas and evidence

### Doomscroll replacement and event discovery

The 2026-10-12 owner intent is recorded in `~/phrogvps/hermes-assistant/INTENT.md`: Hermes should use social media on the owner's behalf, scroll feeds for event discovery, and help with reminders and inbox sorting.

The October 12 pipeline note, `~/brain/wiki/inbox/2026-10-12-capture-sorter-hermes-instagram-pipeline.md`, distinguishes Instagram home-feed acquisition from Explore. It records an OpenCLI feed command preserving image, link, date, and place; image analysis; saved account sessions; and conservative collection frequency. That is historical documentation, not a fresh verification of the running system.

The September-plan reconstruction in `~/projects/hermes-revamp/docs/sept-plan-map-A.md`, rows 25-29, connects the idea to:

- event discovery from Instagram/TikTok/Humanitix using interests and radius;
- reading feeds for the owner;
- Reddit discussion research;
- secondary Marketplace price-anomaly alerts;
- recommendations informed by music, reading, and film taste.

That reconstruction mentions `collect_social.py`, `social_radar.py`, `ig_scroll.py`, Daily discovery, and Social ingest. Its WORKING labels describe the October 23 snapshot and must not be treated as a current end-to-end acceptance test. It also records no TikTok/Humanitix evidence and missing taste-profile input at that time.

### Broader social-media replacement

`~/projects/hermes-revamp/INTENT.md` records the October 23-24 direction: understand the owner's behavior and preferences, navigate as the owner, use Jev and an Android VM where appropriate, and learn repeatable navigation from recordings. The same record separates Pictho and clone/emulation work from the assistant project, while documenting later voice/emulation integration.

This broader idea includes acting as well as reading. The current exploration authorizes neither social posting nor messaging. Existing DMs/communication bridges should be evaluated separately from feed acquisition; none of these five repositories supplies a verified replacement for the existing Instagram/WhatsApp messaging pipeline.

I recovered explicit doomscroll-replacement requirements in the Hermes records. I did not locate a separate project repository or authoritative project card named `Doomscroller`. T3 searches were project-scoped; connected board searches returned no matching record. The Hermes requirement should not silently be relabeled as a separately recovered app.

## 1. Socai

### Structure and execution

The active implementation is Rust: shared `core/`, command/daemon/TUI entry points in `cli/`, a Tauri application in `app/`, a worker and worker protocol, and local ASR/media helpers. The website and marketplace packages are separate surfaces. The shared runtime owns browser lifecycle and dispatch; site adapters register compiled operations, while site manifests supply browser-script contracts and learning resources.

The worker's stdio protocol binds a process to a session and rejects mismatched/busy sessions. Its declared capabilities include browser recovery, evidence records, write grants, login resume, host tools, remote OCR, and persistent conversation. This is a distinct agent-host integration surface, not an existing phrog-web MCP adapter.

Source anchors:

- [CLI construction](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/cli/src/main.rs)
- [Daemon dispatch and command serialization](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/cli/src/daemon.rs)
- [Shared runtime](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/runtime/engine.rs)
- [Native adapter registry](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/sites/registry.rs)

Registered sites include XHS, Douyin, TikTok, Instagram, LinkedIn, X, Weixin, podcasts, GitHub, and general web. Browserless adapters and browser-backed adapters have separate dispatch paths. Core agent code also contains planning/LLM providers, research state, report generation, local memory, and run logging; those overlap Hermes/Feynman and need not become another orchestration layer inside phrog-web.

### What it actually covers

[X operations](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/sites/x/tools.rs) include `home`, with For You and Following tabs, as well as search, profiles, notifications, followers, and post details. The adapter also contains posting/reply/like operations. A retrieval integration would expose a deliberate subset.

[Instagram operations](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/sites/instagram/tools.rs) cover search, account suggestions, profiles, post/reel details, and comments. The [manifest](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/sites/instagram/manifest.json) distinguishes login/hydration states, missing metadata, private profiles, and comment loading. There is no dedicated Instagram home-feed command in the reviewed adapter. Search/profile coverage is not evidence that it can replace the old `ig_scroll.py` home-feed workflow.

[TikTok operations](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/sites/tiktok/tools.rs) expose search, individual video reads, author scans, and page state. The existence of a lower-level `scrollFeed` browser helper does not establish a supported personalized For You feed command.

Media code covers downloading, archive artifacts, OCR, audio/video, and transcription. That is relevant to event posters whose place/date may appear only in an image. Platform parser fixtures and JavaScript tests exist for several adapters; they were inspected as coverage evidence, not executed.

### Authentication and data boundaries

The [browser backend contract](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/docs/browser-backends.md) supports Chrome/Edge over CDP, using a debuggable existing instance or managed profile. Safari and Firefox backends are not implemented. Merely having Safari tabs or an ordinary running Chrome profile does not establish attachment. The document explicitly notes that remote endpoint restrictions are operator-enforced rather than validated by the resolver.

The [telemetry implementation](https://github.com/socai-io/socai/blob/778bdd1669a460c9beff80cd9faf8efb1bc5ef23/core/src/telemetry/mod.rs) includes remote event and trace uploads to socai.io. Telemetry, query text, task text, and chat text gates default to enabled. Opt-out variables include `SOCAI_TELEMETRY`, `SOCAI_TELEMETRY_QUERY_TEXT`, `SOCAI_TELEMETRY_TASK_TEXT`, and `SOCAI_TELEMETRY_CHAT_TEXT`. Any personal-feed pilot should deliberately disable those paths and verify the resulting egress behavior before calling it local-only. An opt-out definition alone is not proof that all entry points honor it.

Recommended integration shape: invoke bounded CLI operations on the machine holding the browser session, preserve structured errors and source links, and map only needed fields into phrog-web. Do not embed its full agent loop or desktop application. Linux source-build and browser attachment remain pilot prerequisites.

## 2. X Signal

### Structure and execution

The TypeScript service uses Express and the MCP SDK. `src/app.ts` hosts HTTP/MCP and session setup; `src/mcp.ts` defines tools; `src/service.ts` coordinates durable jobs; `src/store.ts` uses SQLite; `src/x/browser.ts` owns browser work; `src/x/parser.ts` normalizes captured responses. Compose separates a persistent Chromium/noVNC browser from the service, with an optional tunnel profile.

The runtime requires Node >=24.19.0 in its manifest, beyond phrog-web's documented minimum. Keep it as a separate service if adopted rather than assuming its sources can run inside the existing gateway runtime.

### Fit to the older idea

The [MCP tool surface](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/src/mcp.ts) exposes exact Following, For You, user, bookmarks, list, and community timelines. It also exposes post/thread/reply/quote reads, multi-angle searches, saved-run comparison, evidence paging, cancellation, monitors, and exports.

The [browser implementation](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/src/x/browser.ts) captures the GraphQL responses produced by browser UI operations, including HomeTimeline and HomeLatestTimeline. It checks the expected account, limits concurrency, spaces requests, and reports challenge/authentication/upstream-change states. It is still dependent on X's current UI and response formats.

The [contracts](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/src/contracts.ts) preserve source provenance, nullable metrics, media, reply/repost/quote relationships, and partial-completion information. Monitor definitions support queries, accounts, Following, cadence, filters, retention, and optional sinks. Following monitoring is explicit; arbitrary For You monitoring should not be inferred from the separate timeline reader.

The [SQLite store](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/src/store.ts) and [notification outbox](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/src/monitor-outbox.ts) preserve jobs, baselines, capture cadence, and delivery work. Browser/runtime/collection/outbox tests cover account changes, partial results, request spacing, and restart-related behavior; no test pass is claimed here.

### Authentication and integration

[Compose](https://github.com/anotb/x-signal/blob/ceb281d2928550bcf1e3ae832d0becac214b0cc3/compose.yaml) persists the browser profile and application data in separate volumes and binds published ports to loopback. A Chrome companion can synchronize the selected account session, or the user can sign in through noVNC. Service bearer authentication is configurable; its default is not a ready-made remote authenticated deployment.

Recommended shape: a separately managed provider behind phrog-web's normalized read interface. Hermes would decide which feed and cadence matter. Existing monitor machinery could be reused selectively, avoiding two independent schedulers collecting the same feed. No monitor or notification sink was created during this review.

## 3. RSSHub

### Structure and execution

RSSHub is a Hono application, not the older Koa description in the previous discussion. [Bootstrap](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/app-bootstrap.tsx) composes access control, parameters, cache, rendering, and route registration. Cache adapters support several environments; [cache middleware](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/middleware/cache.ts) coordinates in-progress fetches where the backend supports atomic claims.

It is an on-request feed generator with caching. Feed subscriptions, polling cadence, durable seen-item state, and personal relevance would belong to its consumer or another layer. It does not provide the complete personal assistant.

### Relevant route findings

- [X home](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/routes/twitter/home.ts): an authenticated `/twitter/home` route exists, declaring `TWITTER_AUTH_TOKEN`. Its handler calls `getHomeTimeline`, while its returned title says Following. Treat the exact feed semantics as unverified until tested; do not assume that label proves chronological Following.
- [X backend selection](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/routes/twitter/api/index.ts): selects web/third-party or developer API based on configuration. An absent configuration throws a configuration error.
- [Instagram](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/routes/instagram/index.ts): user posts, stories, highlights, and tags. Cookie is optional for user posts, required for the other categories; private-profile access is checked. No personalized Instagram home feed is exposed by this route. Cookie-jar state is cached, which matters for account isolation and backups.
- [Telegram](https://github.com/DIYgod/RSSHub/blob/1f481e461da07398cdbc3961414e397b9eb91948/lib/routes/telegram/channel.ts): has web and session-backed paths. A Telegram session is not a universal requirement for public-channel collection.
- Facebook and Threads route families contain separate extraction/authentication code. Their existence is a candidate capability, not evidence of current live success.

Recommended shape: self-host a narrowly configured instance and consume selected routes. Normalize feed items into the same evidence model as other providers, retaining route/source, retrieval time, original publication time when available, and canonical link. Do not put RSSHub in every interactive search path or assume RSSHub route counts equal reliable platform coverage.

## 4. Last30days

### Structure and execution

This is more than a prompt skill. It has a Python research engine, many source adapters, a persisted research library, watchlist/briefing commands, extensive tests, and a Go MCP wrapper which extracts the packaged engine and invokes a compatible Python interpreter.

[Pipeline](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/skills/last30days/scripts/lib/pipeline.py) imports independent acquisition modules, applies source/depth budgets, bounds fan-out waits, handles thin-result retries, normalizes evidence, and coordinates clustering/reranking/rendering. [Schema](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/skills/last30days/scripts/lib/schema.py) distinguishes source items, candidates, date confidence, relevance, freshness, and engagement. [Fusion](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/skills/last30days/scripts/lib/fusion.py) canonicalizes URLs, merges duplicate evidence, and uses weighted reciprocal-rank fusion rather than comparing raw likes across platforms.

### What transfers to this project

Useful patterns are provider-aware planning, explicit time windows, provenance, duplicate merging, partial-source reporting, cost accounting, watchlist deltas, and compact briefings. Those would improve phrog-web's current flat, date-sorted social-search response.

It remains primarily topic research and watchlists, not a general personalized home-feed replacement. [Watchlist execution](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/skills/last30days/scripts/watchlist.py) launches bounded child research with a usage journal and explicitly passes `--no-browser-cookies` for unattended use. An interactive browser-cookie setup therefore does not automatically make scheduled collection work.

### Authentication and integration

[Environment policy](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/skills/last30days/scripts/lib/env.py) distinguishes permission to read browser cookies from ordinary configuration. The [Go MCP wrapper](https://github.com/mvanhorn/last30days-skill/blob/6f9052cca8fcafad9055c438b7b3f9112f2ee20f/mcp/internal/tools/research.go) has a separate explicit cookie opt-in and engine-plan policy. Multiple API, binary, browser, and local-service backends are possible; a key-presence probe is not a live authentication test.

Integration choice: either run it as a bounded external research engine or implement selected workflow behavior over phrog-web's providers. Do not copy the whole stack before deciding who owns planning, cache, persistence, budgets, and scheduling; phrog-web/Feynman/Hermes already own parts of each.

## 5. ScrapeCreators social-media-research-skills

The repository contains 13 workflow/routing skill documents and a small frontmatter validator, rather than a server, crawler, session manager, or data store. Its [API routing reference](https://github.com/ScrapeCreators/social-media-research-skills/blob/64ba7b4dea71e130d2712ffb6c1c1024b3b7c4b2/skills/scrapecreators-api/SKILL.md) calls hosted JSON endpoints using an `x-api-key` header and instructs callers to check endpoint OpenAPI documentation.

The [social-listening workflow](https://github.com/ScrapeCreators/social-media-research-skills/blob/64ba7b4dea71e130d2712ffb6c1c1024b3b7c4b2/skills/social-listening-brief/SKILL.md) contributes useful requirements: preserve URLs/dates/quotes, choose relevant communities, explain sampling limitations, and avoid treating engagement as truth. Other documents cover comment mining, transcripts, outliers, competitor/creator research, ads, and trends.

Recommended shape: an optional hosted public-data provider plus workflow references. It cannot read the owner's personalized signed-in home feed merely because an API key exists. No endpoint call, credit spend, or skill installation was performed; repository skill text was treated as material under review, not installed instructions.

## Proposed feature boundaries and next evidence

1. **Separate feed reads from topic search.** A future feed operation should preserve platform, source surface (Following/For You/profile/list/channel), account scope, cursor, completeness, and collection time. Current `SocialPost`/`SocialResponse` in `src/providers/social.ts` lacks much of this information.
2. **Recover the Instagram home-feed path before replacing it.** Review the existing Hermes/OpenCLI scripts and test the actual account's home feed in a separately authorized pilot. None of the reviewed Instagram interfaces establishes a drop-in replacement.
3. **Pilot one X provider.** Compare X Signal and socai on an exact requested timeline with a bounded sample. Check identity, persistence across restart, partial results, and expired-session reporting. X Signal is the stronger first candidate for durable feed research; socai is broader.
4. **Use RSSHub for named sources.** Start with routes tied to actual accounts/channels/interests. Verify each route's current behavior and authentication rather than testing arbitrary route counts.
5. **Add relevance and outcome feedback in Hermes.** Extract candidate events with original links and explicit date/place uncertainty; compare against interests, radius, schedule, duplicates, and expired events. Record accepted/dismissed choices so relevance can improve. Do not infer personal taste from popularity alone.
6. **Keep retrieval, actions, and credentials distinct.** Hermes can own vault interaction and consent; provider workers must still own browser/session state. A vault alone does not create a working session. Social writes and messaging require their own concrete task scope.
7. **Deliver a bounded selection.** A daily or requested brief should explain why each item is relevant and whether it came from a personal feed, followed source, or keyword search. The acceptance test is useful discovery without the owner opening an endless feed.

No implementation is implied by this list. The next implementation decision should follow the feed/session pilot, especially the missing Instagram home-feed evidence.

## Verification

The application remained unchanged apart from this report. `npx tsc` exited 0; local `/health` returned `status: ok`; `git diff --check` passed. All 30 pinned upstream source links were checked against existing files at the exact cloned commits. All five clones were clean, and their inventory counts were checked for consistency. Upstream authenticated operation, upstream builds, and full upstream suites were not run because this pass was static exploration and did not install dependencies or access accounts.
