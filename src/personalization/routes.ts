import type { FastifyInstance } from 'fastify';
import { checkBearer } from './auth.js';
import { getFeed, FeedInputError } from './feed.js';

export const isPersonalRoute = (url: string) => url.startsWith('/api/personal/');

export function registerPersonalRoutes(fastify: FastifyInstance) {
  fastify.get('/api/personal/feed', async (req, reply) => {
    const auth = checkBearer(req.headers.authorization);
    if (auth === 'unconfigured') return reply.status(503).send({ error: 'Personal tools are disabled: PHROG_PERSONAL_TOKEN is not configured on the gateway' });
    if (auth !== 'ok') return reply.status(401).header('www-authenticate', 'Bearer').send({ error: 'Unauthorized' });
    const q = req.query as { provider?: string; account?: string; source?: string; limit?: string; cursor?: string };
    try {
      return await getFeed({
        provider: q.provider ?? 'instagram',
        account: q.account ?? '',
        source: q.source,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
        cursor: q.cursor,
      });
    } catch (err) {
      if (err instanceof FeedInputError) return reply.status(400).send({ error: err.message });
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'personal feed failed');
      return reply.status(500).send({ error: 'feed failed' });
    }
  });
}
