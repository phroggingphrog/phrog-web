import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPersonalDb } from '../../src/personalization/db/index.js';
import { runImport, SOURCES, type ImportSource } from '../../src/personalization/imports/index.js';
import { importConfig } from '../../src/config.js';

let dir = '';
let db: DatabaseSync;
const paths = (): Record<ImportSource, string> => ({
  social: join(dir, 'social.sqlite'), music: join(dir, 'music.sqlite'), activity: join(dir, 'activity.sqlite'), media: join(dir, 'media.sqlite'),
});
const opts = {
  accountMap: new Map([['instagram:ig-account1', 'ykswrdn'], ['instagram:ig-account2', 'phroggingphrog']]),
  learnActions: new Set(['like', 'save', 'comment', 'share', 'play']),
};
const all = [...SOURCES];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phrog-import-')); db = openPersonalDb(join(dir, 'p.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const q = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const n = (t: string, where = '1') => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get() as any).n as number;
const ins = (d: DatabaseSync, table: string, rows: Record<string, unknown>[]) => {
  for (const r of rows) {
    const k = Object.keys(r);
    d.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...(Object.values(r) as any[]));
  }
};
const fresh = (name: string, ddl: string): DatabaseSync => {
  rmSync(join(dir, name), { force: true });
  const d = new DatabaseSync(join(dir, name));
  d.exec(ddl);
  return d;
};

// Synthetic sources. `flip` simulates a rebuild: the same content, different insertion order (so different rowids / source_row).
function build(flip = false, extra = false) {
  const order = <T,>(rows: T[]) => (flip ? [...rows].reverse() : rows);
  let sr = flip ? 1000 : 0;
  const row = () => ++sr;

  const s = fresh('social.sqlite', `
    CREATE TABLE platform_events(platform text, account text, action text, counterparty text, title text, url text, text text, ts_utc text, ts_local text, local_date text, era text, source_file text, source_row int);
    CREATE TABLE follows(platform text, account text, relation text, username text, ts_utc text, ts_local text, local_date text, era text, source_file text, source_row int);
    CREATE TABLE my_posts(platform text, account text, kind text, caption text, n_media int, likes_n int, url text, sound text, location text, visibility text, collections_n int, ts_utc text, ts_local text, local_date text, era text, n_words int, lang text, source_file text, source_row int);
    CREATE TABLE my_comments(platform text, account text, target_owner text, text text, url text, ts_utc text, ts_local text, local_date text, era text, n_words int, lang text, source_file text, source_row int);
    CREATE TABLE messages(platform text, account text, thread_key text, sender text, text text, ts_utc text);
    CREATE TABLE threads(thread_key text, title text);
    CREATE TABLE people(person_id int, name text);`);
  const ev = (account: string, action: string, cp: string | null, url: string | null, ts: string | null) =>
    ({ platform: 'instagram', account, action, counterparty: cp, url, ts_utc: ts, source_file: 'a.json', source_row: row() });
  ins(s, 'platform_events', order([
    ev('ig-account1', 'liked_post', 'authorone', 'https://www.instagram.com/p/POST1/', '2026-01-01T10:00:00Z'),
    ev('ig-account1', 'liked_post', 'authorone', 'https://www.instagram.com/p/POST1/', '2026-01-01T10:00:00Z'), // identical repeat in the same file
    ev('ig-account1', 'liked_post', 'authortwo', 'https://www.instagram.com/reel/REEL2/', '2026-01-02T10:00:00Z'),
    ev('ig-account2', 'saved_post', 'authortwo', null, '2026-01-03T10:00:00Z'),
    ev('ig-account2', 'viewed_post', 'authorone', 'https://www.instagram.com/p/POST1/', '2026-01-04T10:00:00Z'),
    ev('ig-account2', 'viewed_ad', 'brand', 'https://www.instagram.com/p/AD1/', '2026-01-05T10:00:00Z'),
    ev('ig-account1', 'liked_post', 'x', 'https://www.instagram.com/p/NOTS/', null),
    ev('ig-account1', 'session', null, null, '2026-01-06T10:00:00Z'),
    ev('ig-account1', 'viewed_post', null, null, '2026-01-07T10:00:00Z'),
  ]));
  const fo = (account: string, relation: string, user: string, ts: string) => ({ platform: 'instagram', account, relation, username: user, ts_utc: ts, source_file: 'f.json', source_row: row() });
  ins(s, 'follows', order([fo('ig-account1', 'following', 'authorone', '2025-05-01T00:00:00Z'), fo('ig-account1', 'following', 'authortwo', '2025-05-02T00:00:00Z'),
    fo('ig-account1', 'follower', 'fan', '2025-05-03T00:00:00Z'), fo('ig-account1', 'removed_suggestion', 'nobody', '2025-05-03T00:00:00Z')]));
  ins(s, 'my_posts', order([
    { platform: 'instagram', account: 'ig-account1', kind: 'post', caption: 'my first post', url: 'https://www.instagram.com/p/OWN1/', ts_utc: '2025-02-01T00:00:00Z', source_file: 'p.json', source_row: row() },
    { platform: 'instagram', account: 'ig-account1', kind: 'story', caption: null, url: null, ts_utc: '2025-02-02T00:00:00Z', source_file: 'p.json', source_row: row() },
  ]));
  ins(s, 'my_comments', order([{ platform: 'instagram', account: 'ig-account2', target_owner: 'authorone', text: 'nice one', ts_utc: '2025-03-01T00:00:00Z', source_file: 'c.json', source_row: row() }]));
  ins(s, 'messages', [{ platform: 'instagram', account: 'ig-account1', thread_key: 'THREADKEY-SECRET', sender: 'bob', text: 'SECRET-MESSAGE-BODY', ts_utc: '2026-01-01T00:00:00Z' }]);
  ins(s, 'threads', [{ thread_key: 'THREADKEY-SECRET', title: 'SECRET-THREAD-TITLE' }]);
  ins(s, 'people', [{ person_id: 1, name: 'SECRET-PERSON' }]);
  if (extra) ins(s, 'follows', [fo('ig-account1', 'following', 'authorthree', '2026-02-01T00:00:00Z')]);
  s.close();

  const m = fresh('music.sqlite', `
    CREATE TABLE plays(play_id integer primary key, played_at text, started_at text, ts_local text, local_date text, era text, service text, account text, kind text, track text, artist text, album text, artist_slug text, track_slug text, genre text, ms_played int, ms_played_capped int, flag_ms_played_oob int, media_duration_ms int, completion_rate real, is_skipped_raw int, is_skipped_v2 int, end_reason text, reason_start text, playback_intent text, shuffle int, platform text, track_ref text, session_id int, source_file text, source_row int);
    CREATE TABLE library_tracks(source text, track text, artist text, album text, genre text, duration_ms int, play_count int, skip_count int, rating int, date_added text, last_played text, year int);
    CREATE TABLE spotify_library(kind text, artist text, album text, track text, uri text);
    CREATE TABLE spotify_playlists(playlist text, last_modified text, position int, track text, artist text, album text, uri text, added_date text);
    CREATE TABLE apple_favorites(favorite_type text, item text, item_id text, last_modified text, preference text, source_row int);
    CREATE TABLE apple_daily_tracks(source_row int);
    CREATE TABLE apple_track_history(source_row int);`);
  const play = (service: string, account: string, at: string, track: string, ref: string | null, ms: number | null, dur: number | null) =>
    ({ played_at: at, started_at: at, service, account, kind: 'track', track, artist: 'Artist A', album: 'Album', ms_played: ms, media_duration_ms: dur, is_skipped_v2: 0, end_reason: 'trackdone', track_ref: ref, source_file: 'sp.json', source_row: row() });
  ins(m, 'plays', order([
    play('spotify', 'spotify-old', '2020-01-01T10:00:00Z', 'Song One', 'spotify:track:AAA', 180000, 200000),
    play('spotify', 'spotify-old', '2020-01-01T10:00:00Z', 'Song One', 'spotify:track:AAA', 180000, 200000), // genuine repeat, identical row
    play('spotify', 'spotify-old', '2020-01-02T10:00:00Z', 'Song One', 'spotify:track:AAA', 90000, null),
    play('apple_music', 'apple-music', '2021-01-01T10:00:00Z', 'Song Two', null, null, null),
  ]));
  if (extra) ins(m, 'plays', [play('apple_music', 'apple-music', '2026-09-01T10:00:00Z', 'Song Three', null, 1000, 2000)]);
  ins(m, 'library_tracks', order([{ source: 'apple-library-json', track: 'Song Two', artist: 'Artist A', album: 'Album', duration_ms: 240000, date_added: '2024-11-14' }]));
  ins(m, 'spotify_library', order([{ kind: 'track', artist: 'Artist A', album: 'Album', track: 'Song One', uri: 'spotify:track:AAA' }]));
  ins(m, 'spotify_playlists', order([{ playlist: 'Mix', position: 0, track: 'Song One', artist: 'Artist A', album: 'Album', uri: 'spotify:track:AAA', added_date: null }]));
  ins(m, 'apple_favorites', order([{ favorite_type: 'Artist', item: 'Artist A', item_id: 'i.123', last_modified: '2026-07-19T00:29:13Z', preference: 'LIKE', source_row: row() }]));
  ins(m, 'apple_daily_tracks', [{ source_row: 1 }, { source_row: 2 }]);
  m.close();

  const a = fresh('activity.sqlite', `
    CREATE TABLE events(id integer primary key, product text, account text, action text, title text, url text, channel text, ts_utc text, ts_local text, local_date text, era text, hour_local int, source_file text, source_row int);
    CREATE TABLE event_places(event_id int, lat2 real, lon2 real, label text);
    CREATE TABLE saved_places(list_name text, title text, note text, url text, tags text, comment text, source_file text, source_row int);
    CREATE TABLE place_reviews(date text, rating int, place_name text, address text, text text, url text, lat2 real, lon2 real, source_file text, source_row int);`);
  const ae = (product: string, account: string, action: string, title: string | null, url: string | null, ts: string) =>
    ({ product, account, action, title, url, ts_utc: ts, source_file: 'g.json', source_row: row() });
  ins(a, 'events', order([
    ae('Search', 'google', 'Searched for', 'cheap ramen', null, '2026-03-01T01:00:00Z'),
    ae('Search', 'google', 'Visited', 'some page', 'https://example.com', '2026-03-01T02:00:00Z'),
    ae('Gmail', 'google', 'Searched for', 'private mail query', null, '2026-03-01T03:00:00Z'),
    ae('TikTok', 'tiktok-account2', 'Watched', null, 'https://www.tiktokv.com/share/video/7254366201822907654/', '2026-03-02T01:00:00Z'),
    ae('Maps', 'google', 'Directions to', 'Cafe Place', null, '2026-03-03T01:00:00Z'),
  ]));
  ins(a, 'event_places', [{ event_id: flip ? 1 : 5, lat2: -37.8, lon2: 144.9, label: 'Cafe Place' }]);
  ins(a, 'saved_places', order([{ list_name: 'good cafe', title: 'Cafe Place', url: 'https://maps.example/cafe', source_file: 's.csv', source_row: row() }]));
  ins(a, 'place_reviews', order([{ date: '2026-05-26', rating: 5, place_name: 'Cafe Place', address: '1 Road', text: 'great', source_file: 'r.json', source_row: row() }]));
  a.close();

  const md = fresh('media.sqlite', `
    CREATE TABLE my_posts_snapshot(platform text, account text, kind text, caption text, ts_utc text, source_file text, source_row int);
    CREATE TABLE media_files(file_id integer primary key, sha256 text, my_posts_source_file text, my_posts_source_row int);
    CREATE TABLE media_text(sha256 text primary key, status text, ocr_text text, description text, tags text, is_screenshot int);`);
  ins(md, 'my_posts_snapshot', [
    { platform: 'instagram', account: 'ig-account1', kind: 'post', caption: 'my first post', ts_utc: '2025-02-01T00:00:00Z', source_file: 'p.json', source_row: 1 },
    { platform: 'instagram', account: 'ig-account1', kind: 'post', caption: 'unknown post', ts_utc: '2025-09-01T00:00:00Z', source_file: 'p.json', source_row: 2 },
  ]);
  ins(md, 'media_files', [{ sha256: 'h1', my_posts_source_file: 'p.json', my_posts_source_row: 1 }, { sha256: 'h2', my_posts_source_file: 'p.json', my_posts_source_row: 2 }, { sha256: 'h3', my_posts_source_file: null, my_posts_source_row: null }]);
  ins(md, 'media_text', [
    { sha256: 'h1', status: 'ok', ocr_text: 'sale sign', description: 'a shop front', tags: 'shop', is_screenshot: 0 },
    { sha256: 'h2', status: 'ok', ocr_text: null, description: 'orphan', tags: null, is_screenshot: 0 },
    { sha256: 'h3', status: 'ok', ocr_text: null, description: 'no post link', tags: null, is_screenshot: 0 },
  ]);
  md.close();
}

const run = (which: ImportSource[] = all, dry = false) => runImport(db, paths(), which, opts, dry);
const totals = (rs: Awaited<ReturnType<typeof run>>) => rs.reduce((t, r) => t + r.counts.added + r.counts.updated, 0);

test('first import adds rows; second import adds and updates nothing', async () => {
  build();
  const r1 = await run();
  assert.ok(r1.every((r) => r.status === 'success'), JSON.stringify(r1.map((r) => r.error)));
  assert.ok(totals(r1) > 0);
  const before = [n('observations'), n('items'), n('entity_state'), n('annotations'), n('item_ids')];
  const r2 = await run();
  assert.equal(totals(r2), 0);
  assert.deepEqual([n('observations'), n('items'), n('entity_state'), n('annotations'), n('item_ids')], before);
  assert.equal(n('import_runs'), 8);
});

test('rebuilt source (same content, different rowids and row order) adds nothing', async () => {
  build(false);
  await run();
  const before = [n('observations'), n('items'), n('entity_state'), n('annotations')];
  build(true);
  const r = await run();
  assert.equal(totals(r), 0, JSON.stringify(r.map((x) => x.counts.reasons)));
  assert.deepEqual([n('observations'), n('items'), n('entity_state'), n('annotations')], before);
});

test('identical repeated plays are both kept; a newer export adds only the new play', async () => {
  build();
  await run(['music']);
  assert.equal(n('observations', "action = 'play' AND item_id = (SELECT item_id FROM item_ids WHERE native_id = 'spotify:track:AAA') AND occurred_at = '2020-01-01T10:00:00Z'"), 2);
  const before = n('observations');
  build(false, true);
  const r = await run(['music']);
  assert.equal(r[0].counts.added, 1);
  assert.equal(n('observations'), before + 1);
});

test('unknown duration stays null; known duration is kept', async () => {
  build();
  await run(['music']);
  const apple = q("SELECT o.duration_ms od, i.duration_ms id FROM observations o JOIN items i ON i.id = o.item_id WHERE i.title = 'Song Two'")[0];
  assert.equal(apple.od, null);
  assert.equal(apple.id, null); // library row for Song Two carries 240000 but the play came first; item created from the play
  const spot = q("SELECT o.duration_ms od, i.duration_ms id FROM observations o JOIN items i ON i.id = o.item_id WHERE i.title = 'Song One' AND o.occurred_at = '2020-01-01T10:00:00Z'")[0];
  assert.equal(spot.od, 180000);
  assert.equal(spot.id, 200000);
});

test('saved place without a time has effective_at NULL; a play has its exact time', async () => {
  build();
  await run(['activity']);
  const s = q("SELECT effective_at, counterparty, relation FROM entity_state WHERE relation = 'save'");
  assert.equal(s.length, 1);
  assert.equal(s[0].effective_at, null);
  assert.equal(s[0].counterparty, 'good cafe');
  assert.equal(q("SELECT time_precision FROM observations WHERE action = 'review'")[0].time_precision, 'day');
});

test('mirror databases are refused and nothing is written', async () => {
  build();
  mkdirSync(join(dir, 'serve'));
  const mirror = join(dir, 'serve', 'personal.sqlite');
  writeFileSync(mirror, '');
  const r = await runImport(db, { ...paths(), social: mirror }, ['social'], opts);
  assert.equal(r[0].status, 'failed');
  assert.match(r[0].error!, /mirror/);
  assert.equal(n('observations'), 0);
  assert.equal(n('source_accounts'), 0);
  // a derived-looking DB under another name is refused too
  const d = new DatabaseSync(join(dir, 'other.sqlite'));
  d.exec('CREATE TABLE profile_items(x)');
  d.close();
  const r2 = await runImport(db, { ...paths(), social: join(dir, 'other.sqlite') }, ['social'], opts);
  assert.equal(r2[0].status, 'failed');
});

test('account map is applied; unmapped labels keep their label', async () => {
  build();
  await run(['social', 'music']);
  const handles = q("SELECT provider, handle, label FROM source_accounts ORDER BY provider, handle").map((r) => `${r.provider}:${r.handle}`);
  assert.ok(handles.includes('instagram:ykswrdn'));
  assert.ok(handles.includes('instagram:phroggingphrog'));
  assert.ok(!handles.some((h) => h.includes('ig-account')));
  assert.ok(handles.includes('spotify:spotify-old'));
});

test('account map is read from PHROG_IMPORT_ACCOUNT_MAP', () => {
  process.env.PHROG_IMPORT_ACCOUNT_MAP = 'instagram:ig-account1=a, instagram:ig-account2=b';
  assert.equal(importConfig().accountMap.get('instagram:ig-account2'), 'b');
  delete process.env.PHROG_IMPORT_ACCOUNT_MAP;
});

test('messages, threads and people are never read or stored', async () => {
  build();
  await run();
  for (const t of ['items', 'observations', 'entity_state', 'annotations', 'source_accounts', 'item_ids', 'import_runs']) {
    const dump = JSON.stringify(q(`SELECT * FROM ${t}`));
    assert.ok(!/SECRET|THREADKEY/.test(dump), `${t} leaked private content`);
  }
});

test('a post already collected live is linked, not duplicated', async () => {
  build();
  db.prepare("INSERT INTO items (id, kind, first_seen_at, updated_at) VALUES ('it_live', 'post', 'x', 'x')").run();
  db.prepare("INSERT INTO item_ids (item_id, provider, native_id) VALUES ('it_live', 'instagram', 'POST1')").run();
  db.prepare("INSERT INTO items (id, kind, canonical_url, first_seen_at, updated_at) VALUES ('it_url', 'post', 'https://www.instagram.com/reel/REEL2', 'x', 'x')").run();
  await run(['social']);
  assert.equal(n('item_ids', "provider = 'instagram' AND native_id = 'POST1'"), 1);
  assert.equal(n('observations', "item_id = 'it_url' AND action = 'like'"), 1); // linked by canonical URL (trailing slash tolerated)
  assert.ok(n('observations', "item_id = 'it_live' AND action = 'like'") >= 2);
});

test('actions are mapped; passive and out-of-scope rows are counted, not imported', async () => {
  build();
  const [r] = await run(['social']);
  const c = r.counts;
  assert.equal(c.read, 9 + 4 + 2 + 1);
  assert.equal(c.reasons['excluded:action=session'], 1);
  assert.equal(c.reasons['excluded:relation=removed_suggestion'], 1);
  assert.equal(c.reasons['rejected:no_timestamp'], 1);
  assert.equal(c.reasons['rejected:no_target'], 1);
  const acts = Object.fromEntries(q('SELECT action, learn, COUNT(*) n FROM observations GROUP BY action, learn').map((x) => [`${x.action}/${x.learn}`, x.n]));
  assert.equal(acts['like/1'], 3);
  assert.equal(acts['save/1'], 1);
  assert.equal(acts['open/0'], 1);
  assert.equal(acts['ad_view/0'], 1); // learn flag only for configured actions
  assert.equal(q("SELECT sponsored FROM observations WHERE action = 'ad_view'")[0].sponsored, 1);
  assert.equal(q("SELECT DISTINCT purpose FROM observations").map((x) => x.purpose).join(), 'unknown');
  assert.equal(n('observations', "action = 'comment'"), 1);
  assert.equal(n('observations', "action = 'post'"), 2);
});

test('a later partial follows snapshot never clears existing follows', async () => {
  build();
  await run(['social']);
  const before = n('entity_state');
  const s = new DatabaseSync(join(dir, 'social.sqlite'));
  s.exec("DELETE FROM follows WHERE username = 'authortwo'");
  s.close();
  const [r] = await run(['social']);
  assert.equal(r.counts.added, 0);
  assert.equal(n('entity_state'), before);
});

test('media text becomes annotations only where it joins to a post item', async () => {
  build();
  await run(['social', 'media']);
  assert.equal(n('annotations'), 2); // description + OCR of the matched post
  const media = (await run(['media']))[0];
  assert.equal(media.counts.added, 0);
  assert.equal(media.counts.reasons['excluded:no_matching_item'], 1);
  assert.equal(media.counts.reasons['note:media_text_without_post_link'], 1);
});

test('dry run reports counts and writes nothing', async () => {
  build();
  const r = await run(all, true);
  assert.ok(r[0].counts.added > 0);
  assert.equal(n('observations'), 0);
  assert.equal(n('import_runs'), 0);
  assert.equal(n('source_accounts'), 0);
});

test('provenance is recorded on observations', async () => {
  build();
  await run(['music']);
  const o = q('SELECT source_db, source_table, source_row_key, import_run_id FROM observations WHERE action = \'play\' LIMIT 1')[0];
  assert.equal(o.source_db, 'music');
  assert.equal(o.source_table, 'plays');
  assert.ok(o.source_row_key && o.import_run_id);
  const run1 = q('SELECT source_file_sha256, status FROM import_runs LIMIT 1')[0];
  assert.match(run1.source_file_sha256, /^[0-9a-f]{64}$/);
});
