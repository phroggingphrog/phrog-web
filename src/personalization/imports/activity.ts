import type { DatabaseSync } from 'node:sqlite';
import { Ctx, hasTable, iso, nativeFromUrl, sha, slug, text } from './common.js';

// Discovery-relevant (product, action) pairs. Everything else (page visits, mail, assistant chats, logins, ...) is out of scope.
const MEDIA: Record<string, { provider: string; actions: Record<string, string> }> = {
  TikTok: { provider: 'tiktok', actions: { Watched: 'open', Liked: 'like', 'Favourited video': 'save', Reposted: 'share' } },
  YouTube: { provider: 'youtube', actions: { Watched: 'open', Liked: 'like', Disliked: 'dislike' } },
};
const PLACE_ACTIONS: Record<string, string> = { 'Directions to': 'open', Shared: 'share' };
const SEARCH_PRODUCTS = new Set(['Search', 'Image Search', 'Video Search', 'Maps', 'YouTube', 'TikTok', 'Google Play Store', 'Hotels']);

export function importActivity(src: DatabaseSync, ctx: Ctx) {
  const c = ctx.counts;
  const hasPlaces = hasTable(src, 'event_places');
  const events = src.prepare(`SELECT e.product, e.account, e.action, e.title, e.url, e.ts_utc, e.source_file, e.source_row,
      ${hasPlaces ? 'p.lat2 lat, p.lon2 lon, p.label label' : 'NULL lat, NULL lon, NULL label'}
    FROM events e ${hasPlaces ? 'LEFT JOIN event_places p ON p.event_id = e.id' : ''}
    ORDER BY e.product, e.account, e.action, e.ts_utc, e.title, e.url, e.source_file, e.source_row`).iterate() as Iterable<any>;

  for (const r of events) {
    c.read++;
    const media = MEDIA[r.product];
    const act = r.action as string;
    const kind: 'media' | 'place' | 'search' | 'subscribe' | null =
      media?.actions[act] ? 'media' : r.product === 'Maps' && PLACE_ACTIONS[act] ? 'place'
      : act === 'Searched for' && SEARCH_PRODUCTS.has(r.product) ? 'search'
      : r.product === 'YouTube' && act === 'Subscribed to' ? 'subscribe' : null;
    if (!kind) { ctx.reason('excluded', `product=${r.product}`); continue; }
    const at = iso(r.ts_utc);
    if (!at) { ctx.reason('rejected', 'no_timestamp'); continue; }
    const title = text(r.title);
    const url = text(r.url);
    const provider = media?.provider ?? 'google';
    const accountId = ctx.account(provider, r.account);
    const base = [r.product, r.account, act, title ?? '', url ?? '', at].join('\x1f');
    const common = { accountId, occurredAt: at, table: 'events', rowKey: `${r.source_file}#${r.source_row}` };

    if (kind === 'subscribe') {
      if (!title) { ctx.reason('rejected', 'no_target'); continue; }
      const itemId = ctx.item({ ids: [['youtube_channel', slug(title)]], kind: 'creator', title });
      ctx.state({ accountId, itemId, counterparty: title, relation: 'follow', state: 'active', effectiveAt: at, prov: `activity.events:${r.source_file}#${r.source_row}` });
    } else if (kind === 'media') {
      if (!url) { ctx.reason('rejected', 'no_target'); continue; }
      const { native, kind: ik } = nativeFromUrl(provider, url);
      const itemId = ctx.item({ ids: [[provider, native]], kind: ik === 'post' ? 'video' : ik, title, url: native.startsWith('url:') ? url : null });
      ctx.obs({ ...common, itemId, action: media.actions[act], key: `activity\x1f${base}\x1f${ctx.occurrence(base)}`, detail: { source_action: `${r.product}/${act}` } });
    } else if (kind === 'place') {
      if (!title) { ctx.reason('rejected', 'no_target'); continue; }
      const loc = r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon, label: text(r.label) } : null;
      const itemId = ctx.item({ ids: [['google_maps', slug(title)]], kind: 'venue', title, location: loc });
      ctx.obs({ ...common, itemId, action: PLACE_ACTIONS[act], key: `activity\x1f${base}\x1f${ctx.occurrence(base)}`, detail: { source_action: `${r.product}/${act}` } });
    } else {
      if (!title) { ctx.reason('rejected', 'no_target'); continue; }
      const itemId = ctx.item({ ids: [[`search:${r.product}`, slug(title)]], kind: 'query', title });
      ctx.obs({ ...common, itemId, action: 'search', key: `activity\x1f${base}\x1f${ctx.occurrence(base)}`, detail: { source_action: `${r.product}/${act}` } });
    }
  }

  const gAccount = () => ctx.account('google', 'google');

  for (const r of src.prepare('SELECT list_name, title, note, url, source_file, source_row FROM saved_places ORDER BY list_name, title, url').all() as any[]) {
    c.read++;
    const title = text(r.title);
    if (!title) { ctx.reason('rejected', 'no_item'); continue; }
    const itemId = ctx.item({ ids: [['saved_place', `${slug(title)}|${text(r.url) ?? ''}`]], kind: 'venue', title, url: text(r.url) });
    // The export carries no save time: effective_at stays NULL.
    ctx.state({ accountId: gAccount(), itemId, counterparty: text(r.list_name), relation: 'save', state: 'active', effectiveAt: null, prov: `activity.saved_places:${r.source_file}#${r.source_row}` });
  }

  for (const r of src.prepare('SELECT date, rating, place_name, address, text, url, lat2, lon2, source_file, source_row FROM place_reviews ORDER BY date, place_name, address').all() as any[]) {
    c.read++;
    const name = text(r.place_name);
    const day = text(r.date);
    if (!name || !day || Number.isNaN(Date.parse(day))) { ctx.reason('rejected', !name ? 'no_item' : 'no_timestamp'); continue; }
    const loc = r.lat2 != null && r.lon2 != null ? { lat: r.lat2, lon: r.lon2, address: text(r.address) } : null;
    const itemId = ctx.item({ ids: [['google_place', `${slug(name)}|${slug(r.address)}`]], kind: 'venue', title: name, url: text(r.url), location: loc });
    const base = [day, name, r.address ?? '', r.rating ?? '', sha(String(r.text ?? ''))].join('\x1f');
    ctx.obs({
      accountId: gAccount(), itemId, action: 'review', occurredAt: day, precision: 'day', learn: true, key: `activity\x1freview\x1f${base}\x1f${ctx.occurrence(base)}`,
      table: 'place_reviews', rowKey: `${r.source_file}#${r.source_row}`, detail: { source_action: 'place_review', rating: r.rating ?? null, text: text(r.text) },
    });
  }
}
