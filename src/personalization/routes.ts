import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkBearer } from './auth.js';
import { getFeed, personalDb, FeedInputError } from './feed.js';
import { feedDecide } from './decisions.js';
import { readArtifact } from './filter.js';
import { recordFeedback } from './feedback.js';
import { personalDiscover } from './discover.js';
import { personalPreferences, PreferenceInputError } from './preferences.js';

export const isPersonalRoute = (url: string) => url.startsWith('/api/personal/');

/** Returns true when the request may proceed; otherwise sends the 401/503 reply. */
function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
  const auth = checkBearer(req.headers.authorization);
  if (auth === 'unconfigured') { reply.status(503).send({ error: 'Personal tools are disabled: PHROG_PERSONAL_TOKEN is not configured on the gateway' }); return false; }
  if (auth !== 'ok') { reply.status(401).header('www-authenticate', 'Bearer').send({ error: 'Unauthorized' }); return false; }
  return true;
}

const bool = (v: unknown) => v === true || v === 'true' || v === '1';

export function registerPersonalRoutes(fastify: FastifyInstance) {
  fastify.get('/api/personal/feed', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const q = req.query as Record<string, string | undefined>;
    try {
      return await getFeed({
        provider: q.provider ?? 'instagram',
        account: q.account ?? '',
        source: q.source,
        limit: q.limit !== undefined ? Number(q.limit) : undefined,
        cursor: q.cursor,
        filter: q.filter as any,
        include_filtered: bool(q.include_filtered),
        order: q.order as any,
        exploration: q.exploration !== undefined ? Number(q.exploration) : undefined,
      });
    } catch (err) {
      if (err instanceof FeedInputError) return reply.status(400).send({ error: err.message });
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'personal feed failed');
      return reply.status(500).send({ error: 'feed failed' });
    }
  });

  fastify.post('/api/personal/feed/decide', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const b = (req.body ?? {}) as Record<string, any>;
    try {
      return feedDecide({ item_id: b.item_id, decision: b.decision, reason: b.reason, idempotency_key: b.idempotency_key, client: b.client ?? 'rest' });
    } catch (err) {
      if (err instanceof FeedInputError) return reply.status(400).send({ error: err.message });
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'feed decide failed');
      return reply.status(500).send({ error: 'decide failed' });
    }
  });

  const guarded = (name: string, fn: (req: FastifyRequest) => Promise<unknown> | unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorize(req, reply)) return reply;
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof FeedInputError || err instanceof PreferenceInputError) return reply.status(400).send({ error: err.message });
      req.log.error({ err: err instanceof Error ? err.message : String(err) }, `personal ${name} failed`);
      return reply.status(500).send({ error: `${name} failed` });
    }
  };

  fastify.post('/api/personal/feedback', guarded('feedback', (req) => recordFeedback((req.body ?? {}) as any)));
  fastify.post('/api/personal/discover', guarded('discover', (req) => {
    const b = (req.body ?? {}) as Record<string, any>;
    return personalDiscover({ intent: b.intent, constraints: b.constraints, limit: b.limit, client: b.client ?? 'rest' });
  }));
  fastify.get('/api/personal/preferences', guarded('preferences', () => personalPreferences({ action: 'get' })));
  fastify.post('/api/personal/preferences', guarded('preferences', (req) => personalPreferences((req.body ?? {}) as any)));

  fastify.get('/api/personal/artifacts/:id', async (req, reply) => {
    if (!authorize(req, reply)) return reply;
    const png = readArtifact(personalDb(), (req.params as { id: string }).id);
    if (!png) return reply.status(404).send({ error: 'Not found' });
    return reply.header('cache-control', 'private, max-age=3600').type('image/png').send(png);
  });
}
