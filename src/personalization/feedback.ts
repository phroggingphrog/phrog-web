import { randomUUID } from 'node:crypto';
import { personalDb, FeedInputError } from './feed.js';

export const FEEDBACK_TYPES = ['like', 'dislike', 'save', 'not_now', 'too_far', 'too_expensive', 'want_to_go', 'shown'] as const;
export const FEEDBACK_SCOPES = ['this_time', 'item', 'creator', 'topic', 'venue'] as const;
const SITUATIONAL = new Set(['not_now', 'too_far', 'too_expensive']);

export interface FeedbackRequest {
  item_id?: string;
  /** Alternative to item_id: the post or event link (items.canonical_url or a known native id in the path). */
  url?: string;
  delivery_id?: string;
  /** For type "shown": acknowledge several deliveries at once. */
  delivery_ids?: string[];
  type: string;
  scope?: string;
  reason?: string;
  idempotency_key?: string;
}

/** Resolve a link to one item: canonical_url (query and fragment ignored, trailing slash either way), then a native id such as /p/<code>. */
function resolveUrl(d: ReturnType<typeof personalDb>, raw: string): string {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new FeedInputError('url must be a valid link'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FeedInputError('url must be http(s)');
  const bare = `${u.origin}${u.pathname}`.replace(/\/$/, '');
  const hits = new Set<string>();
  for (const r of d.prepare('SELECT id FROM items WHERE canonical_url IN (?, ?)').all(bare, `${bare}/`) as any[]) hits.add(r.id);
  if (!hits.size) {
    const m = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
    const native = m?.[1] ?? u.pathname.split('/').filter(Boolean).pop();
    if (native) for (const r of d.prepare('SELECT item_id FROM item_ids WHERE native_id = ?').all(native) as any[]) hits.add(r.item_id);
  }
  if (hits.size === 0) throw new FeedInputError('no known item for that url');
  if (hits.size > 1) throw new FeedInputError('url matches more than one item; use item_id');
  return [...hits][0];
}

const DELIVERY_RE =/^dlv_[0-9a-f-]{36}$/;
const ITEM_RE = /^it_[0-9a-f-]{36}$/;

/**
 * Record the owner's reaction. Owner feedback is the truth label. like/save/want_to_go are positive, dislike is negative; the situational
 * types (not_now, too_far, too_expensive) and anything scoped "this_time" never become a lasting preference.
 * type "shown" is not feedback: it stamps deliveries.displayed_at when an agent actually delivered the message.
 */
export function recordFeedback(req: FeedbackRequest) {
  if (!FEEDBACK_TYPES.includes(req.type as any)) throw new FeedInputError(`type must be one of ${FEEDBACK_TYPES.join(', ')}`);
  const d = personalDb();
  const now = new Date().toISOString();

  if (req.type === 'shown') {
    const ids = [...(req.delivery_ids ?? []), ...(req.delivery_id ? [req.delivery_id] : [])];
    if (!ids.length || ids.length > 100 || ids.some((i) => typeof i !== 'string' || !DELIVERY_RE.test(i))) throw new FeedInputError('shown needs delivery_id or delivery_ids (dlv_...), at most 100');
    const get = d.prepare('SELECT id, displayed_at FROM deliveries WHERE id = ?');
    const set = d.prepare('UPDATE deliveries SET displayed_at = ? WHERE id = ? AND displayed_at IS NULL');
    const unknown: string[] = [];
    let updated = 0;
    d.exec('BEGIN');
    try {
      for (const id of new Set(ids)) {
        if (!get.get(id)) { unknown.push(id); continue; }
        updated += Number(set.run(now, id).changes);
      }
      d.exec('COMMIT');
    } catch (e) { d.exec('ROLLBACK'); throw e; }
    if (unknown.length === new Set(ids).size) throw new FeedInputError('unknown delivery_id');
    return { type: 'shown', updated, unknown_delivery_ids: unknown };
  }

  const scope = req.scope ?? (SITUATIONAL.has(req.type) ? 'this_time' : 'item');
  if (!FEEDBACK_SCOPES.includes(scope as any)) throw new FeedInputError(`scope must be one of ${FEEDBACK_SCOPES.join(', ')}`);
  const reason = typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim().slice(0, 1000) : null;
  if (scope === 'topic' && !reason) throw new FeedInputError('scope "topic" needs a reason naming the topic');
  if (req.idempotency_key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(req.idempotency_key)) throw new FeedInputError('idempotency_key must be 1..128 printable characters');
  if (req.delivery_id !== undefined && !DELIVERY_RE.test(String(req.delivery_id))) throw new FeedInputError('delivery_id must be a phrog delivery id (dlv_...)');
  if (req.item_id !== undefined && !ITEM_RE.test(String(req.item_id))) throw new FeedInputError('item_id must be a phrog item id (it_...)');

  let itemId = req.item_id ?? null;
  let deliveryId = req.delivery_id ?? null;
  if (deliveryId) {
    const dl = d.prepare('SELECT item_id FROM deliveries WHERE id = ?').get(deliveryId) as any;
    if (!dl) throw new FeedInputError('unknown delivery_id');
    if (itemId && itemId !== dl.item_id) throw new FeedInputError('delivery_id belongs to a different item');
    itemId = dl.item_id;
  }
  if (!itemId && req.url !== undefined) itemId = resolveUrl(d, req.url);
  if (!itemId) throw new FeedInputError('item_id, delivery_id or url is required');
  if (!d.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) throw new FeedInputError('unknown item_id');

  const key = req.idempotency_key ?? `fb_${randomUUID()}`;
  const out = (r: any, duplicate: boolean) => ({
    id: r.id, item_id: r.item_id, delivery_id: r.delivery_id, type: r.type, scope: r.scope, reason: r.reason, created_at: r.created_at,
    effect: !SITUATIONAL.has(r.type) && r.scope !== 'this_time' ? 'lasting' : 'this_time_only',
    duplicate,
  });
  const existing = d.prepare('SELECT * FROM feedback WHERE idempotency_key = ?').get(key) as any;
  if (existing) {
    if (existing.item_id !== itemId) throw new FeedInputError('idempotency_key was already used for a different item');
    return out(existing, true);
  }
  const id = `fb_${randomUUID()}`;
  d.prepare('INSERT INTO feedback (id, item_id, delivery_id, type, scope, reason, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, itemId, deliveryId, req.type, scope, reason, now, key);
  return out({ id, item_id: itemId, delivery_id: deliveryId, type: req.type, scope, reason, created_at: now }, false);
}
