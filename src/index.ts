import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { executeSearch, SearchOptions } from './providers/search.js';
import { executeFetch, FetchOptions } from './providers/fetch.js';
import { executeQuickResearch, dispatchDeepResearch, getResearchJob } from './providers/research.js';

const config = loadConfig();
const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });

// Health check
fastify.get('/health', async () => ({ status: 'ok', service: 'phrog-web', version: '0.1.0' }));

// 1. Search API (TinyFish & SearXNG unified)
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

// 2. Fetch API (Clean Markdown reader with Crawl4AI / TinyFish fallback)
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

// 3. Research API (Quick via Vane / Deep via Feynman autonomous agent)
fastify.post('/api/research', async (req, reply) => {
  const body = req.body as {
    question?: string;
    topic?: string;
    mode?: 'quick' | 'deep';
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
      const quickResult = await executeQuickResearch(prompt, { instructions: body.instructions });
      return quickResult;
    } catch (err) {
      req.log.error(err);
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    // Autonomous background dispatch
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

// 4. Research Job Status Check
fastify.get('/api/research/:jobId', async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  const job = getResearchJob(jobId);
  if (!job) {
    return reply.status(404).send({ error: `Research job "${jobId}" not found` });
  }
  return job;
});

// Start Server
const port = Number(process.env.PORT || config.server.port || 8890);
const host = config.server.host || '127.0.0.1';

try {
  await fastify.listen({ port, host });
  console.log(`Phrog Web Gateway listening on http://${host}:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
