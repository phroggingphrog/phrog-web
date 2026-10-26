import { randomUUID } from 'node:crypto';
import { personalDb, FeedInputError } from './feed.js';

export const DECISIONS = ['interesting', 'not_interesting', 'send_to_owner', 'save_event'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface DecideRequest {
  item_id: string;
  decision: string;
  reason?: string;
  idempotency_key?: string;
  client?: string;
}

/**
 * Record an agent's (Hermes's) judgement of a post, linked to the latest prediction shown for it.
 * These rows are the agent's guesses, never the owner's taste: they must not be used as owner-preference labels or training data.
 * Owner reactions are a separate source of truth.
 */
export function feedDecide(req: DecideRequest) {
  if (typeof req.item_id !== 'string' || !/^it_[0-9a-f-]{36}$/.test(req.item_id)) throw new FeedInputError('item_id must be a phrog item id (it_...)');
  if (!DECISIONS.includes(req.decision as Decision)) throw new FeedInputError(`decision must be one of ${DECISIONS.join(', ')}`);
  const reason = typeof req.reason === 'string' ? req.reason.slice(0, 2000) : null;
  const client = typeof req.client === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(req.client) ? req.client : 'unknown';
  if (req.idempotency_key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(req.idempotency_key)) throw new FeedInputError('idempotency_key must be 1..128 printable characters');
  const key = req.idempotency_key ?? `dec_${randomUUID()}`;

  const d = personalDb();
  const toOut = (r: any, duplicate: boolean) => ({
    id: r.id, item_id: r.item_id, decision: r.decision, reason: r.reason, client: r.client,
    prediction_id: r.prediction_id, collection_run_id: r.collection_run_id, created_at: r.created_at, duplicate,
  });
  const existing = d.prepare('SELECT * FROM agent_decisions WHERE idempotency_key = ?').get(key) as any;
  if (existing) {
    if (existing.item_id !== req.item_id) throw new FeedInputError('idempotency_key was already used for a different item');
    return toOut(existing, true);
  }
  if (!d.prepare('SELECT 1 FROM items WHERE id = ?').get(req.item_id)) throw new FeedInputError('unknown item_id');
  const pred = d.prepare('SELECT id, collection_run_id FROM predictions WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(req.item_id) as any;
  const runId = pred?.collection_run_id
    ?? (d.prepare('SELECT collection_run_id r FROM observations WHERE item_id = ? AND collection_run_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(req.item_id) as any)?.r
    ?? null;
  const id = `dcn_${randomUUID()}`;
  const created = new Date().toISOString();
  d.prepare(`INSERT INTO agent_decisions (id, item_id, collection_run_id, prediction_id, client, decision, reason, created_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.item_id, runId, pred?.id ?? null, client, req.decision, reason, created, key);
  return toOut({ id, item_id: req.item_id, decision: req.decision, reason, client, prediction_id: pred?.id ?? null, collection_run_id: runId, created_at: created }, false);
}
