import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { executeSearch } from '../../providers/search.js';
import { executeFetch } from '../../providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from '../../providers/research.js';
import { searchGithubRepos, downloadGithubRepo, fetchGithubPatch } from '../../providers/github.js';
import { askDeepWiki, getDeepWikiStructure, readDeepWikiContents } from '../../providers/deepwiki.js';
import { searchMedia } from '../../providers/media.js';
import { searchBooks, downloadBook } from '../../providers/books.js';
import { searchDeals } from '../../providers/ozbargain.js';
import { searchPlaces } from '../../providers/places.js';
import { visualSearch } from '../../providers/visual.js';
import { resolveLocation, localizeQuery } from '../../location.js';
import { searchSecondhand, secondhandListing, searchAliexpress, aliexpressProduct } from '../../providers/marketplace.js';
import { searchSocial } from '../../providers/social.js';
import { getTranscript } from '../../providers/transcript.js';
import { webCrawl, webMap, webBatchStart, webCrawlStatus, webCrawlStart } from '../../providers/crawl.js';
import { browse } from '../../providers/browse.js';
import { extract } from '../../providers/extract.js';
import { runAgent } from '../../providers/agent.js';
import { researchVault } from '../../providers/vault.js';
import { researchSearch } from '../../providers/sources.js';
import { webSearch, deepResearchStart, deepResearchStatus, deepResearchResume } from '../../providers/compat.js';
import { saveToWiki, searchWiki } from '../../wiki/vault.js';
import { logged, recentRuns } from '../../runlog.js';
import { saveToBrainWiki } from '../../wiki/brain.js';
import { getFeed, personalDb } from '../../personalization/feed.js';
import { feedDecide, DECISIONS } from '../../personalization/decisions.js';
import { readArtifact, ARTIFACT_URL_PREFIX } from '../../personalization/filter.js';
import { personalDiscover } from '../../personalization/discover.js';
import { recordFeedback } from '../../personalization/feedback.js';
import { personalPreferences } from '../../personalization/preferences.js';
import { stdioAuthorized, AUTH_REQUIRED_MESSAGE } from '../../personalization/auth.js';

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

export interface McpContext { personalAuthorized?: boolean }

export function createMcpServer(ctx: McpContext = {}): McpServer {
const server = new McpServer({ name: 'phrog-web', version: '0.1.0' });
// Log every tool call: wrap the handler (always the last argument) of each server.tool registration.
const origTool = server.tool.bind(server) as (...a: any[]) => unknown;
(server as any).tool = (...args: any[]) => {
  const name = args[0] as string;
  const last = args.length - 1;
  if (typeof args[last] === 'function') args[last] = logged(name, args[last]);
  return origTool(...args);
};

server.tool(
  'quick_search',
  'Fast, structured web search using SearXNG multi-engine aggregation with automatic TinyFish fallback.',
  {
    query: z.string().describe('Search query string'),
    limit: z.number().int().min(1).max(30).optional().describe('Maximum results to return'),
  },
  async ({ query, limit }) => {
    try {
      const res = await executeSearch(query, { mode: 'quick', limit });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'academic_search',
  'Search 220M+ peer-reviewed scientific papers via Consensus Academic API with study types, sample sizes, and plain takeaways.',
  {
    query: z.string().describe('Academic or scientific research question'),
    limit: z.number().int().min(1).max(20).optional().describe('Maximum papers to return'),
  },
  async ({ query, limit }) => {
    try {
      const res = await executeSearch(query, { mode: 'academic', limit });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'live_search',
  'Search fresh, real-time web results filtered by recent time windows (day, week, month).',
  {
    query: z.string().describe('Search query string'),
    time_range: z.enum(['day', 'week', 'month']).default('day').describe('Freshness time range filter'),
    limit: z.number().int().min(1).max(30).optional().describe('Maximum results to return'),
  },
  async ({ query, time_range, limit }) => {
    try {
      const res = await executeSearch(query, { mode: 'live', timeRange: time_range, limit });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'deep_search',
  'Domain-agnostic deep search. Searches broadly across the general web by default, or accepts an optional domain/category parameter.',
  {
    query: z.string().describe('Search query string'),
    domain: z.string().optional().describe('Optional domain filter, e.g. "science", "it", "news", or custom category'),
    limit: z.number().int().min(1).max(30).optional().describe('Maximum results to return'),
  },
  async ({ query, domain, limit }) => {
    try {
      const res = await executeSearch(query, { mode: 'deep', domain, limit });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'fetch',
  'Clean Markdown page extractor cascading through local Plain Fetch, local Crawl4AI (headless JS), and TinyFish Fetch.',
  {
    url: z.string().url().describe('Target web URL to fetch and convert to Markdown'),
    mode: z.enum(['plain', 'browser', 'auto']).default('auto').describe('Fetching strategy'),
    max_chars: z.number().optional().describe('Maximum character length'),
  },
  async ({ url, mode, max_chars }) => {
    try {
      const res = await executeFetch(url, { mode, maxChars: max_chars });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'research',
  'Research a topic. Quick mode synthesizes answers in 3-5s (Vane) across web or academic domains. Deep workflows (lit, deepresearch, compare, audit, review, draft, recipe) dispatch autonomous Feynman agent.',
  {
    question: z.string().describe('Research question or topic'),
    domain: z.enum(['web', 'academic', 'discussions', 'all']).default('web').describe('Domain target: web (general), academic (papers/arXiv/PubMed), or discussions (forums)'),
    workflow: z.enum(['quick', 'deepresearch', 'lit', 'compare', 'audit', 'review', 'draft', 'recipe', 'summarize']).default('quick').describe('Research workflow'),
    callback_url: z.string().url().optional().describe('Optional webhook URL to receive deep research results upon completion'),
  },
  async ({ question, domain, workflow, callback_url }) => {
    try {
      if (workflow === 'quick') {
        const res = await executeQuickResearch(question, { domain });
        return text(res);
      } else {
        const job = dispatchDeepResearch(question, { workflow, domain, callbackUrl: callback_url });
        return text({
          message: `Autonomous Feynman research job dispatched for workflow "${workflow}" (domain: ${domain}).`,
          jobId: job.jobId,
          workflow: job.workflow,
          domain,
          status: job.status,
          pollInstruction: `Call research_status with jobId "${job.jobId}" in about 60s, then follow its poll_after_s. Do not start a second research job for the same question.`,
        });
      }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'literature_review',
  'Execute an autonomous academic literature review (Feynman lit workflow) analyzing papers, methodologies, and citation trees.',
  {
    topic: z.string().describe('Academic topic or hypothesis to review'),
    callback_url: z.string().url().optional().describe('Optional webhook URL to receive completed review'),
  },
  async ({ topic, callback_url }) => {
    try {
      const job = dispatchDeepResearch(topic, { workflow: 'lit', callbackUrl: callback_url });
      return text({
        message: 'Feynman literature review agent dispatched.',
        jobId: job.jobId,
        workflow: 'lit',
        status: job.status,
      });
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'research_status',
  'Check the status and deliverable of a background Feynman deep research job.',
  {
    jobId: z.string().describe('Job ID returned by research or literature_review'),
  },
  async ({ jobId }) => {
    const job = getResearchJob(jobId);
    if (!job) {
      return { isError: true, content: [{ type: 'text', text: `Research job "${jobId}" not found` }] };
    }
    if (job.status === 'running') {
      const elapsed = Math.round((Date.now() - Date.parse(job.startedAt)) / 1000);
      const poll_after_s = elapsed < 120 ? 60 : elapsed < 900 ? 180 : 300;
      return text({ ...job, elapsed_s: elapsed, poll_after_s, hint: `Feynman research usually takes 5-60 minutes. Do not poll again for ${poll_after_s}s; continue other work and check back later.` });
    }
    return text(job);
  }
);

server.tool(
  'github_search',
  'Search public GitHub repositories for codebases, packages, stars, and licensing information.',
  {
    query: z.string().describe('Repository keywords or topics'),
    limit: z.number().int().min(1).max(25).optional().describe('Maximum repositories to return'),
  },
  async ({ query, limit }) => {
    try {
      const res = await searchGithubRepos(query, limit);
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'deepwiki_ask',
  'Query AI-generated codebase documentation for any public GitHub repository (deepwiki.com) with grounded inline citations.',
  {
    repo: z.string().describe('GitHub repository name in "owner/repo" format (e.g. "facebook/react" or "fastify/fastify")'),
    question: z.string().describe('Question about the architecture, APIs, or internals of the repository'),
  },
  async ({ repo, question }) => {
    try {
      const res = await askDeepWiki(repo, question);
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'deepwiki_structure',
  'Retrieve the section outline and documentation table of contents for any public GitHub repo indexed by DeepWiki.',
  {
    repo: z.string().describe('GitHub repository name in "owner/repo" format (e.g. "facebook/react")'),
  },
  async ({ repo }) => {
    try {
      const res = await getDeepWikiStructure(repo);
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'deepwiki_read',
  'Read the full generated documentation pages (wiki contents) for a public GitHub repo indexed by DeepWiki. Large output: prefer deepwiki_structure first, then deepwiki_ask for targeted questions.',
  {
    repo: z.string().describe('GitHub repository name in "owner/repo" format (e.g. "facebook/react")'),
    max_chars: z.number().optional().describe('Truncate output to this many characters (default 60000)'),
  },
  async ({ repo, max_chars }) => {
    try {
      const res = await readDeepWikiContents(repo, max_chars);
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'wiki_save',
  'Save a note into the LOCAL vector wiki in this repo (not the brain; for the brain wiki inbox use save_to_wiki). Distill and save research findings or notes (Karpathy markdown vault) with automatic vector embedding and frontmatter.',
  {
    title: z.string().describe('Note title (becomes filename slug)'),
    content: z.string().describe('Markdown note content with sections, summaries, and citations'),
    tags: z.array(z.string()).optional().describe('Categorization tags'),
    source: z.string().optional().describe('Source URL or attribution'),
  },
  async ({ title, content, tags, source }) => {
    try {
      const note = await saveToWiki(title, content, { tags, source });
      return text({
        message: 'Note saved and vector-indexed in wiki vault',
        note,
      });
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'wiki_search',
  'Perform semantic vector search across all notes in the LLM Wiki vault using cosine similarity.',
  {
    query: z.string().describe('Natural language search query or concept'),
    limit: z.number().int().min(1).max(20).optional().describe('Maximum notes to return'),
  },
  async ({ query, limit }) => {
    try {
      const results = await searchWiki(query, limit);
      return text({ query, results, total: results.length });
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'media_search',
  'Search books, films or music metadata with ratings from public sources.',
  {
    query: z.string().describe('Title or keywords'),
    type: z.enum(['book', 'film', 'music']).describe('Media type'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum results'),
  },
  async (args) => {
    try {
      return text(await searchMedia(args.query, args.type, { limit: args.limit }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'book_availability',
  'Search books on Z-Library and Anna\'s Archive (needs credentials from `pnpm setup`); rows include a ref for book_download.',
  {
    query: z.string().describe('Book title or author'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum results'),
    sources: z.array(z.enum(['zlibrary', 'annas', 'libgen'])).optional().describe('Sources to search (default zlibrary + annas)'),
  },
  async (args) => {
    try {
      return text(await searchBooks(args.query, { limit: args.limit, sources: args.sources }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'github_download',
  'Download a PUBLIC GitHub repo (no API key) as a tarball into the gateway downloads folder and extract it; returns the local paths. Use ref for a branch, tag or commit (default: default branch).',
  {
    repo: z.string().describe('"owner/repo" or a github.com URL'),
    ref: z.string().optional().describe('Branch, tag or commit SHA (default HEAD)'),
    extract: z.boolean().optional().describe('Extract the tarball (default true)'),
  },
  async (args) => {
    try {
      return text(await downloadGithubRepo(args.repo, { ref: args.ref, extract: args.extract }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'github_patch',
  'Fetch the diff or patch of a PUBLIC GitHub pull request (no API key).',
  {
    repo: z.string().describe('"owner/repo" or a github.com URL'),
    number: z.number().int().positive().describe('Pull request number'),
    kind: z.enum(['diff', 'patch']).optional().describe('Format (default diff)'),
    max_chars: z.number().optional().describe('Truncate output (default 100000)'),
  },
  async (args) => {
    try {
      return text(await fetchGithubPatch(args.repo, args.number, args.kind, args.max_chars));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'book_download',
  'Download a book to the gateway downloads folder; returns the saved file path. Use a ref from book_availability, or an md5/id plus source.',
  {
    ref: z.string().describe('Row ref from book_availability, or md5/id'),
    source: z.enum(['zlibrary', 'annas', 'libgen']).optional().describe('Source (needed for md5/id)'),
  },
  async (args) => {
    try {
      return text(await downloadBook(args.ref, { source: args.source }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'secondhand_search',
  'Search secondhand marketplaces (Facebook Marketplace, Depop, Poshmark; eBay when keys are set) for used items, with price and location filters.',
  {
    query: z.string().describe('What to look for'),
    marketplaces: z.array(z.enum(['facebook', 'depop', 'poshmark', 'ebay'])).optional().describe('Default: all available'),
    location: z.string().optional().describe('City for Facebook Marketplace, e.g. "Melbourne, Australia" (default: saved location)'),
    radiusKm: z.number().optional().describe('Search radius in km (Facebook Marketplace)'),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
    condition: z.string().optional().describe('e.g. new, used_like_new, used_good, used_fair'),
    sort: z.string().optional().describe('e.g. price_low, price_high, newest'),
    limit: z.number().int().min(1).max(50).optional().describe('Per marketplace (default 10)'),
  },
  async (args) => {
    try {
      return text(await searchSecondhand(args.query, args));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'secondhand_listing',
  'Full details of one secondhand listing (description, seller, photos count) from its id and marketplace.',
  {
    listingId: z.string().describe('Listing id from secondhand_search'),
    marketplace: z.enum(['facebook', 'depop', 'poshmark', 'ebay']),
  },
  async (args) => {
    try {
      return text(await secondhandListing(args.listingId, args.marketplace));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'marketplace_search',
  'Search new-item marketplace products on AliExpress; returns product ids for marketplace_product.',
  {
    query: z.string().describe('Product to find'),
    limit: z.number().int().min(1).max(30).optional(),
  },
  async (args) => {
    try {
      return text(await searchAliexpress(args.query, args.limit));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'marketplace_product',
  'Full AliExpress product data: sale price, variants, shipping, store rating, star ratings and reviews (takes ~15s).',
  {
    product: z.string().describe('AliExpress product id or /item/<id>.html URL'),
    reviews: z.number().int().min(0).max(50).optional().describe('Reviews to include (default 5)'),
  },
  async (args) => {
    try {
      return text(await aliexpressProduct(args.product, args.reviews));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'deals_search',
  'Australian deals and price history from OzBargain: price, votes, store link, posted date, expired flag. Use to cross-check a product price before buying. No query = latest deals.',
  {
    query: z.string().optional().describe('Product or brand, e.g. "ugreen usb c hub"'),
    limit: z.number().int().min(1).max(30).optional(),
    includeExpired: z.boolean().optional().describe('Keep expired deals as past-price reference (default true)'),
    near: z.string().optional().describe('Place whose state is used to flag state-only deals (default: saved location)'),
  },
  async (args) => {
    try {
      return text(await searchDeals(args.query, args));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'place_search',
  'Google Maps places with Google rating, review count, category, address and open status (e.g. "pho footscray", "State Library Victoria"). Review text needs GOOGLE_PLACES_API_KEY.',
  {
    query: z.string().describe('Place or "what near where"'),
    limit: z.number().int().min(1).max(20).optional(),
    near: z.string().optional().describe('Suburb/city to search around; default is the saved location'),
  },
  async (args) => {
    try {
      return text(await searchPlaces(args.query, { limit: args.limit, near: args.near }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'visual_search',
  'Search by photo: identifies the item (vision model; Bing Visual Search too for public image URLs), then checks AliExpress, OzBargain deals and secondhand listings. image = URL, local file path, or data: URL.',
  {
    image: z.string().describe('Image URL, absolute file path on the gateway host, or data:image/... URL'),
    hint: z.string().optional().describe('Extra context, e.g. "the shoes, not the bag"'),
    shop: z.boolean().optional().describe('Also search shops/deals/secondhand (default true)'),
    limit: z.number().int().min(1).max(10).optional(),
    near: z.string().optional(),
  },
  async (args) => {
    try {
      return text(await visualSearch(args.image, args));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'social_search',
  'Search public social sources (reddit, hackernews, bluesky, lemmy, mastodon, youtube).',
  {
    query: z.string().describe('Search query'),
    sources: z.array(z.string()).optional().describe('Subset of sources'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum posts per source'),
    timeRange: z.enum(['day', 'week', 'month', 'year']).optional().describe('Time window'),
  },
  async (args) => {
    try {
      return text(await searchSocial(args.query, { sources: args.sources, limit: args.limit, timeRange: args.timeRange }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

server.tool(
  'youtube_transcript',
  'Fetch the transcript of a YouTube video: manual or auto captions first, then speech-to-text (OpenAI-compatible /audio/transcriptions, e.g. OmniRoute) when the video has no captions. source in the result is manual, auto or stt.',
  {
    url: z.string().describe('YouTube video URL'),
    lang: z.string().optional().describe('Caption language, default en'),
    maxChars: z.number().int().min(100).optional().describe('Truncate text to this many characters'),
    stt: z.enum(['auto', 'off', 'force']).optional().describe('auto (default): STT only if no captions; off: captions only; force: always transcribe the audio'),
  },
  async (args) => {
    try {
      return text(await getTranscript(args.url, { lang: args.lang, maxChars: args.maxChars, stt: args.stt }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

const safe = (fn: (a: any) => Promise<unknown> | unknown) => async (a: any) => {
  try { return text(await fn(a)); }
  catch (err) { return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] }; }
};

const MAX_FEED_IMAGES = 8;

server.tool('feed', 'Personal Instagram home feed as feed.v1 (owner bearer token required). Posts come in the order Instagram served them; pass next_cursor as cursor to keep scrolling. Every fetched post is stored. Status other than ok/end (auth_required, challenge, ...) means no posts, not an empty feed. With filter "jev" each post is scored first; only passing posts are returned (the rest are counted in filtered_out) and their screenshots follow the JSON as images, so look at them and record your call with feed_decide.', {
  provider: z.enum(['instagram']).default('instagram'),
  account: z.string().describe('Account name, [A-Za-z0-9._]{1,30}'),
  source: z.enum(['home']).default('home'),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().optional().describe('next_cursor from the previous page'),
  filter: z.enum(['jev']).optional().describe('Score posts with Jev and return only those worth a look, with screenshots'),
  include_filtered: z.boolean().optional().describe('With filter: also return posts that did not pass (no screenshots)'),
  order: z.enum(['feed', 'predicted']).optional().describe('predicted sorts by p_match (needs filter)'),
  exploration: z.number().min(0).max(1).optional().describe('Chance 0..1 that a below-threshold post passes anyway. Default 0'),
}, async (a: any) => {
  if (!ctx.personalAuthorized) return { isError: true, content: [{ type: 'text' as const, text: AUTH_REQUIRED_MESSAGE }] };
  try {
    const feed = await getFeed(a);
    const content: any[] = [{ type: 'text' as const, text: JSON.stringify(feed, null, 2) }];
    for (const it of feed.items as any[]) {
      if (content.length > MAX_FEED_IMAGES) break;
      const shot: string | undefined = it.filter?.passed ? it.render?.screenshot : undefined;
      if (!shot?.startsWith(ARTIFACT_URL_PREFIX)) continue;
      const png = readArtifact(personalDb(), shot.slice(ARTIFACT_URL_PREFIX.length));
      if (png) content.push({ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
  }
});

server.tool('feed_decide', "Record your judgement of a feed post (owner bearer token required). Stored with the feed run and the prediction shown. These are your guesses, not the owner's taste. Pass the same idempotency_key to retry safely.", {
  item_id: z.string().describe('item_id from the feed'),
  decision: z.enum(DECISIONS),
  reason: z.string().max(2000).optional(),
  idempotency_key: z.string().max(128).optional(),
}, async (a: any) => {
  if (!ctx.personalAuthorized) return { isError: true, content: [{ type: 'text' as const, text: AUTH_REQUIRED_MESSAGE }] };
  return safe((x) => feedDecide({ ...x, client: 'mcp' }))(a);
});

const denied = () => ({ isError: true, content: [{ type: 'text' as const, text: AUTH_REQUIRED_MESSAGE }] });

server.tool('personal_discover', "Ranked Melbourne events for the next N days from Humanitix and Eventbrite (gigs, film screenings, writing competitions, writing groups, book swaps/clubs, volunteering), scored by Jev against the owner's preferences (owner bearer token required). Returns numbered items with link, date (null when the page does not state it), venue, price, reason, uncertainty and delivery_id, plus failed_sources. After you message the owner, call personal_feedback with type 'shown' and the delivery_ids; pass the owner's reactions as personal_feedback too. Never books anything.", {
  intent: z.string().max(200).optional().describe('Why the owner wants discovery (recorded only). The owner\'s categories are always searched'),
  constraints: z.object({ days: z.number().int().min(1).max(90).optional(), radius_km: z.number().positive().max(1000).optional(), near: z.string().max(60).optional(), topic: z.string().max(60).optional().describe('Extra topic searched first, e.g. "jazz"') }).optional(),
  limit: z.number().int().min(1).max(30).default(10),
}, async (a: any) => {
  if (!ctx.personalAuthorized) return denied();
  return safe((x) => personalDiscover({ ...x, client: 'mcp' }))(a);
});

server.tool('personal_feedback', "Record the owner's reaction to a discovery item (owner bearer token required). Owner feedback is the truth label: like/save/want_to_go are positive, dislike is negative. not_now, too_far, too_expensive and anything scoped this_time are NOT lasting dislikes. type 'shown' (with delivery_id or delivery_ids) records that you actually delivered the items; returned is not shown. Reuse idempotency_key to retry safely.", {
  type: z.enum(['like', 'dislike', 'save', 'not_now', 'too_far', 'too_expensive', 'want_to_go', 'shown']),
  item_id: z.string().optional(), delivery_id: z.string().optional(), delivery_ids: z.array(z.string()).max(100).optional(),
  scope: z.enum(['this_time', 'item', 'creator', 'topic', 'venue']).optional().describe('Default: item (this_time for not_now/too_far/too_expensive). topic needs a reason naming the topic'),
  reason: z.string().max(1000).optional(), idempotency_key: z.string().max(128).optional(),
}, async (a: any) => {
  if (!ctx.personalAuthorized) return denied();
  return safe(recordFeedback)(a);
});

server.tool('personal_preferences', "Read the owner's preference summary (data-derived: Instagram authors, music artists, saved places, feedback, taste text) and explicit rules, or set a rule (owner bearer token required). action 'get' (default), 'rebuild' (recompute), 'set_rule' (rule prefer|avoid|exclude + subject_key), 'remove_rule' (rule_id). Explicit rules beat derived scores.", {
  action: z.enum(['get', 'rebuild', 'set_rule', 'remove_rule']).default('get'),
  rule: z.enum(['prefer', 'avoid', 'exclude']).optional(), subject_key: z.string().max(80).optional(),
  subject_type: z.string().max(24).optional().describe('keyword (default), topic, venue, creator, category'),
  valid_until: z.string().optional().describe('ISO date; the rule stops applying after it'), note: z.string().max(500).optional(), rule_id: z.string().optional(),
}, async (a: any) => {
  if (!ctx.personalAuthorized) return denied();
  return safe(personalPreferences)(a);
});

server.tool('web_crawl', 'Scrape up to 10 URLs to markdown (mode auto|plain|browser). actions (click/type/press/scroll/wait/wait_for) and stealth force the browser. PDF and Office URLs are converted to text.', {
  urls: z.array(z.string()), max_chars: z.number().int().optional(), mode: z.string().optional(),
  actions: z.array(z.record(z.any())).optional(), stealth: z.boolean().optional(),
}, safe(webCrawl));

server.tool('web_map', 'List URLs of a site from sitemap or page links. Fast, no content read.', {
  url: z.string(), limit: z.number().int().optional(), search: z.string().optional(), include_subdomains: z.boolean().optional(),
}, safe(webMap));

server.tool('web_crawl_start', 'Start a background site crawl: follow links from url, markdown per page. include/exclude are URL regexes. Poll with web_crawl_status.', {
  url: z.string(), max_pages: z.number().int().optional(), max_depth: z.number().int().optional(),
  include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(),
  include_subdomains: z.boolean().optional(), respect_robots: z.boolean().optional(),
  max_chars: z.number().int().optional(), mode: z.string().optional(), stealth: z.boolean().optional(),
}, safe(webCrawlStart));

server.tool('web_batch_start', 'Start a background batch crawl of up to 500 URLs; poll with web_crawl_status.', {
  urls: z.array(z.string()), max_chars: z.number().int().optional(), mode: z.string().optional(),
}, safe(webBatchStart));

server.tool('web_crawl_status', 'Progress (and optionally results) of a background crawl job.', {
  job_id: z.string(), include_results: z.boolean().optional(), offset: z.number().int().optional(), limit: z.number().int().optional(),
}, safe((a) => webCrawlStatus(a.job_id, a.include_results ?? false, a.offset ?? 0, a.limit ?? 10)));

server.tool('browse', 'Goal-driven multi-step browsing via the external Jev runner.', {
  url: z.string(), goal: z.string(), max_seconds: z.number().int().optional(),
}, safe(browse));

server.tool('web_agent_run', 'TinyFish-style agent: url + goal to JSON, escalating fetch -> browse -> deep agent -> TinyFish (when keyed). Returns {status,result,steps,escalated_to,sources}.', {
  url: z.string(), goal: z.string(), schema: z.record(z.any()).optional(),
  mode: z.enum(['auto', 'fetch', 'browse', 'deep', 'tinyfish']).optional(), max_steps: z.number().int().optional(), timeout_s: z.number().int().optional(),
}, safe((a) => runAgent(a)));

server.tool('extract', 'Extract structured data from URLs into a JSON Schema; validated, null for unknowns.', {
  urls: z.array(z.string()), schema: z.record(z.any()), instructions: z.string().optional(),
}, safe(extract));

server.tool('research_vault', 'Search/read/save reusable evidence in the Feynman vault (action: status|search|read|save|add_claim|search_claims).', {
  action: z.string(), query: z.string().optional(), note_id: z.string().optional(), title: z.string().optional(),
  body: z.string().optional(), source: z.string().optional(), tags: z.array(z.string()).optional(), limit: z.number().int().optional(),
  claim: z.string().optional(), quoted_support: z.string().optional(), confidence: z.string().optional(),
  evidence_type: z.string().optional(), stance_target: z.string().optional(), stance: z.string().optional(),
  run_id: z.string().optional(), ranked: z.boolean().optional(),
}, safe(researchVault));

server.tool('save_to_wiki', 'Save gathered web material or a completed deep-research job to the owner\'s brain wiki inbox (~/brain/wiki/inbox/) as a proposal. kind: "note" (summary, key points, details, gaps, related, sources). Give urls (read for you), text (research already gathered) or a question (researched first); or a completed deep-research job_id to file its cited report unchanged. Provide either job_id or urls/text/question.', {
  kind: z.string().default('note'), urls: z.array(z.string()).nullable().default(null), text: z.string().default(''),
  question: z.string().default(''), title: z.string().default(''), target: z.string().default(''), job_id: z.string().default(''),
}, safe(saveToBrainWiki));

server.tool('run_log', 'Recent phrog-web run-log records (MCP and REST calls: duration, ok, provider info), newest first. Optional tool filter.', {
  limit: z.number().int().default(50), tool: z.string().optional(),
}, safe(({ limit, tool }: any) => recentRuns(limit, tool)));

// Compat tools: same names/args/defaults as the old Python `web` MCP.
server.tool('web_search', 'Search the self-hosted SearXNG metasearch instance. time_range: day|week|month|year. language: e.g. "en". categories: e.g. "science", "it", "news", "images". Local-intent queries ("near me", "best cafe") get the saved location or `near` added.', {
  query: z.string(), limit: z.number().int().default(5), time_range: z.string().nullable().default(null),
  language: z.string().nullable().default(null), categories: z.string().nullable().default(null),
  near: z.string().nullable().default(null),
}, safe(async (a: any) => {
  const { near, ...rest } = a;
  return webSearch({ ...rest, query: localizeQuery(rest.query, await resolveLocation(near ?? undefined)) });
}));

server.tool('research_search', 'Free key-less research APIs queried in parallel. preset: academic | tech | all; or pass sources (openalex, arxiv, semantic_scholar, crossref, wikipedia, hackernews, stackexchange).', {
  query: z.string(), preset: z.string().default('academic'), sources: z.array(z.string()).nullable().default(null),
  limit: z.number().int().default(3), stackexchange_site: z.string().default('stackoverflow'),
}, safe(researchSearch));

server.tool('deep_research_start', 'Start SLOW, staged deep research in Feynman. Returns a job_id for status polling. workflow: deepresearch | lit | compare | review | audit | summarize | recipe | draft. Poll with deep_research_status no more often than its poll_after_s (minutes, not seconds). Do not also start `research` for the same question.', {
  topic: z.string(), workflow: z.string().default('deepresearch'), profile: z.string().default('full'), tier: z.string().default('pending'),
  budget_usd: z.number().nullable().default(null), register: z.string().nullable().default(null),
  inference_depth: z.string().nullable().default(null), domain_notes: z.string().nullable().default(null),
}, safe(deepResearchStart));

server.tool('deep_research_status', 'Progress of a deep research job. When status is completed, include_result=True returns the cited markdown.', {
  job_id: z.string(), include_result: z.boolean().default(false),
}, safe(deepResearchStatus));

server.tool('deep_research_resume', 'Resume an interrupted Feynman run from its durable checkpoint and first unfinished stage.', {
  run_id: z.string(),
}, safe(deepResearchResume));

return server;
}

// Stdio entry: `node dist/adapters/mcp/server.js`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createMcpServer({ personalAuthorized: stdioAuthorized() }).connect(new StdioServerTransport());
}
