import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { personalConfig } from '../config.js';
import { openPersonalDb } from './db/index.js';
import { renderFeedItems } from './filter.js';
import { CURSOR_RE, type CollectorResult } from './collector.js';
import { normalizeSource, readFeed } from './rss.js';

export class FeedInputError extends Error {}

export interface FeedRequest {
  provider: string;
  account?: string;
  source?: string;
  limit?: number;
  cursor?: string | null;
  screenshots?: boolean;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

let shared: DatabaseSync | null = null;
let sharedPath = '';
function db(): DatabaseSync {
  const path = personalConfig().dbPath;
  if (!shared || sharedPath !== path) {
    shared?.close();
    shared = openPersonalDb(path);
    sharedPath = path;
  }
  return shared;
}
export const personalDb = db;
export function closePersonalDb() { shared?.close(); shared = null; }

const iso = (unixSeconds: unknown): string | null =>
  typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;
const json = (v: unknown) => JSON.stringify(v ?? null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const flag = (v: unknown) => (v === true ? 1 : 0);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

function runStatus(s: CollectorResult['status']): string {
  switch (s) {
    case 'ok': case 'end': return 'success';
    case 'auth_required': case 'challenge': case 'rate_limited': case 'unsupported': return s;
    default: return 'failed';
  }
}

const RUN_CURSOR_RE = /^run_[0-9a-f-]{36}$/;

export async function getFeed(req: FeedRequest) {
  if (req.provider !== 'rss') throw new FeedInputError('provider must be "rss"');
  const isRss = true;
  const norm = normalizeSource(req.source);
  if (!norm) throw new FeedInputError('source must be an RSSHub route starting with "/" or an http(s) feed URL');
  const source = norm;
  const account = norm; // one source_accounts row per feed
  const limit = req.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new FeedInputError(`limit must be an integer 1..${MAX_LIMIT}`);
  if (['filter', 'include_filtered', 'order', 'exploration'].some((key) => key in req)) throw new FeedInputError('Feed ranking and filtering are no longer supported');
  const given = req.cursor || null;
  if (given !== null && !CURSOR_RE.test(given)) throw new FeedInputError('cursor has invalid characters or length');

  const d = db();
  // next_cursor is the id of the run that fetched the previous page; the stored checkpoint stays in the DB.
  let cursor = given;
  if (given !== null && RUN_CURSOR_RE.test(given)) {
    const row = d.prepare(`SELECT r.next_checkpoint FROM collection_runs r JOIN source_accounts a ON a.id = r.source_account_id
      WHERE r.id = ? AND a.provider = ? AND a.handle = ?`).get(given, req.provider, account) as any;
    if (!row?.next_checkpoint) throw new FeedInputError('unknown cursor for this account');
    cursor = row.next_checkpoint;
  }
  // RSS cursors are checkpoints into a stored list: {"list": [native ids in feed order], "offset": n}.
  let rssPage: { list: string[]; offset: number } | null = null;
  if (isRss && cursor !== null) {
    if (given === null || !RUN_CURSOR_RE.test(given)) throw new FeedInputError('cursor must be a next_cursor from a previous page');
    try { rssPage = JSON.parse(cursor); } catch { rssPage = null; }
    if (!rssPage || !Array.isArray(rssPage.list) || !Number.isInteger(rssPage.offset)) throw new FeedInputError('unknown cursor for this account');
  }
  const now = () => new Date().toISOString();
  const runId = `run_${randomUUID()}`;
  const startedAt = now();

  let accountId: string;
  d.exec('BEGIN');
  try {
    d.prepare('INSERT OR IGNORE INTO source_accounts (id, provider, handle) VALUES (?, ?, ?)').run(`acc_${randomUUID()}`, req.provider, account);
    accountId = (d.prepare('SELECT id FROM source_accounts WHERE provider = ? AND handle = ?').get(req.provider, account) as any).id;
    d.prepare('INSERT INTO collection_runs (id, source_account_id, collector, started_at, checkpoint) VALUES (?, ?, ?, ?, ?)')
      .run(runId, accountId, 'rss', startedAt, isRss ? given : cursor);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }

  // RSS page 1 fetches the whole feed and stores it, but only `limit` items are shown (and observed); later pages read the stored list.
  let res: CollectorResult & { items: any[] };
  let rssNext: string | null = null;
  if (isRss && rssPage) {
    res = { status: 'ok', cursor: given, next_cursor: null, fetched_at: null, error: null, items: [] };
  } else {
    const r = await readFeed(source);
    res = { status: r.status, cursor: null, next_cursor: null, fetched_at: r.fetched_at, error: r.error, items: r.items };
    if (r.items.length > limit) rssNext = JSON.stringify({ list: r.items.map((i) => i.native_id), offset: limit });
    if (r.items.length) res.status = rssNext ? 'ok' : 'end';
  }
  const fetchedAt = res.fetched_at ?? now();
  const out: any[] = [];
  let newCount = 0;

  d.exec('BEGIN');
  try {
    const findItem = d.prepare('SELECT item_id FROM item_ids WHERE provider = ? AND native_id = ?');
    const getItem = d.prepare('SELECT first_seen_at FROM items WHERE id = ?');
    const insItem = d.prepare(`INSERT INTO items (id, kind, description, canonical_url, published_at, published_precision, media_type,
      author_json, hashtags_json, mentions_json, media_json, location_json, like_count, comment_count, first_seen_at, updated_at)
      VALUES (?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updItem = d.prepare(`UPDATE items SET description = ?, canonical_url = ?, published_at = COALESCE(?, published_at),
      published_precision = CASE WHEN ? IS NULL THEN published_precision ELSE ? END, media_type = ?, author_json = ?, hashtags_json = ?,
      mentions_json = ?, media_json = ?, location_json = ?, like_count = ?, comment_count = ?, updated_at = ? WHERE id = ?`);
    const insId = d.prepare('INSERT INTO item_ids (item_id, provider, native_id) VALUES (?, ?, ?)');
    const insObs = d.prepare(`INSERT OR IGNORE INTO observations (source_account_id, collection_run_id, item_id, action, feed_position,
      sponsored, suggested, occurred_at, dedupe_key) VALUES (?, ?, ?, 'seen_in_feed', ?, ?, ?, ?, ?)`);

    const hadObs = d.prepare("SELECT 1 FROM observations WHERE item_id = ? AND action = 'seen_in_feed' LIMIT 1");
    if (rssPage) {
      const page = rssPage.list.slice(rssPage.offset, rssPage.offset + limit);
      const row = d.prepare(`SELECT i.*, ii.native_id FROM items i JOIN item_ids ii ON ii.item_id = i.id AND ii.provider = 'rss' WHERE ii.native_id = ?`);
      page.forEach((nid, idx) => {
        const r = row.get(nid) as any;
        if (!r) return;
        const position = rssPage!.offset + idx + 1;
        const seenBefore = !!hadObs.get(r.id);
        insObs.run(accountId, runId, r.id, position, 0, 0, fetchedAt, `${runId}:${nid}`);
        out.push({
          position, item_id: r.id, native_id: nid, url: r.canonical_url, type: r.media_type, sponsored: false, suggested: false,
          author: JSON.parse(r.author_json), caption: r.description, hashtags: JSON.parse(r.hashtags_json), mentions: JSON.parse(r.mentions_json),
          media: JSON.parse(r.media_json), posted_at: r.published_at, posted_precision: r.published_precision, location: null,
          like_count: null, comment_count: null, seen_before: seenBefore, first_seen_at: r.first_seen_at, render: null, filter: null, prediction: null,
        });
      });
      const end = rssPage.offset + limit;
      if (end < rssPage.list.length) rssNext = JSON.stringify({ list: rssPage.list, offset: end });
      res.status = rssNext ? 'ok' : 'end';
    }
    res.items.forEach((it, idx) => {
      const nativeId = typeof it?.native_id === 'string' ? it.native_id : null;
      if (!nativeId) return;
      const hidden = isRss && idx >= limit; // stored but not shown on this page
      const postedAt = iso(it.taken_at);
      const precision = postedAt ? (it.posted_precision === 'day' ? 'day' : 'exact') : 'unknown';
      const position = num(it.position) ?? idx + 1;
      const caption = typeof it.caption === 'string' ? it.caption : null;
      const url = typeof it.url === 'string' ? it.url : null;
      const mediaType = typeof it.media_type === 'string' ? it.media_type : null;
      const cols = [caption, url, postedAt, mediaType, json(it.author), json(arr(it.hashtags)), json(arr(it.mentions)),
        json(arr(it.media)), json(it.location ?? null), num(it.like_count), num(it.comment_count)] as const;
      const existing = findItem.get(req.provider, nativeId) as any;
      let itemId: string;
      let firstSeen: string;
      let seenBefore = false;
      if (existing) {
        itemId = existing.item_id;
        seenBefore = isRss ? !!hadObs.get(itemId) : true;
        updItem.run(caption, url, postedAt, postedAt, precision, mediaType, cols[4], cols[5], cols[6], cols[7], cols[8], cols[9], cols[10], now(), itemId);
        firstSeen = (getItem.get(itemId) as any).first_seen_at;
      } else {
        itemId = `it_${randomUUID()}`;
        firstSeen = fetchedAt;
        insItem.run(itemId, caption, url, postedAt, precision, mediaType, cols[4], cols[5], cols[6], cols[7], cols[8], cols[9], cols[10], firstSeen, now());
        insId.run(itemId, req.provider, nativeId);
        newCount++;
      }
      if (hidden) return;
      insObs.run(accountId, runId, itemId, position, flag(it.sponsored), flag(it.suggested), fetchedAt, `${runId}:${nativeId}`);
      out.push({
        position, item_id: itemId, native_id: nativeId, url, type: mediaType,
        sponsored: it.sponsored === true, suggested: it.suggested === true,
        author: it.author ?? null, caption, hashtags: arr(it.hashtags), mentions: arr(it.mentions), media: arr(it.media),
        posted_at: postedAt, posted_precision: precision,
        location: it.location ?? null, like_count: num(it.like_count), comment_count: num(it.comment_count),
        seen_before: seenBefore, first_seen_at: firstSeen, render: null, filter: null, prediction: null,
      });
    });

    d.prepare('UPDATE collection_runs SET finished_at = ?, status = ?, items_seen = ?, items_new = ?, error = ?, next_checkpoint = ? WHERE id = ?')
      .run(now(), runStatus(res.status), out.length, newCount, res.error, (isRss ? rssNext : res.next_cursor) ?? null, runId);
    if (res.status === 'ok' || res.status === 'end') d.prepare("UPDATE source_accounts SET status = 'ok', last_verified_at = ? WHERE id = ?").run(now(), accountId);
    else if (res.status === 'auth_required' || res.status === 'challenge') d.prepare('UPDATE source_accounts SET status = ? WHERE id = ?').run(res.status, accountId);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }

  if (req.screenshots) await renderFeedItems(d, out);

  return {
    schema_version: 'feed.v1',
    provider: req.provider, account, source,
    status: res.status, fetched_at: fetchedAt,
    cursor: given, next_cursor: (isRss ? rssNext : res.next_cursor) ? runId : null,
    ...(res.error ? { error: res.error } : {}),
    filtered_out: 0,
    items: out,
  };
}

export type FeedV1 = Awaited<ReturnType<typeof getFeed>>;
