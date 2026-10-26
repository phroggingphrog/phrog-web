import type { DatabaseSync } from 'node:sqlite';
import { Ctx, hasTable, iso, slug, text } from './common.js';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Track/podcast/video item. Spotify uris are real ids; everything else is keyed by artist+title inside its own name namespace (never merged across services). */
function trackItem(ctx: Ctx, a: { kind: string; track: string; artist: string | null; album?: string | null; ref?: string | null; durationMs?: number | null; provider?: string }) {
  const creatorId = a.artist ? ctx.item({ ids: [['name:artist', slug(a.artist)]], kind: 'creator', title: a.artist }) : null;
  const nameId: [string, string] = [`name:${a.kind}`, `${slug(a.artist)}|${slug(a.track)}`];
  const ids: Array<[string, string]> = a.ref && a.provider ? [[a.provider, a.ref], nameId] : [nameId];
  // a uri that is not seen yet still attaches the name id, so a later library row or play finds the same item
  return ctx.item({ ids, kind: a.kind, title: a.track, creatorId, durationMs: a.durationMs ?? null, author: { artist: a.artist, album: a.album ?? null } });
}

const kindOf = (k: string) => (k === 'album' ? 'album' : k === 'artist' ? 'creator' : k === 'playlist' ? 'playlist' : 'track');

export function importMusic(src: DatabaseSync, ctx: Ctx) {
  const c = ctx.counts;

  const plays = src.prepare(`SELECT played_at, started_at, service, account, kind, track, artist, album, ms_played, media_duration_ms, is_skipped_v2,
    end_reason, reason_start, track_ref, source_file, source_row FROM plays
    ORDER BY service, account, played_at, started_at, track_ref, artist, track, ms_played, source_file, source_row`).iterate() as Iterable<any>;
  for (const r of plays) {
    c.read++;
    const at = iso(r.played_at);
    if (!at) { ctx.reason('rejected', 'no_timestamp'); continue; }
    const track = text(r.track);
    if (!track) { ctx.reason('rejected', 'no_title'); continue; }
    const kind = ['podcast', 'video'].includes(r.kind) ? r.kind : 'track';
    const ref = kind === 'track' && r.service === 'spotify' ? text(r.track_ref) : null;
    const itemId = trackItem(ctx, { kind, track, artist: text(r.artist), album: text(r.album), ref, provider: ref ? 'spotify' : undefined, durationMs: num(r.media_duration_ms) });
    const skipped = r.is_skipped_v2 === 1;
    const base = [r.service, r.account, r.played_at, r.started_at ?? '', ref ?? '', r.artist ?? '', track, r.ms_played ?? '', r.end_reason ?? ''].join('\x1f');
    ctx.obs({
      accountId: ctx.account(r.service, r.account), itemId, action: skipped ? 'skip' : 'play', occurredAt: at, key: `music\x1fplay\x1f${base}\x1f${ctx.occurrence(base)}`,
      table: 'plays', rowKey: `${r.source_file}#${r.source_row}`, durationMs: num(r.ms_played),
      detail: { source_action: 'play', service: r.service, started_at: iso(r.started_at), end_reason: text(r.end_reason), reason_start: text(r.reason_start), play_kind: r.kind },
    });
  }

  const svc = (source: string) => (String(source).includes('spotify') ? ['spotify', 'spotify-old'] : ['apple_music', 'apple-music']);

  for (const r of src.prepare('SELECT kind, artist, album, track, uri FROM spotify_library ORDER BY uri, kind').all() as any[]) {
    c.read++;
    const uri = text(r.uri);
    const title = text(r.track) ?? text(r.album) ?? text(r.artist);
    if (!uri || !title) { ctx.reason('rejected', 'no_item'); continue; }
    const itemId = ctx.item({ ids: [['spotify', uri]], kind: kindOf(r.kind), title, author: { artist: text(r.artist), album: text(r.album) } });
    const [p, a] = svc('spotify');
    ctx.state({ accountId: ctx.account(p, a), itemId, relation: 'library', state: 'active', effectiveAt: null, prov: 'music.spotify_library' });
  }

  for (const r of src.prepare('SELECT playlist, last_modified, position, track, artist, album, uri, added_date FROM spotify_playlists ORDER BY playlist, position').all() as any[]) {
    c.read++;
    const name = text(r.playlist);
    const uri = text(r.uri);
    const title = text(r.track);
    if (!name || !title) { ctx.reason('rejected', 'no_item'); continue; }
    const itemId = trackItem(ctx, { kind: 'track', track: title, artist: text(r.artist), album: text(r.album), ref: uri, provider: 'spotify' });
    const [p, a] = svc('spotify');
    ctx.state({ accountId: ctx.account(p, a), itemId, counterparty: name, relation: 'playlist', state: 'active', effectiveAt: iso(r.added_date), prov: 'music.spotify_playlists' });
  }

  for (const r of src.prepare('SELECT favorite_type, item, item_id, last_modified, preference, source_row FROM apple_favorites ORDER BY favorite_type, item_id, item').all() as any[]) {
    c.read++;
    const name = text(r.item);
    if (!name) { ctx.reason('rejected', 'no_item'); continue; }
    const native = text(r.item_id) ?? `${slug(r.favorite_type)}|${slug(name)}`;
    const itemId = ctx.item({ ids: [['apple_music', native]], kind: kindOf(String(r.favorite_type).toLowerCase().replace('song', 'track')), title: name });
    const [p, a] = svc('apple');
    const pref = String(r.preference ?? '').toLowerCase();
    ctx.state({ accountId: ctx.account(p, a), itemId, relation: 'favourite', state: pref === 'like' ? 'active' : pref || 'active', effectiveAt: iso(r.last_modified), prov: `music.apple_favorites#${r.source_row}` });
  }

  for (const r of src.prepare('SELECT source, track, artist, album, duration_ms, date_added FROM library_tracks ORDER BY artist, track, source').all() as any[]) {
    c.read++;
    const title = text(r.track);
    if (!title) { ctx.reason('rejected', 'no_item'); continue; }
    const itemId = trackItem(ctx, { kind: 'track', track: title, artist: text(r.artist), album: text(r.album), durationMs: num(r.duration_ms) });
    const [p, a] = svc(r.source);
    ctx.state({ accountId: ctx.account(p, a), itemId, relation: 'library', state: 'active', effectiveAt: iso(r.date_added) ?? (text(r.date_added) ? `${r.date_added}T00:00:00Z` : null), prov: `music.library_tracks:${r.source}` });
  }

  // Derived or duplicate of plays: not imported.
  for (const t of ['apple_daily_tracks', 'apple_track_history']) {
    if (!hasTable(src, t)) continue;
    const n = (src.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number;
    c.read += n; c.excluded += n; c.reasons[`excluded:table=${t}`] = n;
  }
}
