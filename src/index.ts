import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { executeSearch, SearchOptions } from './providers/search.js';
import { registerSearchRoute } from './providers/search-route.js';
import { executeFetch, FetchOptions } from './providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob, resumeDeepResearchJob, enrichResearchJob, cancelDeepResearchJob } from './providers/research.js';
import { searchGithubRepos, downloadGithubRepo, fetchGithubPatch } from './providers/github.js';
import { askDeepWiki, getDeepWikiStructure, readDeepWikiContents } from './providers/deepwiki.js';
import { searchMedia, MediaType } from './providers/media.js';
import { setupDone } from './setup.js';
import { keyStatus, removeKey, setKey, keysOverview } from './provider-keys.js';
import { checkMonitor, closeBrowserSession, createBrowserSession, createMonitor, listMonitors, parseDocument } from './providers/cookbook.js';
import { deleteJar, fetchWithProfile, listJars, writeJar } from './providers/profiles.js';
import { scrape, shotsDir } from './providers/scrape.js';
import { searchBooks, downloadBook, type BookSource } from './providers/books.js';
import { searchDeals } from './providers/ozbargain.js';
import { searchPlaces } from './providers/places.js';
import { visualSearch, getTempImage } from './providers/visual.js';
import { resolveLocation, localizeQuery } from './location.js';
import { searchSecondhand, secondhandListing, searchAliexpress, aliexpressProduct, type SecondhandMarket } from './providers/marketplace.js';
import { searchSocial } from './providers/social.js';
import { getTranscript } from './providers/transcript.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './adapters/mcp/server.js';
import { webCrawl, webMap, webBatchStart, webCrawlStatus, webCrawlStart } from './providers/crawl.js';
import { extract } from './providers/extract.js';
import { runAgent } from './providers/agent.js';
import { CAPABILITIES } from './capabilities.js';
import { buildOpenApi, renderDocsHtml } from './openapi.js';
import { readRunLog, summarizeRuns } from './usage.js';
import { cacheStats, cacheClear } from './cache.js';
import { authMode, createClient, listClients, resolveToken, revokeClient, tokenFromHeaders } from './clients.js';
import { enterClient } from './context.js';
import { researchVault } from './providers/vault.js';
import { saveToWiki, searchWiki } from './wiki/vault.js';
import { writeRun, recentRuns, summarize, resultInfo, shortError } from './runlog.js';
import { registerSearxngCompat } from './searxng-compat.js';
import { registerPersonalRoutes, isPersonalRoute } from './personalization/routes.js';

const config = loadConfig();
const fastify = Fastify({ logger: true });

// Record every registration so /openapi.json documents what the router actually serves.
const registeredRoutes: { method: string; url: string }[] = [];
fastify.addHook('onRoute', (route) => {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) registeredRoutes.push({ method, url: route.url });
});

await fastify.register(cors, { origin: true });

// Run log: one JSON-lines record per /api/* call (payload captured in onSend for size/provider info).
fastify.addHook('onSend', async (req: any, reply, payload) => {
  if (isPersonalRoute(req.url)) {
    // Personal routes: log counts and status only, never captions, cursors or tokens.
    req.runInfo = { bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : 0 };
    if (typeof payload === 'string' && reply.statusCode < 400) {
      try { const o = JSON.parse(payload); req.runInfo.feed_status = o.status; req.runInfo.items = Array.isArray(o.items) ? o.items.length : 0; } catch { /* not JSON */ }
    } else if (reply.statusCode >= 400) req.runInfo.error = `HTTP ${reply.statusCode}`;
  } else if (req.url.startsWith('/api/')) {
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
  const personal = isPersonalRoute(route);
  const args = personal ? { account: req.query?.account, limit: req.query?.limit, has_cursor: !!req.query?.cursor } : req.method === 'GET' ? req.query : req.body;
  const { bytes, ...info } = req.runInfo ?? {};
  writeRun({ kind: 'rest', tool: `${req.method} ${route}`, args: summarize(args), status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime), ok: reply.statusCode < 400, ...info, result_bytes: bytes ?? 0 });
});

fastify.get('/api/runs', async (req) => {
  const q = req.query as { limit?: string; tool?: string };
  return { runs: recentRuns(q.limit ? parseInt(q.limit, 10) : 50, q.tool) };
});

fastify.get('/health', async () => ({ status: 'ok', service: 'phrog-web', version: '0.1.0' }));

// --- The hub's key store -------------------------------------------------------------------
// Every upstream provider key lives in one env file (mode 0600) and nowhere else. Callers hold
// only phrog-web's own token; these routes are how a key is added or rotated without a restart.
// Values are never returned: GET reports configured/length only.
fastify.get('/api/keys', async () => ({ keys: keyStatus() }));

fastify.post('/api/keys', async (req, reply) => {
  const body = (req.body ?? {}) as { key?: string; value?: string };
  if (!body.key || !body.value) return reply.code(400).send({ error: 'key and value are required' });
  try {
    const status = setKey(body.key, body.value);
    return reply.send({ saved: true, key: status.key, provider: status.provider, configured: status.configured, length: status.length });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.delete('/api/keys/:key', async (req, reply) => {
  try {
    const removed = removeKey((req.params as { key: string }).key);
    return reply.send({ removed });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Which plan paid for the last TinyFish call is useful at the hub level too, so a caller can see
// free-vs-paid without reading a bill.
fastify.get('/api/keys/status', async () => keysOverview());


registerSearxngCompat(fastify);
registerPersonalRoutes(fastify);

registerSearchRoute(fastify);


fastify.get('/api/search', async (req, reply) => {
  const query = req.query as {
    q?: string;
    query?: string;
    mode?: 'quick' | 'live' | 'deep';
    categories?: string;
    time_range?: 'day' | 'week' | 'month' | 'year';
    limit?: string;
    provider?: string;
    near?: string;
  };

  const raw = query.q || query.query;
  const searchQuery = raw ? localizeQuery(raw, await resolveLocation(query.near)) : raw;
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
    cache?: boolean;
  };

  const targetUrl = body.url || (Array.isArray(body.urls) ? body.urls[0] : undefined);
  if (!targetUrl) {
    return reply.status(400).send({ error: 'Body field "url" or "urls" is required' });
  }

  const options: FetchOptions = {
    mode: body.mode,
    provider: body.provider,
    maxChars: body.max_chars,
    cache: body.cache,
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
    let job;
    try {
      job = dispatchDeepResearch(prompt, {
        workflow: body.workflow,
        callbackUrl: body.callback_url,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(message.startsWith('Unknown workflow') ? 400 : 502).send({ error: message });
    }
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
  // Report Feynman's own run state when we have a run id, so progress is not our guess.
  return enrichResearchJob(job);
});

// Stop a run and record who stopped it; killing the recorded pid alone leaves the worker alive.
fastify.post('/api/research/:jobId/cancel', async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  try {
    const job = await cancelDeepResearchJob(jobId);
    return reply.status(202).send({ message: 'Deep research cancelled', job });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'NOT_FOUND') return reply.status(404).send({ error: (err as Error).message });
    return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Resume a run from Feynman's durable checkpoint (first unfinished stage), after a restart or failure.
fastify.post('/api/research/:jobId/resume', async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  try {
    const job = await resumeDeepResearchJob(jobId);
    // A named workflow has no Feynman manifest, so it restarts: the message must not claim a checkpoint.
    const restarted = job.resumed_mode === 'restart';
    return reply.status(202).send({
      message: restarted
        ? `Workflow "${job.workflow}" has no checkpoint, so it restarts from the beginning`
        : 'Deep research resumed from its first unfinished stage',
      resumed_mode: job.resumed_mode,
      job,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'NOT_FOUND') return reply.status(404).send({ error: (err as Error).message });
    return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
  }
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

// Short-lived photo links for Bing Visual Search (see providers/visual.ts). Unknown or expired tokens are 404.
fastify.get('/i/:token', async (req, reply) => {
  const img = getTempImage((req.params as { token: string }).token);
  if (!img) return reply.status(404).send('not found');
  return reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').type(img.type).send(img.body);
});

fastify.post('/api/visual', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
  const b = (req.body || {}) as { image?: string; hint?: string; shop?: boolean; limit?: number; near?: string };
  if (!b.image) return reply.status(400).send({ error: 'Provide image (URL, file path or data:image/ URL)' });
  try {
    return await visualSearch(b.image, b);
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/places', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.q) return reply.status(400).send({ error: 'Missing q' });
  try {
    return await searchPlaces(q.q, { limit: q.limit ? parseInt(q.limit, 10) : undefined, near: q.near });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/deals', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  try {
    return await searchDeals(q.q, { limit: q.limit ? parseInt(q.limit, 10) : undefined, includeExpired: q.expired !== 'false', near: q.near });
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
      radiusKm: q.radius_km ? Number(q.radius_km) : undefined,
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

fastify.post('/api/github/download', async (req, reply) => {
  const b = (req.body || {}) as { repo?: string; ref?: string; extract?: boolean };
  if (!b.repo) return reply.status(400).send({ error: '"repo" (owner/repo) is required' });
  try {
    return await downloadGithubRepo(b.repo, { ref: b.ref, extract: b.extract });
  } catch (err) {
    req.log.error(err);
    return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/github/patch', async (req, reply) => {
  const q = req.query as { repo?: string; number?: string; kind?: string; max_chars?: string };
  if (!q.repo || !q.number) return reply.status(400).send({ error: '"repo" and "number" are required' });
  try {
    return await fetchGithubPatch(
      q.repo,
      Number(q.number),
      q.kind === 'patch' ? 'patch' : 'diff',
      q.max_chars ? Number(q.max_chars) : undefined,
    );
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
  const { url, lang, max_chars, stt } = (req.body || {}) as { url?: string; lang?: string; max_chars?: number; stt?: 'auto' | 'off' | 'force' };
  if (!url) {
    return reply.status(400).send({ error: 'Missing or invalid parameters for /api/transcript' });
  }
  try {
    return await getTranscript(url, { lang, maxChars: max_chars, stt });
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

fastify.get('/api/deepwiki/read', async (req, reply) => {
  const { repo, max_chars } = req.query as { repo?: string; max_chars?: string };
  if (!repo) {
    return reply.status(400).send({ error: 'Query parameter "repo" (e.g. owner/repo) is required' });
  }
  try {
    return await readDeepWikiContents(repo, max_chars ? Number(max_chars) : undefined);
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

// browse is only ever agent mode=browse, so it delegates rather than keeping a second code path.
fastify.post('/api/browse', async (req, reply) => {
  const body = (req.body ?? {}) as { url?: string; goal?: string; max_seconds?: number };
  if (!body.url || !body.goal) return reply.code(400).send({ error: 'url and goal are required' });
  try {
    const r = await runAgent({ url: body.url, goal: body.goal, mode: 'browse', timeout_s: body.max_seconds ?? 90 });
    return reply.code(r.status === 'COMPLETED' ? 200 : 502).send(r);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});
fastify.post('/api/extract', wrap(extract as any, ['urls', 'schema']));

// --- Cookbook surface: the Firecrawl/TinyFish capability set, with the gaps filled -----------
// One endpoint that documents the others, so a client can discover the whole surface at once.
fastify.get('/api/cookbook', async () => ({
  service: 'phrog-web',
  capabilities: CAPABILITIES,
}));


// --- Machine-readable surface -----------------------------------------------------------------
// Generated from the live router plus the capability table, so it cannot drift from what runs.
fastify.get('/openapi.json', async () => buildOpenApi(registeredRoutes, CAPABILITIES));

// What the service can actually account for. Per endpoint, not per client: loopback /mcp has no identity.
fastify.get('/api/usage', async (req) => {
  const { days } = req.query as { days?: string };
  const parsed = days ? Number(days) : 7;
  return summarizeRuns(readRunLog(), { days: Number.isFinite(parsed) ? parsed : 7 });
});
fastify.get('/docs', async (_req, reply) => reply.type('text/html; charset=utf-8').send(renderDocsHtml()));

// --- Client identity ---------------------------------------------------------------------------
// Which callers exist, and which doors they must pass. Management is loopback REST only: a token holder
// must not be able to mint more tokens, so this is deliberately NOT an MCP tool.
fastify.get('/api/clients', async () => ({ mode: authMode(), clients: listClients() }));
fastify.post('/api/clients', async (req, reply) => {
  try {
    // The token is in this response and nowhere else, ever.
    return createClient((req.body as { name?: string })?.name ?? '');
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});
fastify.delete('/api/clients/:name', async (req, reply) => {
  const name = (req.params as { name: string }).name;
  return revokeClient(name) ? { revoked: name } : reply.status(404).send({ error: `No such client "${name}"` });
});

// --- Page cache: what repeat reads cost, and how to clear it ---------------------------------
fastify.get('/api/cache', async () => cacheStats());
fastify.delete('/api/cache', async () => ({ cleared: cacheClear() }));

// --- Login state: per-site cookie jars exported from the persistent Chromium profile ---------
// crawl4ai's API refuses storage_state/user_data_dir/use_persistent_context per request, so a
// logged-in fetch goes through CDP against the browser that actually holds the login.
fastify.get('/api/profiles', async () => {
  const { cdpAlive } = await import('./providers/cdp.js');
  return { jars: listJars(), browser: await cdpAlive() };
});

fastify.post('/api/profiles/:site/save', async (req, reply) => {
  const site = (req.params as { site: string }).site;
  try {
    const { exportCookies } = await import('./providers/cdp.js');
    const cookies = await exportCookies(site);
    const jar = writeJar(site, cookies);
    return { saved: true, site: jar.site, cookies: jar.cookies.length, names: jar.cookies.map((c) => c.name).slice(0, 20) };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.delete('/api/profiles/:site', async (req) => ({ removed: deleteJar((req.params as { site: string }).site) }));

// A fetch that carries the jar for that site. Separate from /api/fetch so the normal chain stays
// untouched when no login is involved.
fastify.post('/api/fetch-profile', async (req, reply) => {
  const body = (req.body ?? {}) as { url?: string; profile?: string; waitMs?: number };
  if (!body.url) return reply.code(400).send({ error: 'url is required' });
  try {
    return await fetchWithProfile(body.url, { profile: body.profile, waitMs: body.waitMs });
  } catch (err) {
    if ((err as { code?: string }).code === 'NO_JAR') {
      return reply.code(404).send({ error: (err as Error).message, known: (err as { known?: string[] }).known });
    }
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Scrape: every format in one page visit (Firecrawl parity) ------------------------------
fastify.post('/api/scrape', async (req, reply) => {
  try {
    return await scrape(req.body as Parameters<typeof scrape>[0]);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Screenshots are files; serve them so a client gets a URL, not a megabyte of base64.
fastify.get('/shots/:file', async (req, reply) => {
  const name = (req.params as { file: string }).file;
  if (!/^[a-f0-9]{8,40}\.png$/.test(name)) return reply.code(400).send({ error: 'bad screenshot name' });
  const file = resolve(shotsDir(), name);
  if (!existsSync(file)) return reply.code(404).send({ error: 'no such screenshot' });
  return reply.type('image/png').send(createReadStream(file));
});

fastify.post('/api/parse', async (req, reply) => {
  try {
    return await parseDocument(req.body as { url?: string; base64?: string; filename?: string; maxChars?: number });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/monitor', async (req, reply) => {
  try {
    return await createMonitor(req.body as { url?: string; selector?: string });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/api/monitor', async () => ({ monitors: listMonitors() }));

fastify.post('/api/monitor/:id/check', async (req, reply) => {
  try {
    return await checkMonitor((req.params as { id: string }).id);
  } catch (err) {
    return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.delete('/api/browser/:sessionId', async (req, reply) => {
  try {
    return await closeBrowserSession((req.params as { sessionId: string }).sessionId);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Paid: a TinyFish remote browser session bills $0.002/min until it is closed.
fastify.post('/api/browser', async (req, reply) => {
  try {
    return await createBrowserSession(req.body as { url?: string; profile?: 'lite' | 'stealth' });
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.post('/api/vault', wrap(researchVault as any, ['action']));

// Doors that cost money or open a session require a client token. Free endpoints (search, fetch, scrape)
// do not: gating them would tax every harness for nothing.
const GUARDED = [/^\/mcp(\/|$)/, /^\/api\/agent/, /^\/api\/browse/, /^\/api\/browser/, /^\/api\/crawl/, /^\/api\/batch/, /^\/api\/research/];

// Identity is resolved for every route, so a free call still lands in the usage report under its client.
// Only the metered doors refuse anonymous callers.
const UNMETERED_ADMIN = [/^\/api\/clients/, /^\/health/, /^\/docs/, /^\/openapi\.json/, /^\/shots\//];

fastify.addHook('onRequest', (req, reply, done) => {
  const path = (req.raw.url || '').split('?')[0];
  if (UNMETERED_ADMIN.some((re) => re.test(path))) return done();

  const guarded = GUARDED.some((re) => re.test(path));
  const name = resolveToken(tokenFromHeaders(req.headers as Record<string, unknown>));

  if (name) {
    (req as any).client = name;
    enterClient(name);
    return done();
  }

  // Anonymous: recorded as such, so the usage report shows how much traffic has no identity instead of
  // implying every caller is known. In warn mode it is allowed through even on a metered door.
  (req as any).client = 'anonymous';
  enterClient('anonymous');
  if (guarded && authMode() === 'enforce') {
    return reply.status(401).send({
      error: 'A client token is required for this endpoint',
      hint: 'Create one with POST /api/clients {"name":"my-client"}, then send "Authorization: Bearer <token>"',
    });
  }
  return done();
});

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
  req.log.info({ client: req.client ?? 'anonymous' }, 'mcp request');
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
