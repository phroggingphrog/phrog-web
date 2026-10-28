import type { FastifyInstance } from 'fastify';
import { executeSearch, type SearchOptions } from './search.js';

type SearchExecutor = (query: string, options: SearchOptions) => Promise<unknown>;

export function registerSearchRoute(fastify: FastifyInstance, search: SearchExecutor = executeSearch) {
  fastify.post('/v1/search', async (req, reply) => {
    const apiKey = process.env.PHROG_WEB_SEARCH_API_KEY;
    if (!apiKey || req.headers.authorization !== 'Bearer ' + apiKey) return reply.status(401).send({ error: 'Unauthorized' });
    const body = req.body as { query?: unknown; options?: SearchOptions } | null;
    if (!body || typeof body.query !== 'string' || !body.query.trim() || body.query.length > 2000) {
      return reply.status(400).send({ error: 'query must be a non-empty string of at most 2000 characters' });
    }
    const limit = body.options?.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
      return reply.status(400).send({ error: 'options.limit must be an integer from 1 to 50' });
    }
    try { return await search(body.query.trim(), body.options ?? {}); }
    catch (err) {
      req.log.error(err);
      return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
