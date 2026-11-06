// Shared client-facing documentation; membership is checked against actual MCP registrations.
export const CATALOGUE_URI = 'phrog-web://catalogue/tool-domains';
export const TOOL_DOMAINS: { id: string; purpose: string; pick_when: string; tools: Record<string, string> }[] = [
  { id: 'search', purpose: 'Find ranked links on the general web.', pick_when: 'Choose search for discovery; fetch reads known URLs and research synthesizes answers.', tools: {
    quick_search: 'Runs fast multi-engine search and returns structured ranked web results with provider metadata.',
    web_search: 'Runs configurable multi-engine search and returns fused ranked results with titles, URLs and snippets.',
    deep_search: 'Searches broadly with an optional category and returns web results rather than a synthesized research report.',
  } },
  { id: 'academic', purpose: 'Discover scientific papers and research-source records.', pick_when: 'Choose academic for paper discovery; research produces a synthesis or literature-review job.', tools: {
    academic_search: 'Searches Consensus and returns scientific paper results with available study metadata and takeaways.',
    research_search: 'Queries selected free research APIs in parallel and returns source-grouped research records.',
  } },
  { id: 'live-social-places', purpose: 'Find timely posts, discussions and physical places.', pick_when: 'Choose this domain for freshness, community discussion or location-specific results rather than general web discovery.', tools: {
    live_search: 'Searches a recent time window and returns fresh structured web results.',
    social_search: 'Searches public social sources and returns matching posts grouped by source.',
    place_search: 'Searches Google Maps places and returns ratings, review counts, addresses and available open status.',
  } },
  { id: 'fetch-monitor', purpose: 'Read a known page or track content changes.', pick_when: 'Choose fetch for page text, monitor for change detection, crawl for multiple pages and extract for schema-shaped data; REST-only scrape/parse are in capabilities.', tools: {
    fetch: 'Reads a URL through the fetch fallback chain and returns extracted Markdown with fetch metadata.',
    monitor: 'Lists, creates or checks page fingerprints and returns monitor records or change-check results.',
  } },
  { id: 'browse-agent', purpose: 'Execute page-bound tasks or multi-source agent synthesis.', pick_when: 'Choose agent when navigation or reasoning is needed; prefer fetch for a simple page read and research for a durable long-running investigation.', tools: {
    agent: 'Runs a page task or query synthesis and returns status, result, steps, escalation target and sources.',
    browse: 'Runs the deprecated agent mode=browse alias and returns the agent status/result/steps/sources envelope; prefer agent.',
    web_agent_run: 'Runs the deprecated agent alias and returns the same agent envelope; prefer agent.',
  } },
  { id: 'research', purpose: 'Synthesize evidence and manage durable research jobs.', pick_when: 'Choose research for cited synthesis rather than search links; use quick mode for short answers and deep jobs for staged investigations, respecting poll_after_s.', tools: {
    research: 'Answers in quick mode with a research response, or dispatches a deep workflow and returns jobId, workflow and status for research_status.',
    literature_review: 'Dispatches the Feynman literature-review workflow and returns jobId, workflow and status for research_status.',
    research_status: 'Looks up a jobId and returns job status, available deliverable and polling guidance while running.',
    deep_research_start: 'Starts a staged Feynman workflow and returns a job_id with polling guidance; do not also start research for the same question.',
    deep_research_status: 'Polls a job_id and returns progress plus cited Markdown when complete and include_result is true.',
    deep_research_resume: 'Resumes a durable run_id from its checkpoint and returns the resumed research-job response.',
    research_resume: 'Resumes a job_id and returns the job response with resumed_mode indicating checkpoint continuation or workflow restart.',
    research_cancel: 'Stops a job_id and its process tree and returns the cancellation result.',
    research_vault: 'Searches, reads or writes reusable research notes and claims and returns action-specific vault records or status.',
  } },
  { id: 'crawl-map-batch', purpose: 'Discover site URLs and collect multiple pages.', pick_when: 'Choose map for URLs without page content, crawl for Markdown pages, and background jobs for larger batches rather than single-page fetch.', tools: {
    web_crawl: 'Scrapes up to ten URLs and returns per-page Markdown and crawl metadata.',
    web_map: 'Discovers URLs through sitemaps or page links and returns a URL list without reading all page bodies.',
    web_crawl_start: 'Starts a link-following site crawl and returns a background job identifier for web_crawl_status.',
    web_batch_start: 'Starts a crawl of up to 500 supplied URLs and returns a background job identifier for web_crawl_status.',
    web_crawl_status: 'Reads a background crawl job and returns progress and optionally paginated page results.',
  } },
  { id: 'extract', purpose: 'Turn web pages into schema-shaped data.', pick_when: 'Choose extract when a JSON Schema is the output contract; fetch and crawl return readable page content instead.', tools: {
    extract: 'Extracts data from URLs against a JSON Schema and returns validated structured data with null for unknown values.',
  } },
  { id: 'wiki', purpose: 'Save and retrieve notes in the Phrog Web wiki.', pick_when: 'Choose wiki for the note library; research_vault manages Feynman evidence and DeepWiki documents public repositories.', tools: {
    wiki_save: 'Saves and indexes a Markdown inbox note and returns a confirmation with the saved note record.',
    wiki_search: 'Searches the wiki index by similarity and returns query, matching results and total.',
  } },
  { id: 'session-login-state', purpose: 'Inspect and use existing site login state.', pick_when: 'Choose login_state only when a page needs the persistent authenticated browser; ordinary public pages use fetch.', tools: {
    login_state: 'Lists, saves, deletes or uses site login jars and returns jar/browser metadata, mutation confirmation or authenticated page content without returning cookie values.',
  } },
  { id: 'keys-usage', purpose: 'Manage provider configuration and inspect gateway telemetry.', pick_when: 'Choose this domain to diagnose configuration or gateway calls, not to search the web; key mutations alter the existing provider store.', tools: {
    keys: 'Lists, checks, sets or removes provider keys and returns configuration metadata or mutation confirmation, never key values.',
    usage: 'Aggregates a time window and returns call counts, error rates, latency percentiles and available tool/client attribution.',
    run_log: 'Reads recent gateway run records and returns newest-first call outcomes, durations and available provider metadata.',
  } },
  { id: 'media-books', purpose: 'Find media metadata and available book files.', pick_when: 'Choose media_search for titles and ratings; book_availability finds downloadable references and book_download saves a selected file on the gateway host.', tools: {
    media_search: 'Searches book, film or music metadata and returns matching records with available public ratings.',
    book_availability: 'Searches configured book sources and returns availability rows with references usable by book_download; source access requirements still apply.',
    book_download: 'Downloads a selected book reference and returns its saved gateway-local file path, not the file bytes.',
  } },
  { id: 'marketplace-secondhand', purpose: 'Find products, used listings and deal comparisons.', pick_when: 'Choose this domain for buying research rather than general search; visual_search starts from an image and the other tools use product terms or IDs.', tools: {
    marketplace_search: 'Searches AliExpress products and returns product records with IDs for marketplace_product.',
    marketplace_product: 'Reads an AliExpress product and returns price, variants, shipping, store metadata and requested reviews.',
    secondhand_search: 'Searches supported used-item marketplaces and returns listings with available prices, locations and listing IDs.',
    secondhand_listing: 'Reads a marketplace listing ID and returns description, seller and available photo metadata.',
    deals_search: 'Searches OzBargain or reads latest deals and returns price references, votes, store links, dates and expiration flags.',
    visual_search: 'Identifies an item from an image and returns identification plus optional shop, deal and secondhand matches.',
  } },
  { id: 'github-deepwiki', purpose: 'Discover public repositories, source archives and codebase documentation.', pick_when: 'Choose GitHub tools for repository artifacts and DeepWiki tools for generated architectural explanations; wiki is the separate local note library.', tools: {
    github_search: 'Searches public GitHub repositories and returns repository records with available stars and licensing metadata.',
    github_download: 'Downloads and optionally extracts a public repository ref and returns gateway-local archive and extraction paths.',
    github_patch: 'Fetches a public pull request and returns diff or patch text, subject to the requested character limit.',
    deepwiki_ask: 'Asks a question about a public repository and returns a generated answer with available grounded citations.',
    deepwiki_structure: 'Reads a DeepWiki repository outline and returns its documentation table of contents.',
    deepwiki_read: 'Reads generated DeepWiki documentation and returns the page content, truncated to max_chars; prefer structure then ask for focused questions.',
  } },
  { id: 'youtube', purpose: 'Read spoken content from a known YouTube video.', pick_when: 'Choose youtube_transcript for video text; social_search discovers videos and media_search finds film metadata.', tools: {
    youtube_transcript: 'Reads captions or falls back to speech-to-text and returns transcript text with source manual, auto or stt.',
  } },
  { id: 'feed', purpose: 'Read feed entries in their original source order.', pick_when: 'Choose feed for a known feed source rather than ranked social search; screenshots are only viewed when actually attached within the result budget.', tools: {
    feed: 'Reads a configured feed source and returns feed.v1 entry JSON plus screenshots that fit the MCP result budget and explicit omission metadata.',
  } },
];

type RegisteredTool = { name: string; description: string };
export function toolDocumentation(name: string): string {
  const canonical = name === 'phrogweb-feed' ? 'feed' : name;
  for (const domain of TOOL_DOMAINS) {
    const summary = (domain.tools as Record<string, string>)[canonical];
    if (summary) return `[${domain.id}] ${summary}`;
  }
  throw new Error(`MCP tool lacks domain documentation: ${name}`);
}

export function buildToolCatalogue(registered: RegisteredTool[]) {
  const names = registered.map(t => t.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate MCP tool registration');
  const domains = TOOL_DOMAINS.map(domain => ({
    id: domain.id, purpose: domain.purpose, pick_when: domain.pick_when,
    tools: registered.filter(t => Object.hasOwn(domain.tools, t.name === 'phrogweb-feed' ? 'feed' : t.name)),
  }));
  const documented = domains.flatMap(d => d.tools.map(t => t.name));
  const expected = TOOL_DOMAINS.flatMap(d => Object.keys(d.tools));
  const missing = expected.filter(name => !names.includes(name));
  const unassigned = names.filter(name => !documented.includes(name));
  if (missing.length || unassigned.length) throw new Error(`MCP catalogue mismatch: missing=${missing}; unassigned=${unassigned}`);
  return { version: 1, resource_uri: CATALOGUE_URI, tool_count: names.length, domain_count: domains.length, domains };
}

export function renderToolDomainsMarkdown(catalogue: ReturnType<typeof buildToolCatalogue>): string {
  return '# Phrog Web MCP tool domains\n\n'
    + `Discover via GET /api/cookbook (mcp_tools), or MCP resources/list then resources/read of ${CATALOGUE_URI}.\n\n`
    + `${catalogue.tool_count} tools in ${catalogue.domain_count} domains. Generated from actual MCP registrations and src/tool-domains.ts; no REST-only tools are invented. Existing capability and authentication contracts are unchanged.\n\n`
    + catalogue.domains.map(d => `## ${d.id} (${d.tools.length})\n\n${d.purpose}\n\n**When to choose:** ${d.pick_when}\n\n| Tool | Behavior and return value |\n| --- | --- |\n`
      + d.tools.map(t => `| \`${t.name}\` | ${toolDocumentation(t.name).replaceAll('|', '\\|').replaceAll('\n', ' ')} |`).join('\n')).join('\n\n') + '\n';
}
