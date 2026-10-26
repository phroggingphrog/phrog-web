import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { executeSearch, SearchOptions } from './providers/search.js';
import { executeFetch, FetchOptions } from './providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from './providers/research.js';
import { searchGithubRepos } from './providers/github.js';
import { askDeepWiki, getDeepWikiStructure } from './providers/deepwiki.js';
import { searchMedia, MediaType } from './providers/media.js';
import { setupDone } from './setup.js';
import { searchBooks, downloadBook, type BookSource } from './providers/books.js';
import { searchDeals } from './providers/ozbargain.js';
import { searchPlaces } from './providers/places.js';
import { searchSecondhand, secondhandListing, searchAliexpress, aliexpressProduct, type SecondhandMarket } from './providers/marketplace.js';
import { searchSocial } from './providers/social.js';
import { getTranscript } from './providers/transcript.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './adapters/mcp/server.js';
import { webCrawl, webMap, webBatchStart, webCrawlStatus, webCrawlStart } from './providers/crawl.js';
import { browse } from './providers/browse.js';
import { extract } from './providers/extract.js';
import { runAgent } from './providers/agent.js';
import { researchVault } from './providers/vault.js';
import { saveToWiki, searchWiki } from './wiki/vault.js';
import { writeRun, recentRuns, summarize, resultInfo, shortError } from './runlog.js';
import { registerSearxngCompat } from './searxng-compat.js';

const config = loadConfig();
const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });

// Run log: one JSON-lines record per /api/* call (payload captured in onSend for size/provider info).
fastify.addHook('onSend', async (req: any, reply, payload) => {
  if (req.url.startsWith('/api/')) {
    req.runInfo = { bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : 0 };
    if (typeof payload === 'string' && payload.length < 2_000_000) {
      Object.assign(req.runInfo, resultInfo(payload));
      if (reply.statusCode >= 400) { try { req.runInfo.error = shortError(JSON.parse(payload).error ?? payload); } catch { req.runInfo.error = shortError(payload); } }
    }
  }
  return payload;
});
fastify.addHook('onResponse', async (req: any, reply) => {
  const route = req.routeOptions?.url ?? req.url.split('?')[0];
  if (!route.startsWith('/api/') || route === '/api/runs') return;
  const args = req.method === 'GET' ? req.query : req.body;
  const { bytes, ...info } = req.runInfo ?? {};
  writeRun({ kind: 'rest', tool: `${req.method} ${route}`, args: summarize(args), status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime), ok: reply.statusCode < 400, ...info, result_bytes: bytes ?? 0 });
});

fastify.get('/api/runs', async (req) => {
  const q = req.query as { limit?: string; tool?: string };
  return { runs: recentRuns(q.limit ? parseInt(q.limit, 10) : 50, q.tool) };
});

fastify.get('/health', async () => ({ status: 'ok', service: 'phrog-web', version: '0.1.0' }));

registerSearxngCompat(fastify);

fastify.get('/api/search', async (req, reply) => {
  const query = req.query as {
    q?: string;
    query?: string;
    mode?: 'quick' | 'live' | 'deep';
    categories?: string;
    time_range?: 'day' | 'week' | 'month' | 'year';
    limit?: string;
    provider?: string;
  };

  const searchQuery = query.q || query.query;
  if (!searchQuery) {
    return reply.status(400).send({ error: 'Query parameter "q" or "query" is required' });
  }

  const options: SearchOptions = {
    mode: query.mode,
    categories: query.categories ? query.categories.split(',') : undefined,
    timeRange: query.time_range,
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    provider: query.provider,
  };

  try {
    const results = await executeSearch(searchQuery, options);
    return results;
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/fetch', async (req, reply) => {
  const body = req.body as {
    url?: string;
    urls?: string[];
    mode?: 'plain' | 'browser' | 'auto';
    provider?: string;
    max_chars?: number;
  };

  const targetUrl = body.url || (Array.isArray(body.urls) ? body.urls[0] : undefined);
  if (!targetUrl) {
    return reply.status(400).send({ error: 'Body field "url" or "urls" is required' });
  }

  const options: FetchOptions = {
    mode: body.mode,
    provider: body.provider,
    maxChars: body.max_chars,
  };

  try {
    const result = await executeFetch(targetUrl, options);
    return result;
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/research', async (req, reply) => {
  const body = req.body as {
    question?: string;
    topic?: string;
    mode?: 'quick' | 'deep';
    domain?: 'web' | 'academic' | 'discussions' | 'all';
    workflow?: string;
    callback_url?: string;
    instructions?: string;
  };

  const prompt = body.question || body.topic;
  if (!prompt) {
    return reply.status(400).send({ error: 'Field "question" or "topic" is required' });
  }

  const mode = body.mode || 'quick';

  if (mode === 'quick') {
    try {
      const quickResult = await executeQuickResearch(prompt, { domain: body.domain, instructions: body.instructions });
      return quickResult;
    } catch (err) {
      req.log.error(err);
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    const job = dispatchDeepResearch(prompt, {
      workflow: body.workflow,
      callbackUrl: body.callback_url,
    });
    return reply.status(202).send({
      message: 'Deep research task dispatched to autonomous Feynman agent',
      job,
    });
  }
});

fastify.get('/api/research/:jobId', async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  const job = getResearchJob(jobId);
  if (!job) {
    return reply.status(404).send({ error: `Research job "${jobId}" not found` });
  }
  return job;
});

fastify.get('/api/github/search', async (req, reply) => {
  const { q, query, limit } = req.query as { q?: string; query?: string; limit?: string };
  const target = q || query;
  if (!target) {
    return reply.status(400).send({ error: 'Query parameter "q" or "query" is required' });
  }
  try {
    const res = await searchGithubRepos(target, limit ? parseInt(limit, 10) : 10);
    return res;
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Media, books, social, transcripts
fastify.get('/api/media', async (req, reply) => {
  const { q, type, limit } = req.query as { q?: string; type?: string; limit?: string };
  if (!q || !type || !['book', 'film', 'music'].includes(type)) {
    return reply.status(400).send({ error: 'Missing or invalid parameters for /api/media' });
  }
  try {
    return await searchMedia(q, type as MediaType, { limit: limit ? parseInt(limit, 10) : undefined });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/places', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.q) return reply.status(400).send({ error: 'Missing q' });
  try {
    return await searchPlaces(q.q, { limit: q.limit ? parseInt(q.limit, 10) : undefined });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/deals', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  try {
    return await searchDeals(q.q, { limit: q.limit ? parseInt(q.limit, 10) : undefined, includeExpired: q.expired !== 'false' });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/secondhand', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.q && !q.id) return reply.status(400).send({ error: 'Provide q (search) or id+marketplace (listing)' });
  try {
    if (q.id && q.marketplace) return await secondhandListing(q.id, q.marketplace as SecondhandMarket);
    return await searchSecondhand(q.q!, {
      marketplaces: q.marketplaces ? (q.marketplaces.split(',') as SecondhandMarket[]) : undefined,
      location: q.location,
      minPrice: q.min_price ? Number(q.min_price) : undefined,
      maxPrice: q.max_price ? Number(q.max_price) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/marketplace', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.q && !q.product) return reply.status(400).send({ error: 'Provide q (search) or product (id/URL)' });
  try {
    if (q.product) return await aliexpressProduct(q.product, q.reviews ? parseInt(q.reviews, 10) : undefined);
    return await searchAliexpress(q.q!, q.limit ? parseInt(q.limit, 10) : undefined);
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/books', async (req, reply) => {
  const { q, limit } = req.query as { q?: string; limit?: string };
  if (!q) {
    return reply.status(400).send({ error: 'Missing or invalid parameters for /api/books' });
  }
  try {
    return await searchBooks(q, { limit: limit ? parseInt(limit, 10) : undefined });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/books/download', async (req, reply) => {
  const b = (req.body || {}) as { ref?: string; md5?: string; id?: string; source?: BookSource };
  const ref = b.ref || b.md5 || b.id;
  if (!ref) return reply.status(400).send({ error: 'Provide ref (from /api/books), md5 or id' });
  try {
    return await downloadBook(String(ref), { source: b.source });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/social', async (req, reply) => {
  const { q, sources, limit, time_range } = req.query as { q?: string; sources?: string; limit?: string; time_range?: string };
  if (!q) {
    return reply.status(400).send({ error: 'Missing or invalid parameters for /api/social' });
  }
  try {
    return await searchSocial(q, {
      sources: sources ? sources.split(',').map(x => x.trim()).filter(Boolean) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      timeRange: time_range as 'day' | 'week' | 'month' | 'year' | undefined,
    });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/transcript', async (req, reply) => {
  const { url, lang, max_chars } = (req.body || {}) as { url?: string; lang?: string; max_chars?: number };
  if (!url) {
    return reply.status(400).send({ error: 'Missing or invalid parameters for /api/transcript' });
  }
  try {
    return await getTranscript(url, { lang, maxChars: max_chars });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/deepwiki/ask', async (req, reply) => {
  const { repo, question } = req.body as { repo?: string; question?: string };
  if (!repo || !question) {
    return reply.status(400).send({ error: 'Both "repo" (e.g. owner/repo) and "question" are required' });
  }
  try {
    const res = await askDeepWiki(repo, question);
    return res;
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/deepwiki/structure', async (req, reply) => {
  const { repo } = req.query as { repo?: string };
  if (!repo) {
    return reply.status(400).send({ error: 'Query parameter "repo" (e.g. owner/repo) is required' });
  }
  try {
    const res = await getDeepWikiStructure(repo);
    return res;
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/wiki/save', async (req, reply) => {
  const { title, content, tags, source } = req.body as {
    title?: string;
    content?: string;
    tags?: string[];
    source?: string;
  };
  if (!title || !content) {
    return reply.status(400).send({ error: 'Both "title" and "content" are required' });
  }
  try {
    const note = await saveToWiki(title, content, { tags, source });
    return {
      message: 'Note saved to wiki and vector-indexed',
      note,
    };
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/wiki/search', async (req, reply) => {
  const { q, query, limit } = req.query as { q?: string; query?: string; limit?: string };
  const target = q || query;
  if (!target) {
    return reply.status(400).send({ error: 'Query parameter "q" or "query" is required' });
  }
  try {
    const results = await searchWiki(target, limit ? parseInt(limit, 10) : 5);
    return {
      query: target,
      results,
      total: results.length,
    };
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Web-agent parity routes
const wrap = (fn: (b: any) => Promise<unknown> | unknown, required: string[]) => async (req: any, reply: any) => {
  const b = (req.body ?? {}) as Record<string, any>;
  const missing = required.filter((k) => b[k] === undefined || b[k] === null || b[k] === '');
  if (missing.length) return reply.status(400).send({ error: `Missing required: ${missing.join(', ')}` });
  try { return await fn(b); }
  catch (err) { req.log.error(err); return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) }); }
};
fastify.post('/api/crawl', wrap(webCrawl, ['urls']));
fastify.post('/api/map', wrap(webMap, ['url']));
fastify.post('/api/batch', wrap(webBatchStart, ['urls']));
fastify.post('/api/crawl/start', wrap(webCrawlStart, ['url']));
fastify.get('/api/batch/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const q = req.query as { include_results?: string; offset?: string; limit?: string };
  if (!id) return reply.status(400).send({ error: 'id is required' });
  try {
    return webCrawlStatus(id, ['1', 'true'].includes(q.include_results ?? ''), Number(q.offset ?? 0), Number(q.limit ?? 10));
  } catch (err) { return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) }); }
});
fastify.post('/api/agent', async (req, reply) => {
  try {
    return await runAgent(req.body as any);
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/agent/stream', async (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: Record<string, any>) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await runAgent(req.body as any, send);
  } catch (err) {
    send({ type: 'ERROR', error: err instanceof Error ? err.message : String(err) });
  }
  reply.raw.end();
});

fastify.post('/api/browse', wrap(browse as any, ['url', 'goal']));
fastify.post('/api/extract', wrap(extract as any, ['urls', 'schema']));
fastify.post('/api/vault', wrap(researchVault as any, ['action']));

// Streamable HTTP MCP (stateless: one server+transport per request, like the Python web MCP)
const mcpHandler = async (req: any, reply: any) => {
  const t0 = Date.now();
  reply.raw.on('finish', () => {
    if (reply.raw.statusCode >= 400) {
      const b = req.body;
      writeRun({ kind: 'rest', tool: `${req.method} /mcp`, args: summarize({ rpc_method: b?.method, id: b?.id, accept: req.headers.accept, content_type: req.headers['content-type'], protocol: req.headers['mcp-protocol-version'], has_session: !!req.headers['mcp-session-id'] }), status: reply.raw.statusCode, duration_ms: Date.now() - t0, ok: false, error: `HTTP ${reply.raw.statusCode} on /mcp` });
    }
  });
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  reply.hijack();
  reply.raw.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  } catch (err) {
    req.log.error(err);
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
};
fastify.post('/mcp', mcpHandler);
fastify.get('/mcp', mcpHandler);
fastify.delete('/mcp', mcpHandler);

const port = Number(process.env.PORT || config.server.port || 8890);
const host = config.server.host || '127.0.0.1';

try {
  await fastify.listen({ port, host });
  console.log(`Phrog Web Gateway listening on http://${host}:${port}`);
  if (!setupDone()) console.log('Run `pnpm setup` to enable books, ratings and X');
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
