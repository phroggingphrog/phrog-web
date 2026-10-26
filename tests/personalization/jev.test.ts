import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getFeed, closePersonalDb, FeedInputError } from '../../src/personalization/feed.js';
import { feedDecide } from '../../src/personalization/decisions.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { setCardRenderer } from '../../src/personalization/render.js';
import { preferenceSummary } from '../../src/personalization/jev.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-jev-'));
const fake = join(import.meta.dirname, 'fake-collector-jev.mjs');
const TOKEN = 'test-token-not-real';
const taste = join(dir, 'taste.md');
let n = 0;
let dbPath = '';
let jevCalls: any[] = [];
let rendered: string[][] = [];
let server: Server;

// 1x1 PNG with a real IHDR so width/height parse.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body);
      jevCalls.push({ auth: req.headers.authorization, body: b });
      const great = String(b.state.post.caption).includes('great');
      const probs = great ? { 0: 0, 1: 0.1, 2: 0.2, 3: 0.7 } : { 0: 0.8, 1: 0.1, 2: 0.1, 3: 0 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'typesafe/jev-test-1', usage: { cost: 0.01 },
        answers: { match: { type: 'score', score: 1, probabilities: probs, confidence: 0.9 }, engage: { type: 'noul', noul: great ? 0.8 : 0.2 } },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PHROG_JEV_URL = `http://127.0.0.1:${(server.address() as any).port}/decisions`;
  process.env.OPENROUTER_API_KEY = 'fake-key-not-real';
  process.env.PHROG_PERSONAL_TOKEN = TOKEN;
  process.env.PHROG_IG_COLLECTOR_CMD = `${process.execPath} ${fake}`;
  process.env.PHROG_PERSONAL_ARTIFACTS_DIR = join(dir, 'artifacts');
  process.env.PHROG_TASTE_FILE = taste;
});
beforeEach(() => {
  closePersonalDb();
  dbPath = join(dir, `p${++n}.db`);
  process.env.PHROG_PERSONAL_DB = dbPath;
  delete process.env.PHROG_JEV_MAX_POSTS_PER_DAY;
  delete process.env.PHROG_JEV_MAX_USD_PER_DAY;
  delete process.env.PHROG_JEV_MAX_PASS_PER_PAGE;
  writeFileSync(taste, 'likes jazz and markets');
  jevCalls = [];
  rendered = [];
  setCardRenderer(async (cards) => { rendered.push(cards.map((c) => c.author ?? '')); return cards.map(() => ({ png: PNG, width: 1, height: 1 })); });
});
after(() => { closePersonalDb(); setCardRenderer(null); server.close(); rmSync(dir, { recursive: true, force: true }); });

const feed = (extra: object = {}) => getFeed({ provider: 'instagram', account: 'owner_one', filter: 'jev', ...extra });
const q = (sql: string) => { const d = new DatabaseSync(dbPath); const r = d.prepare(sql).all() as any[]; d.close(); return r; };

test('threshold: high posts pass, low are filtered out, text-less passes as no_text; screenshots only for passed', async () => {
  const f = await feed();
  assert.equal(f.filtered_out, 2);
  assert.deepEqual(f.items.map((i: any) => i.author.handle), ['poster1', 'poster3', 'poster4']);
  const by = Object.fromEntries(f.items.map((i: any) => [i.author.handle, i]));
  assert.deepEqual(by.poster1.filter, { passed: true, reason: 'above_threshold' });
  assert.deepEqual(by.poster3.filter, { passed: true, reason: 'no_text' });
  assert.equal(by.poster3.prediction, null);
  const p = by.poster1.prediction;
  assert.equal(p.p_match, 0.9); // P(medium) + P(high) = 0.2 + 0.7
  assert.equal(p.p_engage, 0.8);
  assert.equal(p.confidence, 0.9);
  assert.equal(p.cost_usd, 0.01);
  assert.equal(p.calibrated, false);
  assert.equal(p.scorer, 'jev');
  assert.equal(p.model_version, 'typesafe/jev-test-1');
  assert.match(p.preference_summary_version, /^[0-9a-f]{12}$/);
  assert.match(by.poster1.render.screenshot, /^\/api\/personal\/artifacts\/art_/);
  assert.equal(by.poster1.render.width, 1);
  assert.equal(jevCalls.length, 4); // the empty post is not sent to Jev
  assert.equal(jevCalls[0].auth, 'Bearer fake-key-not-real');
  assert.deepEqual(rendered.flat().sort(), ['poster1', 'poster3', 'poster4']);
  assert.equal(q('SELECT * FROM predictions').length, 4);
  const art = q('SELECT path FROM artifacts');
  assert.equal(art.length, 3);
  assert.equal(statSync(art[0].path).mode & 0o777, 0o600);
});

test('include_filtered returns everything; filtered posts have a prediction but no screenshot', async () => {
  const f = await feed({ include_filtered: true });
  assert.equal(f.items.length, 5);
  assert.equal(f.filtered_out, 2);
  const low = f.items.find((i: any) => i.author.handle === 'poster2') as any;
  assert.deepEqual(low.filter, { passed: false, reason: 'below_threshold' });
  assert.equal(low.prediction.p_match, 0.1);
  assert.equal(low.render, null);
  assert.equal(rendered.flat().length, 3);
});

test('order=predicted sorts by p_match; it needs filter jev', async () => {
  const f = await feed({ include_filtered: true, order: 'predicted' });
  const p = f.items.map((i: any) => i.prediction?.p_match ?? null);
  assert.deepEqual(p, [0.9, 0.9, 0.1, 0.1, null]);
  await assert.rejects(getFeed({ provider: 'instagram', account: 'owner_one', order: 'predicted' }), FeedInputError);
});

test('exploration 1 lets below-threshold posts through', async () => {
  const f = await feed({ exploration: 1 });
  assert.equal(f.filtered_out, 0);
  assert.equal((f.items.find((i: any) => i.author.handle === 'poster2') as any).filter.reason, 'exploration');
});

test('cache: same preference summary version skips Jev; a changed summary scores again', async () => {
  await feed();
  assert.equal(jevCalls.length, 4);
  const again = await feed();
  assert.equal(jevCalls.length, 4);
  assert.equal(again.items.length, 3);
  assert.equal(rendered.length, 1); // screenshots are reused too
  const v1 = preferenceSummary().version;
  writeFileSync(taste, 'likes jazz, markets and ceramics');
  assert.notEqual(preferenceSummary().version, v1);
  await feed();
  assert.equal(jevCalls.length, 8);
});

test('budget: stops scoring past the daily post limit and reports reason budget', async () => {
  process.env.PHROG_JEV_MAX_POSTS_PER_DAY = '2';
  const f = await feed({ include_filtered: true });
  assert.equal(jevCalls.length, 2);
  const budget = f.items.filter((i: any) => i.filter.reason === 'budget') as any[];
  assert.equal(budget.length, 2);
  assert.ok(budget.every((i) => i.prediction === null && i.filter.passed === false && i.render === null));
  // The limit counts today's stored predictions, so a second page cannot score more.
  await feed();
  assert.equal(jevCalls.length, 2);
});

test('budget: dollar limit', async () => {
  process.env.PHROG_JEV_MAX_USD_PER_DAY = '0';
  const f = await feed({ include_filtered: true });
  assert.equal(jevCalls.length, 0);
  assert.equal(f.items.filter((i: any) => i.filter.reason === 'budget').length, 4);
});

test('page cap limits passed posts, highest first', async () => {
  process.env.PHROG_JEV_MAX_PASS_PER_PAGE = '1';
  const f = await feed({ include_filtered: true });
  assert.equal(f.items.filter((i: any) => i.filter.passed).length, 1);
  assert.equal(f.items.filter((i: any) => i.filter.reason === 'page_cap').length, 2);
});

test('without filter nothing is scored or rendered', async () => {
  const f = await getFeed({ provider: 'instagram', account: 'owner_one' });
  assert.equal(f.filtered_out, 0);
  assert.equal(f.items.length, 5);
  assert.equal(jevCalls.length, 0);
  assert.equal(f.items[0].prediction, null);
});

test('feed_decide stores a decision linked to the latest prediction and is idempotent', async () => {
  const f = await feed();
  const item = f.items[0] as any;
  const a = feedDecide({ item_id: item.item_id, decision: 'send_to_owner', reason: 'looks great', idempotency_key: 'k1', client: 'mcp' });
  assert.equal(a.duplicate, false);
  assert.ok(a.prediction_id?.startsWith('pred_'));
  assert.ok(a.collection_run_id?.startsWith('run_'));
  const b = feedDecide({ item_id: item.item_id, decision: 'not_interesting', idempotency_key: 'k1' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  assert.equal(b.decision, 'send_to_owner');
  assert.equal(q('SELECT * FROM agent_decisions').length, 1);
  assert.throws(() => feedDecide({ item_id: f.items[1].item_id, decision: 'save_event', idempotency_key: 'k1' }), FeedInputError);
  assert.throws(() => feedDecide({ item_id: item.item_id, decision: 'maybe' }), FeedInputError);
  assert.throws(() => feedDecide({ item_id: 'it_00000000-0000-0000-0000-000000000000', decision: 'interesting' }), FeedInputError);
  // Decisions without a key are separate rows.
  feedDecide({ item_id: item.item_id, decision: 'interesting' });
  feedDecide({ item_id: item.item_id, decision: 'interesting' });
  assert.equal(q('SELECT * FROM agent_decisions').length, 3);
});

test('new routes need the owner token; artifacts are served as PNG', async () => {
  const f = await feed();
  const shot = (f.items[0] as any).render.screenshot as string;
  const app = Fastify();
  registerPersonalRoutes(app);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await app.inject({ method: 'GET', url: shot })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: shot, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const ok = await app.inject({ method: 'GET', url: shot, headers: auth });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.deepEqual(ok.rawPayload, PNG);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/artifacts/art_nope', headers: auth })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/artifacts/..%2F..%2Fetc%2Fpasswd', headers: auth })).statusCode, 404);

  const body = { item_id: (f.items[0] as any).item_id, decision: 'interesting', reason: 'r', idempotency_key: 'rest1' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/personal/feed/decide', payload: body })).statusCode, 401);
  const d = await app.inject({ method: 'POST', url: '/api/personal/feed/decide', payload: body, headers: auth });
  assert.equal(d.statusCode, 200);
  assert.equal(d.json().client, 'rest');
  assert.equal((await app.inject({ method: 'POST', url: '/api/personal/feed/decide', payload: { ...body, decision: 'x' }, headers: auth })).statusCode, 400);
  const fl = await app.inject({ method: 'GET', url: '/api/personal/feed?account=owner_one&filter=jev', headers: auth });
  assert.equal(fl.statusCode, 200);
  assert.equal(fl.json().filtered_out, 2);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/feed?account=owner_one&filter=nope', headers: auth })).statusCode, 400);
});

test('MCP feed returns JSON text then one image per passed post (capped); feed_decide works and is auth gated', async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ personalAuthorized: true }).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const r: any = await client.callTool({ name: 'feed', arguments: { account: 'owner_one', filter: 'jev' } });
  assert.equal(r.content[0].type, 'text');
  const json = JSON.parse(r.content[0].text);
  assert.equal(json.items.length, 3);
  const imgs = r.content.filter((c: any) => c.type === 'image');
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(imgs[0].data, 'base64'), PNG);
  const d: any = await client.callTool({ name: 'feed_decide', arguments: { item_id: json.items[0].item_id, decision: 'interesting', idempotency_key: 'm1' } });
  assert.equal(JSON.parse(d.content[0].text).client, 'mcp');

  const [a2, b2] = InMemoryTransport.createLinkedPair();
  await createMcpServer({}).connect(a2);
  const anon = new Client({ name: 't', version: '0' });
  await anon.connect(b2);
  const denied: any = await anon.callTool({ name: 'feed_decide', arguments: { item_id: json.items[0].item_id, decision: 'interesting' } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /auth_required/);
});

test('key file is used when configured', async () => {
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'file-key-not-real\n', { mode: 0o600 });
  process.env.PHROG_JEV_KEY_FILE = keyFile;
  try { await feed(); } finally { delete process.env.PHROG_JEV_KEY_FILE; }
  assert.equal(jevCalls[0].auth, 'Bearer file-key-not-real');
  assert.ok(existsSync(keyFile) && readFileSync(keyFile, 'utf8').startsWith('file-key'));
});
