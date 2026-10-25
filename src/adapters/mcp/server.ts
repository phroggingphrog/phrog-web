import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeSearch } from '../../providers/search.js';
import { executeFetch } from '../../providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from '../../providers/research.js';
import { searchGithubRepos } from '../../providers/github.js';
import { askDeepWiki, getDeepWikiStructure } from '../../providers/deepwiki.js';
import { saveToWiki, searchWiki } from '../../wiki/vault.js';

const server = new McpServer({
  name: 'phrog-web',
  version: '0.1.0',
});

// Helper for MCP text response
const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

// 1. Quick Search
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

// 2. Academic Search (Consensus + arXiv)
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

// 3. Live Search
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

// 4. Deep Search (Domain-Agnostic by default)
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

// 5. Clean Fetch
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

// 6. Universal Research (Vane Quick + Feynman Staged Workflows)
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

// 7. Dedicated Literature Review (Feynman Lit Workflow)
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

// 8. Research Status
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

// 9. GitHub Repository Search
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

// 10. DeepWiki Q&A
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

// 11. DeepWiki Table of Contents
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

// 12. Save to LLM Wiki (Karpathy Agnostic Knowledge Vault)
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

// 13. Semantic Search LLM Wiki
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

// Run stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
