import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { executeSearch } from '../../providers/search.js';
import { executeFetch } from '../../providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from '../../providers/research.js';
import { searchGithubRepos } from '../../providers/github.js';
import { askDeepWiki, getDeepWikiStructure } from '../../providers/deepwiki.js';
import { searchMedia } from '../../providers/media.js';
import { searchBooks, downloadBook } from '../../providers/books.js';
import { searchSocial } from '../../providers/social.js';
import { getTranscript } from '../../providers/transcript.js';
import { webCrawl, webMap, webBatchStart, webCrawlStatus, webCrawlStart } from '../../providers/crawl.js';
import { browse } from '../../providers/browse.js';
import { extract } from '../../providers/extract.js';
import { researchVault } from '../../providers/vault.js';
import { researchSearch } from '../../providers/sources.js';
import { webSearch, deepResearchStart, deepResearchStatus, deepResearchResume } from '../../providers/compat.js';
import { saveToWiki, searchWiki } from '../../wiki/vault.js';

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

export function createMcpServer(): McpServer {
const server = new McpServer({ name: 'phrog-web', version: '0.1.0' });

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
          pollInstruction: `Call research_status with jobId "${job.jobId}" to inspect progress.`,
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
  'wiki_save',
  'Distill and save research findings or notes into the LLM Wiki (Karpathy markdown vault) with automatic vector embedding and frontmatter.',
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
  'Fetch the transcript of a YouTube video (manual or auto captions).',
  {
    url: z.string().describe('YouTube video URL'),
    lang: z.string().optional().describe('Caption language, default en'),
    maxChars: z.number().int().min(100).optional().describe('Truncate text to this many characters'),
  },
  async (args) => {
    try {
      return text(await getTranscript(args.url, { lang: args.lang, maxChars: args.maxChars }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

const safe = (fn: (a: any) => Promise<unknown> | unknown) => async (a: any) => {
  try { return text(await fn(a)); }
  catch (err) { return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] }; }
};

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

server.tool('save_to_wiki', 'Alias of wiki_save: save a note into the LLM Wiki.', {
  title: z.string(), content: z.string(), tags: z.array(z.string()).optional(), source: z.string().optional(),
}, safe(async ({ title, content, tags, source }) => ({ message: 'Note saved and vector-indexed in wiki vault', note: await saveToWiki(title, content, { tags, source }) })));


// Compat tools: same names/args/defaults as the old Python `web` MCP.
server.tool('web_search', 'Search the self-hosted SearXNG metasearch instance. time_range: day|week|month|year. language: e.g. "en". categories: e.g. "science", "it", "news".', {
  query: z.string(), limit: z.number().int().default(5), time_range: z.string().nullable().default(null),
  language: z.string().nullable().default(null), categories: z.string().nullable().default(null),
}, safe(webSearch));

server.tool('research_search', 'Free key-less research APIs queried in parallel. preset: academic | tech | all; or pass sources (openalex, arxiv, semantic_scholar, crossref, wikipedia, hackernews, stackexchange).', {
  query: z.string(), preset: z.string().default('academic'), sources: z.array(z.string()).nullable().default(null),
  limit: z.number().int().default(3), stackexchange_site: z.string().default('stackoverflow'),
}, safe(researchSearch));

server.tool('deep_research_start', 'Start SLOW, staged deep research in Feynman. Returns a job_id for status polling. workflow: deepresearch | lit | compare | review | audit | summarize | recipe | draft. Poll with deep_research_status.', {
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
  await createMcpServer().connect(new StdioServerTransport());
}
