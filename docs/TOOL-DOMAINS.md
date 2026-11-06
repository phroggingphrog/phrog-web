# Phrog Web MCP tool domains

Discover via GET /api/cookbook (mcp_tools), or MCP resources/list then resources/read of phrog-web://catalogue/tool-domains.

51 tools in 16 domains. Generated from actual MCP registrations and src/tool-domains.ts; no REST-only tools are invented. Existing capability and authentication contracts are unchanged.

## search (3)

Find ranked links on the general web.

**When to choose:** Choose search for discovery; fetch reads known URLs and research synthesizes answers.

| Tool | Behavior and return value |
| --- | --- |
| `quick_search` | [search] Runs fast multi-engine search and returns structured ranked web results with provider metadata. |
| `deep_search` | [search] Searches broadly with an optional category and returns web results rather than a synthesized research report. |
| `web_search` | [search] Runs configurable multi-engine search and returns fused ranked results with titles, URLs and snippets. |

## academic (2)

Discover scientific papers and research-source records.

**When to choose:** Choose academic for paper discovery; research produces a synthesis or literature-review job.

| Tool | Behavior and return value |
| --- | --- |
| `academic_search` | [academic] Searches Consensus and returns scientific paper results with available study metadata and takeaways. |
| `research_search` | [academic] Queries selected free research APIs in parallel and returns source-grouped research records. |

## live-social-places (3)

Find timely posts, discussions and physical places.

**When to choose:** Choose this domain for freshness, community discussion or location-specific results rather than general web discovery.

| Tool | Behavior and return value |
| --- | --- |
| `live_search` | [live-social-places] Searches a recent time window and returns fresh structured web results. |
| `place_search` | [live-social-places] Searches Google Maps places and returns ratings, review counts, addresses and available open status. |
| `social_search` | [live-social-places] Searches public social sources and returns matching posts grouped by source. |

## fetch-monitor (2)

Read a known page or track content changes.

**When to choose:** Choose fetch for page text, monitor for change detection, crawl for multiple pages and extract for schema-shaped data; REST-only scrape/parse are in capabilities.

| Tool | Behavior and return value |
| --- | --- |
| `fetch` | [fetch-monitor] Reads a URL through the fetch fallback chain and returns extracted Markdown with fetch metadata. |
| `monitor` | [fetch-monitor] Lists, creates or checks page fingerprints and returns monitor records or change-check results. |

## browse-agent (3)

Execute page-bound tasks or multi-source agent synthesis.

**When to choose:** Choose agent when navigation or reasoning is needed; prefer fetch for a simple page read and research for a durable long-running investigation.

| Tool | Behavior and return value |
| --- | --- |
| `browse` | [browse-agent] Runs the deprecated agent mode=browse alias and returns the agent status/result/steps/sources envelope; prefer agent. |
| `agent` | [browse-agent] Runs a page task or query synthesis and returns status, result, steps, escalation target and sources. |
| `web_agent_run` | [browse-agent] Runs the deprecated agent alias and returns the same agent envelope; prefer agent. |

## research (9)

Synthesize evidence and manage durable research jobs.

**When to choose:** Choose research for cited synthesis rather than search links; use quick mode for short answers and deep jobs for staged investigations, respecting poll_after_s.

| Tool | Behavior and return value |
| --- | --- |
| `research` | [research] Answers in quick mode with a research response, or dispatches a deep workflow and returns jobId, workflow and status for research_status. |
| `literature_review` | [research] Dispatches the Feynman literature-review workflow and returns jobId, workflow and status for research_status. |
| `research_status` | [research] Looks up a jobId and returns job status, available deliverable and polling guidance while running. |
| `research_vault` | [research] Searches, reads or writes reusable research notes and claims and returns action-specific vault records or status. |
| `deep_research_start` | [research] Starts a staged Feynman workflow and returns a job_id with polling guidance; do not also start research for the same question. |
| `deep_research_status` | [research] Polls a job_id and returns progress plus cited Markdown when complete and include_result is true. |
| `deep_research_resume` | [research] Resumes a durable run_id from its checkpoint and returns the resumed research-job response. |
| `research_resume` | [research] Resumes a job_id and returns the job response with resumed_mode indicating checkpoint continuation or workflow restart. |
| `research_cancel` | [research] Stops a job_id and its process tree and returns the cancellation result. |

## crawl-map-batch (5)

Discover site URLs and collect multiple pages.

**When to choose:** Choose map for URLs without page content, crawl for Markdown pages, and background jobs for larger batches rather than single-page fetch.

| Tool | Behavior and return value |
| --- | --- |
| `web_crawl` | [crawl-map-batch] Scrapes up to ten URLs and returns per-page Markdown and crawl metadata. |
| `web_map` | [crawl-map-batch] Discovers URLs through sitemaps or page links and returns a URL list without reading all page bodies. |
| `web_crawl_start` | [crawl-map-batch] Starts a link-following site crawl and returns a background job identifier for web_crawl_status. |
| `web_batch_start` | [crawl-map-batch] Starts a crawl of up to 500 supplied URLs and returns a background job identifier for web_crawl_status. |
| `web_crawl_status` | [crawl-map-batch] Reads a background crawl job and returns progress and optionally paginated page results. |

## extract (1)

Turn web pages into schema-shaped data.

**When to choose:** Choose extract when a JSON Schema is the output contract; fetch and crawl return readable page content instead.

| Tool | Behavior and return value |
| --- | --- |
| `extract` | [extract] Extracts data from URLs against a JSON Schema and returns validated structured data with null for unknown values. |

## wiki (2)

Save and retrieve notes in the Phrog Web wiki.

**When to choose:** Choose wiki for the note library; research_vault manages Feynman evidence and DeepWiki documents public repositories.

| Tool | Behavior and return value |
| --- | --- |
| `wiki_save` | [wiki] Saves and indexes a Markdown inbox note and returns a confirmation with the saved note record. |
| `wiki_search` | [wiki] Searches the wiki index by similarity and returns query, matching results and total. |

## session-login-state (1)

Inspect and use existing site login state.

**When to choose:** Choose login_state only when a page needs the persistent authenticated browser; ordinary public pages use fetch.

| Tool | Behavior and return value |
| --- | --- |
| `login_state` | [session-login-state] Lists, saves, deletes or uses site login jars and returns jar/browser metadata, mutation confirmation or authenticated page content without returning cookie values. |

## keys-usage (3)

Manage provider configuration and inspect gateway telemetry.

**When to choose:** Choose this domain to diagnose configuration or gateway calls, not to search the web; key mutations alter the existing provider store.

| Tool | Behavior and return value |
| --- | --- |
| `run_log` | [keys-usage] Reads recent gateway run records and returns newest-first call outcomes, durations and available provider metadata. |
| `keys` | [keys-usage] Lists, checks, sets or removes provider keys and returns configuration metadata or mutation confirmation, never key values. |
| `usage` | [keys-usage] Aggregates a time window and returns call counts, error rates, latency percentiles and available tool/client attribution. |

## media-books (3)

Find media metadata and available book files.

**When to choose:** Choose media_search for titles and ratings; book_availability finds downloadable references and book_download saves a selected file on the gateway host.

| Tool | Behavior and return value |
| --- | --- |
| `media_search` | [media-books] Searches book, film or music metadata and returns matching records with available public ratings. |
| `book_availability` | [media-books] Searches configured book sources and returns availability rows with references usable by book_download; source access requirements still apply. |
| `book_download` | [media-books] Downloads a selected book reference and returns its saved gateway-local file path, not the file bytes. |

## marketplace-secondhand (6)

Find products, used listings and deal comparisons.

**When to choose:** Choose this domain for buying research rather than general search; visual_search starts from an image and the other tools use product terms or IDs.

| Tool | Behavior and return value |
| --- | --- |
| `secondhand_search` | [marketplace-secondhand] Searches supported used-item marketplaces and returns listings with available prices, locations and listing IDs. |
| `secondhand_listing` | [marketplace-secondhand] Reads a marketplace listing ID and returns description, seller and available photo metadata. |
| `marketplace_search` | [marketplace-secondhand] Searches AliExpress products and returns product records with IDs for marketplace_product. |
| `marketplace_product` | [marketplace-secondhand] Reads an AliExpress product and returns price, variants, shipping, store metadata and requested reviews. |
| `deals_search` | [marketplace-secondhand] Searches OzBargain or reads latest deals and returns price references, votes, store links, dates and expiration flags. |
| `visual_search` | [marketplace-secondhand] Identifies an item from an image and returns identification plus optional shop, deal and secondhand matches. |

## github-deepwiki (6)

Discover public repositories, source archives and codebase documentation.

**When to choose:** Choose GitHub tools for repository artifacts and DeepWiki tools for generated architectural explanations; wiki is the separate local note library.

| Tool | Behavior and return value |
| --- | --- |
| `github_search` | [github-deepwiki] Searches public GitHub repositories and returns repository records with available stars and licensing metadata. |
| `deepwiki_ask` | [github-deepwiki] Asks a question about a public repository and returns a generated answer with available grounded citations. |
| `deepwiki_structure` | [github-deepwiki] Reads a DeepWiki repository outline and returns its documentation table of contents. |
| `deepwiki_read` | [github-deepwiki] Reads generated DeepWiki documentation and returns the page content, truncated to max_chars; prefer structure then ask for focused questions. |
| `github_download` | [github-deepwiki] Downloads and optionally extracts a public repository ref and returns gateway-local archive and extraction paths. |
| `github_patch` | [github-deepwiki] Fetches a public pull request and returns diff or patch text, subject to the requested character limit. |

## youtube (1)

Read spoken content from a known YouTube video.

**When to choose:** Choose youtube_transcript for video text; social_search discovers videos and media_search finds film metadata.

| Tool | Behavior and return value |
| --- | --- |
| `youtube_transcript` | [youtube] Reads captions or falls back to speech-to-text and returns transcript text with source manual, auto or stt. |

## feed (1)

Read feed entries in their original source order.

**When to choose:** Choose feed for a known feed source rather than ranked social search; screenshots are only viewed when actually attached within the result budget.

| Tool | Behavior and return value |
| --- | --- |
| `feed` | [feed] Reads a configured feed source and returns feed.v1 entry JSON plus screenshots that fit the MCP result budget and explicit omission metadata. |
