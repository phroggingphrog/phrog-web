import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { personalDb, closePersonalDb, FeedInputError } from '../../src/personalization/feed.js';
import { personalRecent } from '../../src/personalization/recent.js';
import { recordFeedback } from '../../src/personalization/feedback.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-recent-'));
const TOKEN = 'test-token-not-real';
const NOW = new Date('2026-10-26T12:00:00Z');
let n = 0;
const U = (c: string) => `it_00000000-0000-0000-0000-00000000000${c}`;

before(() => { process.env.PHROG_PERSONAL_TOKEN = TOKEN; });
beforeEach(() => { closePersonalDb(); process.env.PHROG_PERSONAL_DB = join(dir, `r${++n}.db`); });
after(() => { closePersonalDb(); rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const d = personalDb();
  const t = '2026-10-26T10:00:00Z';
  const item = (id: string, title: string, url: string, author: string | null = null) =>
    d.prepare('INSERT INTO items (id, kind, title, canonical_url, author_json, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'post', title, url, author, t, t);
  item(U('1'), 'Event One', 'https://events.humanitix.com/one');
  item(U('2'), 'Event Two', 'https://events.humanitix.com/two');
  item(U('3'), 'Event Three', 'https://events.humanitix.com/three');
  item(U('4'), 'A post', 'https://www.instagram.com/p/ABC123', JSON.stringify({ handle: 'poet_one' }));
  item(U('5'), 'Old sent post', 'https://www.instagram.com/p/OLD999', JSON.stringify({ handle: 'x' }));
  d.prepare("INSERT INTO item_ids (item_id, provider, native_id) VALUES (?, 'instagram', 'ABC123')").run(U('4'));
  d.prepare("INSERT INTO discovery_runs (id, ranker_version, started_at) VALUES ('dsc_a', 'x', ?), ('dsc_b', 'x', ?)").run(t, '2026-10-20T10:00:00Z');
  const del = d.prepare('INSERT INTO deliveries (id, discovery_run_id, item_id, position, returned_at, displayed_at) VALUES (?, ?, ?, ?, ?, ?)');
  del.run('dlv_1', 'dsc_a', U('1'), 1, t, '2026-10-26T10:05:00Z');
  del.run('dlv_2', 'dsc_a', U('2'), 2, t, '2026-10-26T10:05:00Z');
  del.run('dlv_3', 'dsc_a', U('3'), 3, t, null); // returned, never shown
  del.run('dlv_old', 'dsc_b', U('5'), 1, t, '2026-10-20T10:05:00Z'); // outside the window
  const dec = d.prepare('INSERT INTO agent_decisions (id, item_id, client, decision, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)');
  dec.run('dcn_1', U('4'), 'hermes', 'send_to_owner', '2026-10-26T11:00:00Z', 'k1');
  dec.run('dcn_2', U('4'), 'hermes', 'send_to_owner', '2026-10-26T11:30:00Z', 'k2');
  dec.run('dcn_3', U('3'), 'hermes', 'not_interesting', '2026-10-26T11:00:00Z', 'k3');
  dec.run('dcn_4', U('5'), 'hermes', 'send_to_owner', '2026-10-20T11:00:00Z', 'k4');
}

test('personal_recent lists shown deliveries by run and send_to_owner posts, only inside the window', () => {
  seed();
  const r = personalRecent({ hours: 48 }, NOW);
  assert.equal(r.discovery_runs.length, 1);
  assert.deepEqual(r.discovery_runs[0].items.map((i) => [i.number, i.title, i.delivery_id, i.item_id]), [[1, 'Event One', 'dlv_1', U('1')], [2, 'Event Two', 'dlv_2', U('2')]]);
  assert.equal(r.discovery_runs[0].items[0].url, 'https://events.humanitix.com/one');
  assert.equal(r.sent_posts.length, 1); // duplicates collapse; not_interesting and old ones are excluded
  assert.deepEqual([r.sent_posts[0].item_id, r.sent_posts[0].author, r.sent_posts[0].url], [U('4'), 'poet_one', 'https://www.instagram.com/p/ABC123']);
  assert.equal(personalRecent({ hours: 24 * 10 }, NOW).discovery_runs.length, 2);
  assert.throws(() => personalRecent({ hours: 0 }, NOW), FeedInputError);
});

test('personal_feedback accepts a url instead of an item id', () => {
  seed();
  const a = recordFeedback({ url: 'https://www.instagram.com/p/ABC123/?utm=x', type: 'like' });
  assert.equal(a.item_id, U('4'));
  const b = recordFeedback({ url: 'https://events.humanitix.com/one', type: 'save' });
  assert.equal(b.item_id, U('1'));
  assert.throws(() => recordFeedback({ url: 'https://example.com/none', type: 'like' }), /no known item/);
  assert.throws(() => recordFeedback({ url: 'not a url', type: 'like' }), FeedInputError);
  assert.throws(() => recordFeedback({ url: 'ftp://x/y', type: 'like' }), FeedInputError);
});

test('REST and MCP: recent needs the owner token and works with it', async () => {
  seed();
  const app = Fastify();
  registerPersonalRoutes(app);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/recent' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/recent?hours=100000', headers: auth })).statusCode, 400);
  const ok = await app.inject({ method: 'GET', url: '/api/personal/recent', headers: auth });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().schema_version, 'recent.v1');
  await app.close();

  const mk = async (ctx: any) => {
    const [x, y] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx).connect(x);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(y);
    return c;
  };
  const anon: any = await (await mk({})).callTool({ name: 'personal_recent', arguments: {} });
  assert.equal(anon.isError, true);
  const authed: any = await (await mk({ personalAuthorized: true })).callTool({ name: 'personal_recent', arguments: { hours: 24 } });
  assert.notEqual(authed.isError, true);
  assert.equal(JSON.parse(authed.content[0].text).schema_version, 'recent.v1');
});
