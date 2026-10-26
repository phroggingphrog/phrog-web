# Personal discovery implementation handoff

Prepared: 2026-10-26.
Project: phrog-web.
State: research, architecture discussion, execution plan and handoff documentation completed; implementation has not started.

## Read first

1. Project `AGENTS.md` and any more specific guidance applying to your changes.
2. [Full execution plan](personal-discovery-execution-plan.md), the implementation specification and acceptance criteria.
3. [Seven-repository source review](../research/social-integrations-2026-10-26.md), including the later ownership correction at its top.

The execution plan supersedes earlier conversational suggestions that Hermes should own the persistent preference model. Do not restart architecture discovery from the original repo list or move the provider implementations into Hermes.

## Owner's agreed direction

Phrog-web is a centralized, user-owned, provider-independent discovery and recommendation system as well as a web retrieval/research gateway. It owns connected-source acquisition, historical imports, normalization, behavior evidence, preferences, ranking, discovery history and feedback.

Optional phrog-web login enables persistent personalization. Connecting external accounts is optional; a profile can work from manual preferences and imports. Each source has separate collection and learning choices.

Keep three experiences distinct: enquiry, research and personal discovery. Enquiry/research do not automatically train preferences. Discovery should include enjoyable material, unfamiliar sources and local events, rather than converting all interests into productivity/career content.

Hermes is one authorized client. It understands conversational intent, supplies temporary circumstances, presents results and submits feedback. Other clients use the same profile. Relationship upkeep, messaging, posting, following accounts, booking and payments are separate tasks, not implied by discovery.

The original doomscroll-replacement idea is real: the local `ig_scroll.py` source reads the Instagram home feed, checks images/captions, uses personal taste, extracts/saves events and returns a bounded digest. Keyword search and Instagram Explore do not establish equivalent coverage.

## Work completed and commits

- `643af56`: initial five-repository source review and recovered intent.
- `e3d8e8a`: added social-media-research-cli and cobalt to the shortlist/review.
- `566f71f`: added actual feed-scroller and broader social-replacement source evidence.
- `d66f106`: complete 13-phase execution plan and architecture cross-reference.

At preparation, the checkout was on `feat/web-tools-merged` and the working tree was clean. Re-check the actual branch, HEAD and local changes before resuming; this is a shared checkout. The handoff itself is committed after the commits listed above. No push, PR, merge or deployment was performed for the planning work.

All seven repositories were shallow-cloned for read-only source exploration into the sibling directory `../phrog-web-research/social-integrations/`:

- `socai`
- `x-signal`
- `RSSHub`
- `last30days-skill`
- `social-media-research-skills`
- `social-media-research-cli`
- `cobalt`

The sibling `inventory-summary.json` and `<repo>-inventory.json` files contain revisions, origins, complete tracked-path inventories and text-file hashes. Exact reviewed revisions also appear in the committed source review. These clones are research inputs, not installed runtime services. Do not assume their dependencies, sessions or live capabilities are available. If a clone is missing, recover the pinned source reference rather than silently substituting a different version.

## Existing data and source evidence

Schema snapshots inspected, not full personal record coverage:

- `~/phrogvps/data/schemas/music__music.sqlite.sql`: normalized Spotify/Apple plays, library, favorites, playlists, sessions and aliases.
- `~/phrogvps/data/schemas/social__social.sqlite.sql`: platform events, follows, own posts/comments and provenance.
- `~/phrogvps/data/schemas/activity__activity.sqlite.sql`: product/account events, searches, saved places, reviews and coverage inputs.
- `~/phrogvps/data/schemas/media__media.sqlite.sql`: media identity, OCR/descriptions, extraction versions and source mappings.
- `~/phrogvps/data/schemas/personal__google-takeout-behavior.sqlite3.sql`: original payload references, source hashes and timestamp precision.
- `~/phrogvps/data/schemas/analysis__behaviour-model__behaviour.sqlite.sql`: historical derived summaries and coarse topic flags, not validated final preference labels.
- `~/phrogvps/data/schemas/serve__personal.sqlite.sql`: serving copies of domain data; do not count these again alongside canonical source databases.

Relevant design evidence:

- `~/brain/wiki/inbox/2026-10-04-capture-sorter-self-data-architecture.md`: immutable raw exports, normalized domains, source provenance, timestamps/units, shared IDs and SQL-backed claims.
- `~/phrogvps/openspec/changes/personal-knowledge-reconcile/specs/personal-knowledge/spec.md`: observations versus inferences, correction/supersession evidence and purpose routing.
- `~/phrogvps/hermes/scripts/ig_scroll.py`: historical feed discovery implementation.
- `~/projects/hermes-revamp/INTENT.md` and `docs/sept-plan-map-A.md`: original discovery/personal-assistant requirements.

These are local discovery pointers, not paths to hardcode into portable application code. Verify actual canonical database locations and source generations in Phase 0. Do not copy private records into Git, tests, tool output or handoff documents.

## Start here: Phase 0

First task: produce the execution plan's read-only source-authority and coverage audit. Do not treat prior schema inspection as this audit being finished.

1. Inspect current repository/worktree guidance and the actual state of the checkout. Before implementation, use the project's isolation/worktree workflow and keep changes scoped.
2. Locate canonical source databases, serving mirrors, export archives, import pipelines and data dictionaries available through authorized access. Establish source ownership and generation identity.
3. Check date ranges, action enums, account identities, null/metadata coverage, timezone/precision rules, duplicate overlap, aggregate-versus-event granularity, and definitions of derived skip/completion/topic fields.
4. Build an explicit field-to-proposed-schema mapping and source coverage/disposition report. Preserve unknowns and distinguish raw observations from existing derived analysis.
5. Set the first vertical slice and measurable latency/cost/source limits. Define synthetic tests and an appropriately scoped private held-out evaluation set before evaluating the ranker.
6. Report precise blockers such as inaccessible canonical sources or unverified account sessions. Continue independent synthetic/schema work where possible; do not invent data coverage.

Phase-0 exit: every intended input has a canonical/mirror/unavailable/deferred disposition; uncertainties and evaluation baselines are recorded; no personal-data writes were required for the audit.

Then proceed through the execution plan: migrations and ownership constraints; optional authentication/client grants; historical reconciliation; explicit rules/feedback/data controls; identity and enrichment; preference snapshots; ranked discovery/exposures; collection/watchlists; provider pilots; event discovery; client integration; staged rollout/recovery. The first usable slice does not require deploying every upstream project.

## Critical implementation constraints

- A separate phrog-web personalization database; existing normalized domain databases remain read-only evidence sources. The wiki index is not the personalization store.
- An authenticated principal owns each personal operation. Profile IDs alone are not authorization. No mutable global current user.
- Public metadata may be shared only when independently public. Private entities, observations, identifiers, annotations and artifacts stay owner-scoped.
- Source imports are idempotent while genuine repeated plays/watches survive. Ambiguous duplicates remain explicit.
- Historical unknown purpose is not automatically positive taste. Research and enquiry remain excluded from learning by default.
- Missing watch duration stays unknown. Daily aggregates do not become fabricated individual events. Partial snapshots cannot erase all memberships.
- Keep explicit rules, observed actions, extracted annotations and inferred preferences separate, versioned and traceable.
- Record actual display separately from API return/delivery. Unseen items are not dislikes.
- Corrections/deletion must invalidate dependencies and survive late collectors, replay and recomputation.
- One acquisition scheduler with bounded jobs/checkpoints/backoff. Avoid duplicate polling/research/notification stacks.
- Provider controls remain behind phrog-web. Never expose an arbitrary shell/browser-control surface through discovery tools.
- No secrets in Git/logs. No absolute host symlinks for embedded engines. Runtime paths and endpoints are configurable.

## Provider findings that must not get lost

X Signal has exact X feed tools and durable research/monitor components; socai has broad platform operations and an X home command; social-media-research-cli has an X For You reader through an existing Chrome tab. Compare them on a bounded capability pilot instead of installing three overlapping defaults.

Neither reviewed socai Instagram commands nor the reviewed social-media-research-cli Instagram CLI proves personalized Instagram home-feed coverage. Inspect and preserve the old path until its replacement is demonstrated.

RSSHub is a selected-feed generator, not the personal recommendation system. Its X home route exists, but exact feed semantics need testing. Cobalt is media resolution/download after discovery, with several response types and expiring tunnel links. Last30days is a research workflow/engine candidate. ScrapeCreators skills are workflow/API references and require hosted provider access for acquisition.

Socai's reviewed telemetry/text/trace gates default to enabled; review controls and verify egress before personal-data pilots. Runtime and licensing details differ between repos; re-check the pinned/upgraded upstream source before installing anything. The review contains those source anchors.

## Integration seams

REST: `src/index.ts`; configuration: `src/config.ts`; MCP: `src/adapters/mcp/server.ts`; Hermes tool definitions: `src/adapters/schemas/`; CLI: `src/cli.ts`; setup: `src/setup.ts`; existing social search: `src/providers/social.ts`; logging: `src/runlog.ts`.

The HTTP MCP server is instantiated per request. Pass authenticated context through its factory and personal-tool closures. Add personal-route log allowlists before recording private requests. Preserve existing anonymous search/research behavior and existing tool names.

Target external contracts, logical tables, module layout, dependencies, acceptance cases and rollback are in the execution plan. Those endpoints/tools are proposals, not currently callable capabilities.

## Verification and delivery

Before any completion claim, read actual command/test output. Required repository checks: `npx tsc`, local gateway `GET /health`, `git diff --check`, conventional commit and clean scoped changes. A healthy gateway does not prove imports, personalization, authenticated provider operation or recommendation usefulness.

At implementation boundaries also run the phase-specific tests: ownership/visibility, learning-purpose policy, re-import identity, partial snapshots, correction/deletion replay, worker crash/checkpoint recovery, exact provider surfaces, display/feedback idempotency, cross-client consistency and backup restore. Keep test fixtures synthetic.

Do not restart the live gateway without checking active turns and research/collection jobs; some existing unrelated jobs are in-memory. Preserve/drain them before activation. No upstream account operations, downloads, service starts or Hermes restarts occurred in the research/planning sessions.

## Copyable next-session brief

Continue phrog-web personal discovery from `docs/plans/personal-discovery-handoff.md` and `docs/plans/personal-discovery-execution-plan.md`. The owner agreed that phrog-web owns the provider-independent personalization database and algorithm, with optional login, optional connected accounts, and separate enquiry/research/discovery tools. Hermes is a client. Begin with Phase 0: read-only canonical-source and coverage audit, precise field mapping and evaluation baseline; schema snapshots alone do not prove record coverage. Preserve existing archives and services. Use the isolation workflow before implementation. Record the actual completed phase, source commit, verification and limitations; do not claim the remaining plan is implemented.
