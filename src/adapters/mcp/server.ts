import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeSearch } from '../../providers/search.js';
import { executeFetch } from '../../providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from '../../providers/research.js';

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

// 2. Live Search
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

// 3. Deep Search
server.tool(
  'deep_search',
  'Multi-category search aggregating general web, tech/code repositories (GitHub), and academic literature (arXiv).',
  {
    query: z.string().describe('Technical or academic search query'),
    limit: z.number().int().min(1).max(30).optional().describe('Maximum results to return'),
  },
  async ({ query, limit }) => {
    try {
      const res = await executeSearch(query, { mode: 'deep', limit });
      return text(res);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

// 4. Clean Fetch
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

// 5. Research
server.tool(
  'research',
  'Research a topic. Quick mode synthesizes answers in 3-5s (Vane). Deep mode dispatches an autonomous background agent (Feynman).',
  {
    question: z.string().describe('Research question or topic'),
    mode: z.enum(['quick', 'deep']).default('quick').describe('Research depth/mode'),
    callback_url: z.string().url().optional().describe('Optional webhook URL to receive deep research results upon completion'),
  },
  async ({ question, mode, callback_url }) => {
    try {
      if (mode === 'quick') {
        const res = await executeQuickResearch(question);
        return text(res);
      } else {
        const job = dispatchDeepResearch(question, { callbackUrl: callback_url });
        return text({
          message: 'Autonomous Feynman deep research job dispatched.',
          jobId: job.jobId,
          status: job.status,
          pollInstruction: `Call research_status with jobId "${job.jobId}" to inspect progress.`,
        });
      }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  }
);

// 6. Research Status
server.tool(
  'research_status',
  'Check the status and deliverable of a background Feynman deep research job.',
  {
    jobId: z.string().describe('Job ID returned by research with mode="deep"'),
  },
  async ({ jobId }) => {
    const job = getResearchJob(jobId);
    if (!job) {
      return { isError: true, content: [{ type: 'text', text: `Research job "${jobId}" not found` }] };
    }
    return text(job);
  }
);

// Run stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
