import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getFeed, personalDb, FeedInputError } from './feed.js';
import { readArtifactImage } from './filter.js';

export const isPersonalRoute = (url: string) => url.startsWith('/api/personal/');

export function registerPersonalRoutes(fastify: FastifyInstance) {
  fastify.get('/api/personal/feed', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      return await getFeed({
        provider: q.provider ?? 'rss',
        account: q.account ?? '',
        source: q.source,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
        cursor: q.cursor,
        ...(q.filter !== undefined ? { filter: q.filter } : {}),
        ...(q.order !== undefined ? { order: q.order } : {}),
        ...(q.exploration !== undefined ? { exploration: q.exploration } : {}),
        ...(q.include_filtered !== undefined ? { include_filtered: q.include_filtered } : {}),
      });
    } catch (err) {
      if (err instanceof FeedInputError) return reply.status(400).send({ error: err.message });
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'personal feed failed');
      return reply.status(500).send({ error: 'feed failed' });
    }
  });

  fastify.get('/api/personal/artifacts/:id', async (req, reply) => {
    const art = readArtifactImage(personalDb(), (req.params as { id: string }).id);
    if (!art) return reply.status(404).send({ error: 'Not found' });
    return reply.header('cache-control', 'private, max-age=3600').type(art.mime).send(art.data);
  });
}
