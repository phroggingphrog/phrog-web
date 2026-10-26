# Phrog Web personal discovery and personalization: execution plan

Status: proposed implementation plan following the owner's accepted schema direction.
Date: 2026-10-26.
Scope of this change: document the whole execution plan. No migrations, imports, login configuration, collection workers, account connections, or live Hermes changes are executed by writing this plan.

## 1. Accepted product and ownership

Phrog-web becomes a user-owned, provider-independent search, discovery, and recommendation service. It centralizes eligible history, interactions, preferences, behavior-derived evidence, recommendation rules, and discovery history. TikTok, Instagram, YouTube, Spotify, Apple Music, Google exports, RSS, and websites are inputs, not owners of the resulting profile.

Three distinct experiences:

- Enquiry: answer a specific question. Anonymous operation remains supported.
- Research: investigate a topic and retain evidence. Anonymous operation remains supported where its providers permit it.
- Personal discovery: recommend material, sources, media, places, products, and events using a signed-in user's profile and explicit settings.

A phrog-web login enables a persistent profile. External account connections are optional. Manual preferences and historical imports can personalize discovery without a live social account. An external account may be connected for retrieval while excluded from preference learning.

Phrog-web owns acquisition, import/collection, normalized evidence, entity resolution, enrichment, preference learning, ranking, seen-item history, collection schedules, and discovery jobs. Hermes owns conversational interpretation, temporary personal context, presentation, and separately authorized assistant actions. Other authorized clients use the same personalization state. Hermes does not install all seven shortlisted repositories or maintain a competing taste database.

Enquiry and research do not train the personal profile by default. A user can deliberately save a result or opt a scoped activity into learning. API callers cannot silently override a user's disabled learning policy.

Optimize for discoveries the user values: useful or enjoyable material, relevant events, diversity, freshness, and reduced unwanted repetition. Watch time, clicks, and time in the app are observations rather than the product's primary success objective.

## 2. Existing evidence and baseline

Read before implementing:

- [Seven-repository source review](../research/social-integrations-2026-10-26.md): pinned snapshots, auth boundaries, exact feed capabilities, and limitations.
- Existing self-data wiki note: `~/brain/wiki/inbox/2026-10-04-capture-sorter-self-data-architecture.md`. Preserve raw exports, normalized domain databases, units, timestamps, and source references.
- Existing personal-knowledge specification: `~/phrogvps/openspec/changes/personal-knowledge-reconcile/specs/personal-knowledge/spec.md`. Preserve observation/inference distinctions, corrections, purpose boundaries, and lineage.
- Schema snapshots under `~/phrogvps/data/schemas/`: music, social, activity, media, Google Takeout, and behavior-model analysis.
- Historical `ig_scroll.py`: actual Instagram home-feed acquisition, image/caption analysis, taste input, events archive, and bounded digest. Its local source snapshot is not a current runtime test.

Current application seams: Fastify REST in `src/index.ts`, MCP tools in `src/adapters/mcp/server.ts`, Hermes schemas in `src/adapters/schemas/`, CLI in `src/cli.ts`, setup in `src/setup.ts`, configuration in `src/config.ts`, social providers in `src/providers/social.ts`, and existing retrieval/research/media/wiki tools. `src/wiki/db.ts` already uses Node SQLite. Personalization gets a separate store; do not repurpose the wiki index.

The current MCP handler constructs a stateless server per HTTP request. Personal-tool handlers therefore need an authenticated request context passed to the server factory. Client-supplied profile IDs alone are not authentication. Current request logging captures summarized API arguments; personal routes need a stricter logging policy before activation.

Schema snapshots prove fields and table definitions, not record coverage, data quality, or current source availability. Phase 0 establishes those facts.

## 3. Storage, identity, and privacy decisions

Initial implementation: a separate SQLite database, owned by phrog-web, using the existing Node runtime. One managed worker owns writes in the initial deployment; collection and external/model work happen outside short database transactions. Use foreign keys, versioned migrations, bounded transactions, appropriate indexes, and a proven consistent backup/restore path. Measure concurrency before introducing additional writer processes or another database system.

Configure the database, raw-artifact directory, source snapshot locations, collector binaries, service URLs, and credential/session references. Never embed host-specific paths or secrets in source. Existing canonical personal databases are read-only sources. Their serving mirrors are not additional evidence. Import metadata refers to the selected authority and generation.

Use opaque stable internal IDs. Preserve provider IDs separately. All personal rows have a direct owner/profile reference or an enforceable composite reference to an owned parent. Indexes and foreign keys must prevent a row belonging to user A from referencing user B's account, candidate, feedback, or evidence. Apply the same checks to background workers, exports, MCP, REST, CLI, and administration routes.

Public content metadata may be reused across users only when independently public. Private/account-visible content, identifiers, annotations, and personal relationships remain owner-scoped. Content visibility and account scope must be represented explicitly; deduplication is not permission to expose a private item or its existence to another user.

Keep platform credentials in the credential/session store; the personalization database holds references and status. Distinguish service login, client grants, and upstream login. A connected provider does not grant unrelated clients access to its session. Browser workers control their own sessions, bound to the selected account. No browser-control endpoint becomes a general client tool.

Retain source times, UTC times, local timezone/era, timestamp precision, and whether a time or duration is measured or inferred. Aggregate snapshots remain snapshots; never manufacture individual plays from daily totals or assign a save date when only current membership is known.

## 4. Logical schema and invariants

This catalog carries forward the accepted proposal. Phase 1 converts it into reviewed SQL migrations with exact types, nullability, indexes, ownership constraints, and checks. JSON is reserved for bounded provider/context payloads and versioned score details; identity, ownership, eligibility, status, times, and common joins are typed columns.

### Ownership and connections

- `users`: internal user identity and lifecycle state; external verified login identity is mapped through the auth adapter.
- `profiles`: user, name, timezone, locale, personalization/learning state, configuration revision, created/updated times. Start with one personal profile per user; support additional isolated profiles without requiring them in the first flow.
- `source_accounts`: user, provider, stable provider account identity, display label, credential reference, connection status, last verified time.
- `profile_sources`: profile/account pair, collection state, learning policy, permitted data categories. Both sides must belong to the same user.

### Collection and original observations

- `collection_jobs`: source account, collector/version family, category, schedule, enabled state, checkpoint, next run, lease owner/expiry, and retry state.
- `collection_runs`: job, attempt identity, start/end, status, collector version, received/added/updated counts, error code, retry time, checkpoint committed.
- `source_records`: owner/account, source namespace, native ID or stable locator, revision/content hash, immutable payload reference, collection run, observed/imported times, parser version. Preserve revisions rather than overwriting original evidence.
- `source_coverage`: owner/account, category, source/run generation, requested and actual period, completeness, missing-field/availability limitations, and as-of time.

### Entities and content

- `entities`: entity type, canonical label, visibility/owner scope, lifecycle status. Types include posts, videos, tracks, albums, artists, creators, channels, communities, venues, places, events, and topics.
- `entity_identifiers`: entity, provider/namespace, identifier type/value, identifier scope; unique within the provider and appropriate visibility/account scope.
- `entity_relations`: subject, typed relationship, object, evidence reference, confidence, resolution method/version. Constrain valid type pairs. Uncertain matches remain candidates; support reversible merge/split mappings.
- `content_items`: entity, creator, title, description, canonical URL, publication time/precision, language, known duration, availability, and current metadata revision. Evidence retains prior claims.
- `content_annotations`: entity, annotation type/value, evidence locator, confidence/status, extractor/model/prompt versions, created time, and visibility. Include extraction failures and conflicts rather than inventing answers.
- `event_details`: entity, venue, start/end, timezone, precision, price/currency, booking URL, status, verification time, and evidence references. Post publication time and event time are different fields.

### Behavior and current state

- `interactions`: profile/account/source record, target entity or search context, action, occurrence time/precision, session, `purpose`, `learning_eligibility`, `learning_eligibility_reason`, known duration/completion, playback intent, context, and source-aware occurrence identity.
- `user_entity_state`: profile/entity/account, relation, current state, first/last observation, effective time when known, snapshot/run identity, and evidence. Supports follows, library membership, saves, and watchlist-related states without fabricating historical actions.
- `preference_rules`: profile, subject/context, rule type/value, priority, validity period, explicit origin, revision, and supersession. Support exclusions, discovery radius/budget, diversity, source learning controls, and temporary constraints.
- `feedback`: profile/entity, optional owned impression, feedback type/reason, scope, supplied time, and idempotency key. A direct preference can exist without an impression.

### Derived preference state

- `inference_runs`: profile, source-generation manifest/input cutoff, feature/algorithm versions, configuration, start/end, status, and coverage summary.
- `preference_estimates`: profile/subject/dimension/context, long-term/recent/contextual scope, value, calibrated confidence or explicitly uncalibrated status, counts/distinct active days, first/last observation, inference run, and current/superseded status.
- `preference_evidence`: estimate, typed interaction/feedback/rule/annotation evidence reference, support/contradiction role, contribution, and derivation version. Enforce resolvable references and ownership; use typed association tables if needed rather than unverifiable JSON ID lists.
- `preference_snapshots`: profile, immutable feature/estimate/rule revision manifest, cutoff, configuration, generation time, artifact reference. Published snapshots are atomic and distinguish current from superseded state.

### Discovery and feedback loop

- `discovery_requests`: profile, authorized client, intent, temporary constraints, purpose/learning policy, preference snapshot, retrieval/ranking versions, request time, status, and idempotency key.
- `recommendation_candidates`: request/entity, source legs and retrieval times, eligibility/rejection reasons, score components, final ordering, explanations/evidence, and selected position. Preserve enough bounded candidate evidence to reproduce decisions under the retention policy.
- `impressions`: candidate, client/surface, delivery identity, displayed time/position, and idempotency key. API return, notification delivery, actual display, and opened content are distinct events. Unknown visibility stays unknown.
- `watchlists`: profile, name, source/topic/event/entity or query scope, filters, cadence, delivery preference, baseline, and enabled/paused state.
- `watchlist_sources`: watchlist, explicit account/channel/feed/query bindings and cursor/state. Collection jobs remain the acquisition scheduler; watchlists do not create a second independent collector for identical work.
- `data_control_requests`: profile, operation/scope, requested/completed times, progress/status, failure/retry state, and lineage invalidation manifest.

Supporting storage: `schema_migrations` for schema versions and `audit_events` for scoped administrative/permission changes without copying private payloads. Persistent snapshots/annotations provide feature reproducibility; add a separate feature-value cache only if measured compute costs require it. Credential and login-token storage stays in the chosen authentication component.

### Required key behavior

- Deduplicate archive occurrences across overlapping imports; preserve genuine repeated plays/watches. Payload equality or equal timestamps alone do not prove one occurrence. Ambiguous matches retain evidence and are excluded from double-counted training until resolved.
- A single source record can support several derived records. Maintain mappings for reprocessing and removal.
- A public entity can have many source announcements and many users' separate interactions. Do not collapse user actions into public engagement counts.
- Membership removal requires a complete comparable snapshot or an explicit removal event. Missing/partial collection must not unfollow or unsave everything.
- Unique idempotency keys are scoped by owner/client/operation. Candidate/feedback/impression references cannot cross users.
- Keep event cancellation and unavailable content as states with evidence, not unexplained disappearance.

## 5. Proposed implementation layout

Use focused modules, following existing TypeScript/ESM conventions:

- `src/personalization/db/`: migrations, connections, scoped repositories, consistent backup support.
- `src/personalization/auth/`: verified principal, client grants, profile access, protected-route hooks.
- `src/personalization/imports/`: read-only domain adapters, source manifests, normalization, reconciliation.
- `src/personalization/collection/`: durable jobs/leases, checkpoints, retries, capability contracts, workers.
- `src/personalization/entities/`: identifiers, canonicalization, merge/split evidence.
- `src/personalization/enrichment/`: metadata, OCR/transcripts, topic/entity/event annotations and budgets.
- `src/personalization/preferences/`: explicit rules, signal interpretation, feature generation, inference, snapshots.
- `src/personalization/discovery/`: retrieval planning, candidate assembly, filtering, ranking, exposure and watchlists.
- `src/personalization/controls/`: pause, corrections, export, deletion and recomputation.
- `src/personalization/routes.ts`: scoped REST registration, leaving existing provider routes usable.
- `tests/personalization/`: synthetic fixtures and meaningful integration/contract tests. Use an existing suitable test mechanism or Node's built-in runner; adding a test dependency requires normal vetting.

Pass a `PrincipalContext` into every personal operation. Anonymous tools use an explicit anonymous context. Avoid a mutable global current-user/profile variable. Provider workers receive bounded scoped tasks, not arbitrary shell commands or full user databases.

## 6. Execution phases

### Phase 0 — inventory, authority, and measurable baseline

Deliver a schema/coverage report, source manifest, field mapping, and initial evaluation definition before importing personal records.

1. Identify actual canonical domain databases, serving mirrors, export archives, source generations, and existing import scripts using read-only inspection. Resolve canonical ownership with existing data design.
2. Inspect action enums, account separation, date ranges, timezone rules, null rates, content/URL coverage, skip/completion derivations, overlap counts, and source hashes. Do not export personal rows into committed reports.
3. Inspect behavior-model topic classification, music capped-duration/skip rules, and old Instagram feed code. Determine which are raw observations, derived labels, aggregates, or snapshots.
4. Define first product slice: signed-in local profile, imported music/social/activity evidence, explicit interests, one reliable public feed, bounded discovery, and feedback. Preserve the Instagram home-feed gap as its own pilot.
5. Establish synthetic and private held-out evaluation fixtures, source availability labels, relevance/novelty/repetition measures, and latency/cost/item limits. Record numeric budgets before pilot evaluation; do not choose success thresholds after seeing outcomes.

Exit: every intended input is canonical, duplicate/mirrored, unavailable, or deferred; field/time/coverage uncertainties are listed; no personal-data writes occurred.

### Phase 1 — database contract and migrations

1. Turn section 4 into SQL with explicit types, checks, uniqueness, foreign keys, ownership references, visibility, indexes, and migration order. UTC timestamps use one representation with explicit precision; monetary amounts use exact representation and currency.
2. Add configuration, migration runner, database lifecycle, short transactions, atomic preference publication, and schema-version checks. Store migration checksums and back up before upgrades.
3. Define consistent DB/artifact backups and source-generation references. A backup must include a manifest of required external artifacts, not just a SQLite filename.
4. Create synthetic two-user/multi-account fixtures, overlapping exports, repeated true events, partial snapshots, uncertain identity matches, and out-of-order feedback.

Exit: empty-database creation and upgrade from the prior fixture pass; invalid cross-owner references fail; crash during migration cannot leave a falsely current schema; consistent restore passes integrity and owned-record retrieval checks.

### Phase 2 — optional login and scoped client access

1. Inspect the deployed access layer. Implement an auth adapter for verified external identity with a configured issuer/audience/trust boundary. Never trust arbitrary identity headers; strip untrusted headers at the boundary. Use an established identity mechanism rather than creating a password system.
2. Provide local owner onboarding and an owner-scoped client credential for headless clients. The unattended credential proves identity and scopes; a profile ID is only a selector. Public deployments keep signup/invites disabled until intended onboarding is configured.
3. Pass request principals through REST/MCP; bind stdio clients to an explicitly configured scoped principal. Restrict profile choice to grants. Separate read, discover, feedback, source administration, export and deletion scopes.
4. Protect personal routes and artifacts, use credential-safe CORS/origin/CSRF handling for browser sessions, and replace personal-route logging with an allowlist of IDs/status/durations/counts. Error messages do not echo credentials or private payloads.
5. Allow anonymous enquiry/research; return actionable authentication-required errors for personal discovery. Personalization disabled means no implicit profile lookup or inference.

Exit: anonymous public tools still work; unauthenticated personal requests fail; user A cannot address user B through any object, cursor, artifact or tool; revocation works for REST, HTTP MCP and stdio grants.

### Phase 3 — historical import and reconciliation

1. Implement read-only adapters for normalized music, social, activity, media, and Takeout staging data. Import observations and snapshot membership, preserving raw/derived fields and source references.
2. Import music identities/plays, Apple favorites, Spotify library/playlists; social platform actions/follows; activity/search/YouTube records; saved places and relevant media annotations. Keep private messages and unrelated clinical/financial content outside discovery imports by default.
3. Preserve per-account provenance, aggregate granularity, original timestamp precision, and coverage. Unknown historical purpose is declared. Set learning eligibility by the chosen profile/source/category policy rather than silently treating every imported action as positive.
4. Reconcile overlapping exports and normalized mirrors using versioned occurrence mappings. Retain uncertainty. Record row disposition counts and parse failures. Reprocessing creates new derivation versions without multiplying true events.
5. Produce a private reconciliation report with totals, source boundaries, oldest/newest observations, missing metadata, ambiguous duplicates and rejected rows. Commit only code and synthetic fixtures.

Exit: importing the same snapshot twice adds zero duplicate logical observations; replay from preserved inputs yields the same logical mapping; genuine repeated plays survive; raw evidence is unchanged; incomplete snapshots cannot erase current memberships.

### Phase 4 — explicit preferences, feedback and data controls

1. Implement configure/read/update preference rules, scoped feedback, source learning switches, profile pause, and temporary request constraints. Return evidence and override precedence in human-readable form.
2. Enforce precedence: applicable explicit exclusion/override, valid temporary constraints, eligible derived preferences, fallback discovery. Do not mistake date unavailability for a lasting taste rejection.
3. Add durable control jobs for source exclusion, profile export/reset, selected-history deletion, credential disconnection, and recomputation. Clarify separately: disconnect collection, exclude from learning, delete active copies, and preserve/delete original user archives.
4. Maintain dependency invalidation for annotations, estimates, snapshots, recommendations and caches. Handle deletion during in-flight collection/inference so excluded data cannot be republished after the request completes.

Exit: direct correction is effective on the next discovery; disabled learning is honored across all clients; replay cannot resurrect deleted/excluded observations; exported profile data remains scoped; active artifacts and backup-retention behavior are documented.

### Phase 5 — entity resolution and bounded enrichment

1. Resolve stable provider IDs first; use normalized URLs and documented identifiers next. Treat name/slug matches as candidates. Implement reversible merges with dependent-record reconciliation.
2. Enrich selected eligible content with metadata, available captions/transcripts, OCR, language/topics, creators, places and events. Reuse existing retrieval/extract/transcript capabilities where their contracts fit; shopping-specific visual identification is not an event-poster extractor.
3. Represent unavailable, private, deleted, partial, conflicting, and failed content. Annotate observed facts separately from inferred classifications; attach model/prompt/parser versions and evidence locators.
4. Limit external calls, bytes, media duration, concurrency, retries and per-profile spend. Record the actual provider used. Treat fetched text/media as evidence rather than instructions; classifiers have no account-write or general shell capability.

Exit: enrichment preserves provenance and units; identity merges are reversible; missing metadata is not fabricated; event date differs from publication date; repeated identical enrichment reuses a compatible version; no source exceeds its configured budget.

### Phase 6 — preference distillation, first algorithm

1. Implement deterministic feature computation first: eligible counts, distinct days, recency, deliberate vs passive actions, repeats, skips and explicit positive/negative evidence. Normalize per source; a prolific platform must not dominate solely by volume.
2. Separate established, recent and contextual estimates. Count independent observations and show coverage/confidence limits. Old research bursts and single-session loops receive different treatment from repeated deliberate choices.
3. Use language models for bounded content interpretation and evidence-grounded summaries. Do not infer identity, diagnosis, feelings, or willingness to pay from a topic label or listen count. Respect source-provided recommendation exclusions where interpretable.
4. Publish immutable profile snapshots atomically with input manifests, code/config/model versions and explicit-rule revisions. New evidence invalidates affected features; first implementation may recompute scoped batches before incremental optimization.
5. Expose inspect/correct explanations: what evidence supports a preference, what contradicts it, and what was excluded. Mark confidence uncalibrated until tested.

Exit: fixed inputs produce reproducible deterministic features; explicit overrides win; unknown watch duration remains unknown; incomplete source periods do not imply lost interest; deleting an observation invalidates its derived contribution; recent and established profiles differ meaningfully on fixtures.

### Phase 7 — personal discovery, ranking and impressions

1. Build a distinct discovery request contract with intent, constraints, result bound, allowed sources, chosen profile, and optional time/location context. Resolve identity from the principal rather than request text.
2. Retrieve and canonicalize candidates across existing search, social, places, media and selected collection outputs. Apply eligibility and practical constraints before ranking. Record filtered reasons and partial-source failures.
3. Start with explainable ranking: eligible preference match, freshness, novelty, practical suitability and deliberate diversity; bounded popularity may help but is not truth or personal affinity. Keep repeat suppression and user exploration settings explicit.
4. Store the request's preference snapshot, ranking/config versions, candidate evidence and selected order. Produce short evidence-grounded reasons, source URLs and uncertainty. Do not require Hermes to inspect hundreds of raw posts.
5. Accept idempotent client-reported display events, opens/saves and reasoned feedback. Returning results is not display. A client unable to confirm visibility records delivery/unknown visibility instead.

Exit: a signed-in user gets a bounded personalized selection; a different user gets their own result; generic research does not train the profile; duplicate deliveries do not inflate feedback; unseen items are not treated as disliked; recommendation decisions can be explained from the recorded snapshot and evidence.

### Phase 8 — automatic collection and watchlists

1. Implement one durable acquisition scheduler with leased jobs, checkpoints, bounded retries, rate-limit/backoff handling, cancellation, restart recovery and per-source budgets. Shared public collection may be reused; personal account collection stays scoped.
2. Define provider capabilities separately: topic search, exact home/Following/For You feed, profile/account posts, comments, media, history, memberships, and incremental collection. Unsupported is an explicit state, not an empty successful result.
3. Normalize outcomes: success, partial, authentication-required, challenge, rate-limited, unavailable, unsupported, cancelled and failed; report coverage and next useful retry. Never silently substitute keyword search for a requested personal feed.
4. Check account identity before accepting personal results. Use stable provider cursors and overlapping windows where appropriate. Commit source records, derived occurrence mappings and checkpoint advancement consistently so crashes do not skip data.
5. Watchlists use collection state and their own seen baselines. They can target accounts/channels/topics/venues/event series and produce bounded deltas. Delivery is a client concern initially; do not enable another upstream notification sink for the same collection.
6. Sources lacking incremental access retain periodic export/import support with a stale-history indicator. Visible login/challenge resolution remains a user step; expired access is not hidden behind endless retries.

Exit: restart preserves jobs and checkpoints; duplicate leases do not duplicate logical observations; transient failures recover within budgets; blocked auth pauses correctly; one broken source does not starve others; watchlists report only meaningful unseen changes.

### Phase 9 — provider pilots and selection

Treat all seven shortlisted repositories as candidates. Do not deploy all by default. Retain reviewed revisions in manifests; re-check upstream identity, release/runtime requirements, transitive installation scripts, contracts, and license files before actual installation. Embedded source stays physically under `engines/`; research clones outside the repo are not runtime dependencies or host symlink targets.

Pilot order:

1. Public RSS/web sources: selected RSSHub routes and direct feeds with actual source demand. Test caching, pagination/coverage, changed entries and unavailable sources; one route passing does not certify all RSSHub routes.
2. X: compare X Signal, socai and social-media-research-cli on a small fixed task and exact requested feed. X Signal is the first durable research candidate; socai offers wider operations; the CLI offers protocol/session acquisition. Select one default per capability and keep alternatives disabled unless they solve a measured gap.
3. Instagram home feed: inspect the existing OpenCLI/Hermes source/runtime and verify its actual home-feed behavior on a bounded authorized account sample. Socai and social-media-research-cli's Instagram search/profile surfaces are not established home-feed replacements. Keep the existing workflow until a replacement passes its own test.
4. Broader platform reads: evaluate socai and social-media-research-cli per platform. Verify posts/comments/profile and source identity individually. For socai, explicitly configure telemetry/text/trace controls and check egress before processing personal samples.
5. Media: compare cobalt with existing download/media paths on one video, a multi-image post, audio-only output, unsupported source, and expired tunnel. Handle redirect/tunnel/picker/local-processing/error. Original source URLs remain provenance; temporary media links are not permanent evidence.
6. Research workflow: evaluate last30days either as one bounded external engine or as selected workflow patterns over phrog-web providers. Choose one owner for planning, persistence, budgets and scheduling; prevent duplicate research jobs.
7. Optional hosted coverage: ScrapeCreators requires a configured key and current endpoint contracts. Its skills are workflow references, not an installed local acquisition service. Use only if it adds useful public-data coverage within budget.

Exit per provider: documented capability matrix, runtime/source identity proof, bounded live sample, failure/reauthentication behavior, measured resource/cost profile, license/runtime disposition, and an explicit selected/deferred verdict. Synthetic tests alone do not certify live auth or site compatibility. No pilot posts, follows, sends messages or books anything.

### Phase 10 — event and cultural discovery

1. Assemble candidates from relevant feeds, venue/organizer accounts, event/ticketing websites, selected communities, music taste, and saved places. Include Humanitix/other event sources only through individually verified extraction paths.
2. Extract poster/caption/video evidence for event name, date/time, venue, ticket link, price and status. Reconcile multiple announcements and editions without merging recurring events into one occurrence.
3. Apply timezone, distance, date, price, availability and explicit request constraints. Calendar context comes from a scoped Hermes/client input or separately authorized adapter; collection is not blanket calendar access.
4. Recheck consequential details before presenting time-sensitive recommendations. Unknown availability stays unknown. Preserve cancellations/changes, saved-event follow-up and source evidence.
5. Extend the same engine to worthwhile posts, creators/communities, films/books/music, venues, shopping/secondhand/deals and novelty discovery. Do not make all interests productivity-oriented. Link cross-domain entities only when supported.

Exit: original home-feed/event use case produces a bounded source-linked selection; date/place uncertainty is visible; expired/cancelled items are filtered appropriately; shared announcements deduplicate; saved-event changes are detectable; no booking or invitation is sent.

### Phase 11 — client interfaces and Hermes integration

1. Add the personal REST/MCP/CLI contracts in section 7 and parity tests. Keep upstream tool catalogs behind phrog-web. Update Hermes function schemas and the use-phrog-web guidance only after the implemented surface exists.
2. Hermes selects enquiry, research or discovery; supplies temporary context; presents bounded findings; forwards explicit feedback and display acknowledgments when observable. It does not create a second personal-history store.
3. Add an initial setup/CLI flow for profile status, verified login/client grant, manual preferences, optional imports, source connections, learning controls, and reauthentication status. A graphical settings experience can follow; it is not a blocker for the first headless vertical slice.
4. Verify a second authorized client uses the same profile, rules and history. Client grants remain independently revocable. Background discovery preferences and delivery channels are explicit, not inferred from a request to search once.
5. Keep social messaging/relationship upkeep and account writes separate. Discovery can propose an event or sharing opportunity; it does not imply consent to contact someone or commit attendance.

Exit: real Hermes discovery uses phrog-web; a second client sees the same corrected preference; enquiry remains independent; feedback is traceable; revoked clients fail; no upstream repositories are installed into Hermes by this feature.

### Phase 12 — evaluation, staged rollout and operations

1. Run import reconciliation, ownership/privacy, learning-purpose, replay, correction/deletion, worker crash, provider failure and recommendation tests at the release boundary. Use real account canaries only where required and bounded.
2. Evaluate chronological held-out feedback against followed-source, recent-favorite and topic-match baselines. Do not label unobserved content as disliked. Track relevance/usefulness, novelty/diversity, repeat rate, source coverage, expired-event rate, latency and cost; explicitly report small samples and unavailable outcomes.
3. Start with a synthetic profile, then the owner's imported profile in preview mode, then one chosen live source, then personal discovery enabled. Expand sources only after their phase-9 acceptance. Keep existing provider services and legacy feed workflow available until the replacement is proven.
4. Before a gateway restart, inspect active research/collection jobs and client turns; finish/drain or preserve durable checkpoints. Current unrelated in-memory jobs must not be discarded casually. Back up database/artifacts/config consistently, record migration/adapter versions, and verify restore before activation.
5. Monitor backlog age, source freshness, auth-required state, retries, partial coverage, inference snapshot age, extraction failures, latency/cost and recommendation repetition. Health distinguishes gateway availability, personal store readiness, worker readiness and stale/blocked sources.
6. Rollback disables new collectors and inference publishers, drains/leaves leases recoverable, backs up post-cutover state and input journals, and restores the prior compatible application/configuration. Do not drop newer records or downgrade a schema blindly; replay preserved input after repair. Restore legacy discovery routing where needed.

Exit: documented acceptance results with unresolved failures, successful recovery rehearsal, no unintended regression of anonymous tools, a clean committed implementation, and a clearly identified deployed revision/configuration. Documentation alone never marks a phase implemented or live.

## 7. Proposed external contracts

Names below are the implementation target, not tools/endpoints available today. Resolve principal server-side and validate ownership on every identifier and cursor. Use versioned request/response schemas and a shared service layer across transports.

REST under `/api/personal/`:

- `GET /status`: authenticated profile, settings, source capabilities/freshness, job summaries; no secret values.
- `GET /profile`, `PATCH /profile`: own profile and explicit preferences with revision checking.
- `GET /sources`, `POST /sources/connect`, `PATCH /sources/:id`, `POST /sources/:id/disconnect`: connection references, per-category collection/learning, account verification and pause. Credential entry happens privately through the selected setup mechanism.
- `POST /imports`, `GET /imports/:id`: validated configured snapshot/import reference, dry-run preview, scoped execution and reconciliation; not unrestricted server filesystem paths.
- `POST /discover`, `GET /discover/:id`: bounded synchronous response or durable asynchronous job with progress, partial results and `poll_after_s`.
- `POST /impressions`: idempotent displayed/delivered/unknown-visibility acknowledgment from an authorized client.
- `POST /feedback`: item/impression, feedback type, reason, scope, optional explicit learning choice.
- `GET /preferences`, `GET /preferences/:id/evidence`: explainable current estimates, explicit rules, source coverage and corrections.
- `GET/POST /watchlists`, `PATCH /watchlists/:id`, `DELETE /watchlists/:id`: inspect/configure/pause/remove scoped watchlists.
- `POST /controls`, `GET /controls/:id`: pause learning, exclude, export, delete or reset via durable scoped jobs and confirmation of exact requested scope where destructive.

Small MCP surface: `personal_status`, `personal_discover`, `personal_discovery_status`, `personal_feedback`, `personal_preferences` and `personal_watchlists`. Record display acknowledgments through the transport/client integration rather than pretending the model knows whether the owner saw a response. Put source/account administration, import execution, exports and deletion in explicit setup/admin contracts; do not load every administrative tool into every Hermes turn.

CLI groups mirror the service: `personal status`, `profile`, `sources`, `import`, `discover`, `feedback`, `preferences`, `watchlists`, and `controls`. Preserve the existing file-oriented CLI behavior for large evidence. Browser/device login completion and secret entry are private setup steps; no passwords or cookies in chat, command output, issue bodies or Git.

Discovery response includes request ID, intent, selected items with canonical/source links, reasons and uncertainty, preference/ranker revision, coverage/failed sources, freshness, and continuation/status information. Return an explicit need-for-context or partial result when constraints cannot be checked. Do not silently widen geography, date, budget or requested source surface.

## 8. Dependencies and first implementation sequence

Phase dependency order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 8 follows the authenticated ingestion/evidence foundation and its controls; phase 9 pilots extend the relevant collector/enrichment contracts. Phase 10 combines discovery with accepted event/feed sources. Phase 11 exposes each completed vertical slice to clients. Phase 12 applies at every release and completes the rollout.

First usable vertical slice: phases 0-4, one small historical import, bounded existing public retrieval, deterministic initial preferences, discovery/impressions/feedback, and one authenticated client. Do not wait for all providers, a graphical dashboard, or a trained neural ranker. Then enable one reliable incremental source and prove restart/duplicate handling before broader social collection.

Candidate commit boundaries: data contracts/migrations; auth/principals; import reconciliation; rules/controls; identity/enrichment; preference snapshots; discovery/exposures; durable collection/watchlists; each selected provider adapter; event discovery; client parity; operations/evaluation. Every commit remains scoped and reviewable. No publishing or PR creation is part of this planning request.

## 9. Required verification and completion record

For each implementation phase, record source commit, config/migration versions, tests run, exact scope, outcome, unresolved limitations, and deployed-vs-local state. Use synthetic fixtures in Git; keep private samples/reconciliation reports in configured private storage.

Always run the repository-required `npx tsc`, local `GET /health`, and `git diff --check` before claiming the corresponding change complete, and commit cleanly with a conventional message. Health alone does not verify personalization. Add the focused behavior tests named by each phase, with a full release-boundary pass for identity, account isolation, event occurrence mapping, learning eligibility, replay, correction/deletion, restart recovery, provider contracts, feedback and recommendation usefulness.

Must-have acceptance scenarios:

1. Anonymous enquiry/research succeeds without creating a preference history.
2. Personalization works from manual rules/imports without a connected social account.
3. A source can be collected but excluded from learning.
4. A saved discovery trains only the intended profile; a research query does not.
5. Duplicate imports do not multiply evidence; repeated real plays remain separate.
6. Unknown duration, missing source periods and uncertain dates stay unknown.
7. A partial snapshot never clears all follows or saved items.
8. Explicit correction affects the next result and survives recomputation.
9. Deletion/exclusion cannot be undone by a late worker or replay.
10. Cross-user references, artifacts, cursors, private annotations and source accounts remain inaccessible.
11. A provider session changes account or expires: results are rejected/paused with an actionable state.
12. A worker crashes after retrieval: restart resumes without losing or double-counting observations.
13. Returned-but-undisplayed content is not counted as seen or disliked.
14. Event suggestions have supported time/place/status evidence and meaningful duplicate suppression.
15. Two authorized clients share one profile and revoking either client works independently.
16. Backup/restore and rollback preserve post-cutover evidence and configuration lineage.

## 10. Deferred choices and non-goals

Resolve against phase-0 evidence: production identity adapter/trust boundary, actual canonical source generations, worker placement, available account sessions, first live source, provider installation/runtime/license fit, evaluation thresholds, external-processing policies and budgets, and personal-data retention settings. These do not block writing this plan; they must be concrete before the dependent activation.

Not required for the first release: copying a provider's proprietary recommender, training a large model, a generic behavior/personality emulator, automatic social posting/messaging/following, bookings/payments, importing every private data category, a full social-network frontend, deploying every shortlisted repo, or moving the entire existing personal archive into phrog-web. Personalized recommendations and preference learning remain the owned product scope.

Current execution status: planning document only. Phases 0-12 above are unexecuted under this plan.
