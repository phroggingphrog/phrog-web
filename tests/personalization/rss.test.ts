import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { getFeed, closePersonalDb, FeedInputError } from '../../src/personalization/feed.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { setCardRenderer } from '../../src/personalization/render.js';
import { parseFeed, setRssFetch, isPrivateIp, normalizeSource } from '../../src/personalization/rss.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-rss-'));
const HUB = 'http://127.0.0.1:1200';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let n = 0;
let dbPath = '';
let rendered: { author: string | null; imageUrl: string | null }[] = [];

const RSS = (count: number, extra = '') => `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Test Venue</title><link>https://venue.example/</link>${Array.from({ length: count }, (_, i) => `
<item><title>${i === 0 ? 'great jazz &amp; blues night' : `Post ${i + 1}`}</title><link>https://venue.example/p/${i + 1}</link>
<guid isPermaLink="false">g-${i + 1}</guid><pubDate>Mon, 26 Oct 2026 0${i}:00:00 GMT</pubDate><dc:creator>Venue Staff</dc:creator>
<category>music</category><description><![CDATA[<p>Doors at <b>7pm</b></p><img src="/img/${i + 1}.jpg">]]></description></item>`).join('')}${extra}</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>Chan</title><author><name>Chan Name</name></author>
<entry><id>yt:video:abc</id><title>Clip one</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-10-20</published>
<media:group><media:thumbnail url="https://i.ytimg.com/vi/abc/hq.jpg"/><media:description>About the clip</media:description></media:group></entry>
<entry><id>urn:2</id><title>No link entry</title><updated>2026-10-21T10:00:00+11:00</updated><summary>plain</summary></entry></feed>`;

const JSONFEED = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'JF', items: [
  { id: '1', url: 'https://jf.example/1', title: 'Json item', content_text: 'Body text here', date_published: '2026-10-22T09:30:00Z', image: 'https://jf.example/1.png', authors: [{ name: 'Ann' }] },
  { id: '2', url: 'https://jf.example/2', title: 'Podcast', attachments: [{ url: 'https://jf.example/2.mp4', mime_type: 'video/mp4' }] },
] });

let routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }> = {};
let fetchLog: string[] = [];
const fakeFetch = (async (url: any) => {
  const u = String(url);
  fetchLog.push(u);
  const r = routes[u];
  if (!r) return new Response('nope', { status: 404 });
  return new Response(r.body, { status: r.status ?? 200, headers: r.headers });
}) as typeof fetch;
const publicResolve = async (h: string) => (h === 'evil.example' ? ['10.0.0.5'] : h === 'mixed.example' ? ['93.184.216.34', '127.0.0.1'] : ['93.184.216.34']);

before(async () => {
  process.env.PHROG_RSSHUB_URL = HUB;
  process.env.PHROG_PERSONAL_ARTIFACTS_DIR = join(dir, 'artifacts');
});
beforeEach(() => {
  closePersonalDb();
  dbPath = join(dir, `p${++n}.db`);
  process.env.PHROG_PERSONAL_DB = dbPath;
  routes = { [`${HUB}/venue/news`]: { body: RSS(5) } };
  fetchLog = [];
  rendered = [];
  setRssFetch(fakeFetch, publicResolve);
  setCardRenderer(async (cards) => { rendered.push(...cards.map((c) => ({ author: c.author, imageUrl: c.imageUrl }))); return cards.map(() => ({ png: PNG, width: 1, height: 1 })); });
});
after(() => { closePersonalDb(); setRssFetch(null); setCardRenderer(null); rmSync(dir, { recursive: true, force: true }); });

const q = (sql: string) => { const d = new DatabaseSync(dbPath); const r = d.prepare(sql).all() as any[]; d.close(); return r; };
const rss = (extra: object = {}) => getFeed({ provider: 'rss', source: '/venue/news', ...extra });

test('parses RSS: CDATA html to text, entities, guid/link ids, date, author, image fallback', () => {
  const { items } = parseFeed(RSS(2), '/venue/news')!;
  assert.equal(items.length, 2);
  assert.equal(items[0].native_id, 'https://venue.example/p/1');
  assert.equal(items[0].caption, 'great jazz & blues night\n\nDoors at 7pm');
  assert.equal(items[0].taken_at, Date.parse('2026-10-26T00:00:00Z') / 1000);
  assert.equal(items[0].posted_precision, 'exact');
  assert.equal(items[0].author?.name, 'Venue Staff');
  assert.deepEqual(items[0].hashtags, ['music']);
  assert.deepEqual(items[0].media, [{ type: 'image', url: 'https://venue.example/img/1.jpg', width: null, height: null, alt_text: null }]);
  assert.equal(items[0].media_type, 'article');
});

test('parses Atom: video host, thumbnail, date-only precision, channel author, id fallback', () => {
  const { items } = parseFeed(ATOM, '/youtube/channel/UCx')!;
  assert.equal(items.length, 2);
  assert.equal(items[0].native_id, 'https://www.youtube.com/watch?v=abc');
  assert.equal(items[0].media_type, 'video');
  assert.equal(items[0].posted_precision, 'day');
  assert.equal(items[0].caption, 'Clip one\n\nAbout the clip');
  assert.equal(items[0].author?.name, 'Chan Name');
  assert.equal(items[0].media[0].url, 'https://i.ytimg.com/vi/abc/hq.jpg');
  assert.equal(parseFeed('<rss><channel><item><title>t</title><link>https://www.youtube.com/watch?v=DN953UW8iJ8</link></item></channel></rss>', '/y')!.items[0].media[0].url, 'https://i.ytimg.com/vi/DN953UW8iJ8/hqdefault.jpg');
  assert.equal(items[1].native_id, '/youtube/channel/UCx#urn:2');
  assert.equal(items[1].url, null);
  assert.equal(items[1].taken_at, Date.parse('2026-10-21T10:00:00+11:00') / 1000);
});

test('parses JSON Feed: image, attachment video, unknown fields are null', () => {
  const { items } = parseFeed(JSONFEED, 'https://jf.example/feed.json')!;
  assert.equal(items.length, 2);
  assert.equal(items[0].media[0].url, 'https://jf.example/1.png');
  assert.equal(items[0].author?.name, 'Ann');
  assert.equal(items[1].media_type, 'video');
  assert.equal(items[1].taken_at, null);
  assert.equal(items[1].posted_precision, 'unknown');
  assert.equal(parseFeed('<html><body>hi</body></html>', 'x'), null);
});

test('feed.v1 for a route: shape, storage, observations', async () => {
  const f = await rss({ limit: 5 });
  assert.equal(f.schema_version, 'feed.v1');
  assert.equal(f.provider, 'rss');
  assert.equal(f.account, '/venue/news');
  assert.equal(f.source, '/venue/news');
  assert.equal(f.status, 'end');
  assert.equal(f.next_cursor, null);
  assert.equal(f.items.length, 5);
  assert.deepEqual(fetchLog, [`${HUB}/venue/news`]);
  const it = f.items[0] as any;
  assert.equal(it.position, 1);
  assert.equal(it.type, 'article');
  assert.equal(it.seen_before, false);
  assert.equal(it.posted_precision, 'exact');
  assert.equal(it.location, null);
  assert.equal(it.like_count, null);
  assert.equal(it.render, null);
  assert.equal(q('SELECT * FROM source_accounts')[0].handle, '/venue/news');
  assert.equal(q("SELECT * FROM collection_runs WHERE collector = 'rss' AND status = 'success'").length, 1);
  assert.equal(q('SELECT * FROM items').length, 5);
  assert.equal(q("SELECT * FROM item_ids WHERE provider = 'rss'").length, 5);
  assert.equal(q("SELECT * FROM observations WHERE action = 'seen_in_feed'").length, 5);
});

test('re-fetch is idempotent for items and marks seen_before', async () => {
  await rss({ limit: 5 });
  const g = await rss({ limit: 5 });
  assert.ok(g.items.every((i: any) => i.seen_before));
  assert.equal(q('SELECT * FROM items').length, 5);
  assert.equal(q('SELECT * FROM item_ids').length, 5);
  assert.equal(q('SELECT * FROM source_accounts').length, 1);
  assert.equal(q('SELECT * FROM collection_runs').length, 2);
  assert.equal(q('SELECT * FROM observations').length, 10);
  assert.equal(q('SELECT items_new FROM collection_runs ORDER BY started_at DESC, rowid DESC LIMIT 1')[0].items_new, 0);
});

test('cursor pages come from the stored list without refetching', async () => {
  const p1 = await rss({ limit: 2 });
  assert.equal(p1.status, 'ok');
  assert.match(p1.next_cursor!, /^run_/);
  assert.deepEqual(p1.items.map((i: any) => i.position), [1, 2]);
  assert.equal(q('SELECT * FROM items').length, 5); // whole feed stored
  assert.equal(q('SELECT * FROM observations').length, 2); // only shown items observed
  const p2 = await rss({ limit: 2, cursor: p1.next_cursor });
  assert.deepEqual(p2.items.map((i: any) => i.position), [3, 4]);
  assert.ok(p2.items.every((i: any) => i.seen_before === false && i.author.name === 'Venue Staff'));
  assert.equal(p2.cursor, p1.next_cursor);
  const p3 = await rss({ limit: 2, cursor: p2.next_cursor });
  assert.deepEqual(p3.items.map((i: any) => i.position), [5]);
  assert.equal(p3.status, 'end');
  assert.equal(p3.next_cursor, null);
  assert.equal(fetchLog.length, 1);
  assert.equal(q('SELECT * FROM observations').length, 5);
  assert.equal(q('SELECT * FROM item_ids').length, 5);
  const p1b = await rss({ limit: 2 });
  assert.ok(p1b.items.every((i: any) => i.seen_before));
  await assert.rejects(getFeed({ provider: 'rss', source: '/other/feed', limit: 2, cursor: p1.next_cursor }), FeedInputError);
  await assert.rejects(rss({ cursor: 'run_00000000-0000-0000-0000-000000000000' }), FeedInputError);
  await assert.rejects(rss({ cursor: 'abc' }), FeedInputError);
});

test('direct URL feeds are fetched from the public web; Atom works end to end', async () => {
  routes['https://feeds.example/atom.xml'] = { body: ATOM };
  const f = await getFeed({ provider: 'rss', source: 'https://feeds.example/atom.xml' });
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].type, 'video');
  assert.equal(f.items[0].posted_precision, 'day');
  assert.equal(f.items[0].posted_at, '2026-10-20T00:00:00.000Z');
  assert.equal(q('SELECT published_precision FROM items ORDER BY first_seen_at LIMIT 1')[0].published_precision, 'day');
});

test('SSRF: private, loopback, metadata, file, credentials and bad routes are blocked', async () => {
  const urls = ['http://127.0.0.1:8890/health', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://[::ffff:7f00:1]/x',
    'http://10.1.2.3/f', 'http://192.168.1.1/f', 'http://evil.example/f', 'http://mixed.example/f', 'http://svc.internal/f'];
  for (const u of urls) {
    const f = await getFeed({ provider: 'rss', source: u });
    assert.equal(f.status, 'failed', u);
    assert.match(f.error ?? '', /blocked/, u);
  }
  assert.equal(fetchLog.length, 0);
  for (const bad of ['file:///etc/passwd', 'ftp://x.example/f', 'http://user:pw@feeds.example/f', '//evil.example/x', '/a/../b', '/a b', 'javascript:alert(1)', '', 'relative/path']) {
    await assert.rejects(getFeed({ provider: 'rss', source: bad }), FeedInputError, bad);
  }
  await assert.rejects(getFeed({ provider: 'rss' }), FeedInputError);
  assert.equal(fetchLog.length, 0);
  assert.equal(normalizeSource('/youtube/channel/UCabc?format=json'), '/youtube/channel/UCabc?format=json');
});

test('SSRF: a redirect to a private address is blocked; a public redirect is followed', async () => {
  routes['https://feeds.example/r1'] = { status: 302, body: '', headers: { location: 'http://127.0.0.1:8890/health' } };
  const f = await getFeed({ provider: 'rss', source: 'https://feeds.example/r1' });
  assert.equal(f.status, 'failed');
  assert.match(f.error ?? '', /blocked/);
  routes['https://feeds.example/r2'] = { status: 301, body: '', headers: { location: '/real.xml' } };
  routes['https://feeds.example/real.xml'] = { body: ATOM };
  assert.equal((await getFeed({ provider: 'rss', source: 'https://feeds.example/r2' })).items.length, 2);
  assert.equal(q("SELECT * FROM item_ids WHERE native_id LIKE '%127.0.0.1%'").length, 0);
});

test('isPrivateIp covers the reserved ranges', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '198.18.0.1', '224.0.0.1', '::', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.63.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('failures store a failed run and no items; credential and missing routes get their own statuses', async () => {
  routes[`${HUB}/twitter/user/x`] = { status: 503, body: 'ConfigNotFoundError: Twitter auth is not configured' };
  routes[`${HUB}/html`] = { body: '<html>hello</html>' };
  const a = await rss({ source: '/twitter/user/x' });
  assert.equal(a.status, 'auth_required');
  assert.equal(a.items.length, 0);
  assert.equal(q("SELECT status FROM source_accounts WHERE handle = '/twitter/user/x'")[0].status, 'auth_required');
  assert.equal((await rss({ source: '/no/such' })).status, 'unsupported');
  const h = await rss({ source: '/html' });
  assert.equal(h.status, 'failed');
  assert.equal(q('SELECT * FROM items').length, 0);
  assert.equal(q('SELECT * FROM observations').length, 0);
  assert.deepEqual(q('SELECT status FROM collection_runs ORDER BY rowid').map((r) => r.status), ['auth_required', 'unsupported', 'failed']);
  delete process.env.PHROG_RSSHUB_URL;
  const none = await rss();
  process.env.PHROG_RSSHUB_URL = HUB;
  assert.match(none.error ?? '', /PHROG_RSSHUB_URL/);
});

test('empty feed is end with no items', async () => {
  routes[`${HUB}/empty`] = { body: RSS(0) };
  const f = await rss({ source: '/empty' });
  assert.equal(f.status, 'end');
  assert.equal(f.items.length, 0);
});

test('unranked RSS feed retains source order and can render screenshots', async () => {
  const f = await rss({ limit: 5, screenshots: true });
  assert.equal(f.items.length, 5);
  assert.match(f.items[0].caption, /^great jazz/);
  assert.match((f.items[0] as any).render.screenshot, /^\/api\/personal\/artifacts\/art_/);
  assert.equal(f.filtered_out, 0);
});

test('REST: provider=rss with source and no account; invalid source is 400', async () => {
  const app = Fastify();
  registerPersonalRoutes(app);
  const headers = {};
  const ok = await app.inject({ method: 'GET', url: '/api/personal/feed?provider=rss&source=%2Fvenue%2Fnews&limit=2', headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().items.length, 2);
  assert.equal(ok.json().provider, 'rss');
  const bad = await app.inject({ method: 'GET', url: '/api/personal/feed?provider=rss&source=file%3A%2F%2F%2Fetc%2Fpasswd', headers });
  assert.equal(bad.statusCode, 400);
  const ig = await app.inject({ method: 'GET', url: '/api/personal/feed?provider=nope', headers });
  assert.equal(ig.statusCode, 400);
  await app.close();
});
