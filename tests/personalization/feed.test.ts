import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getFeed, closePersonalDb, FeedInputError } from '../../src/personalization/feed.js';
import { splitCommand } from '../../src/personalization/collector.js';
import { openPersonalDb } from '../../src/personalization/db/index.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { checkBearer } from '../../src/personalization/auth.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-personal-'));
const dbPath = join(dir, 'p.db');
const argsFile = join(dir, 'args.log');
const fake = join(import.meta.dirname, 'fake-collector.mjs');
const TOKEN = 'test-token-not-real';

const counts = () => {
  const d = new DatabaseSync(dbPath);
  const c = (t: string) => (d.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number;
  const r = { items: c('items'), ids: c('item_ids'), obs: c('observations'), runs: c('collection_runs') };
  d.close();
  return r;
};

before(() => {
  process.env.PHROG_PERSONAL_DB = dbPath;
  process.env.PHROG_PERSONAL_TOKEN = TOKEN;
  process.env.PHROG_IG_COLLECTOR_CMD = `${process.execPath} ${fake}`;
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.PHROG_IG_COLLECTOR_TIMEOUT_S = '30';
});
beforeEach(() => { process.env.FAKE_MODE = 'ok'; });
after(() => { closePersonalDb(); rmSync(dir, { recursive: true, force: true }); });

test('ok page is stored and returned as feed.v1', async () => {
  const f = await getFeed({ provider: 'instagram', account: 'owner_one', limit: 3 });
  assert.equal(f.schema_version, 'feed.v1');
  assert.equal(f.status, 'ok');
  assert.equal(f.next_cursor, 'NEXT:abc==');
  assert.equal(f.items.length, 3);
  const [a, b, c] = f.items;
  assert.equal(a.posted_at, '2026-09-21T14:13:20.000Z');
  assert.equal(a.posted_precision, 'exact');
  assert.equal(b.posted_at, null);
  assert.equal(b.posted_precision, 'unknown');
  assert.equal(b.suggested, true);
  assert.equal(c.sponsored, true);
  assert.equal(a.seen_before, false);
  assert.equal(a.render, null);
  assert.deepEqual(counts(), { items: 3, ids: 3, obs: 3, runs: 1 });
});

test('re-running the same page: no duplicate items, seen_before, new observations', async () => {
  const f = await getFeed({ provider: 'instagram', account: 'owner_one', limit: 3 });
  assert.ok(f.items.every((i) => i.seen_before));
  assert.deepEqual(counts(), { items: 3, ids: 3, obs: 6, runs: 2 });
});

test('cursor is passed through as one argv element', async () => {
  await getFeed({ provider: 'instagram', account: 'owner_one', limit: 5, cursor: 'AbC_-=:.|x' });
  const last = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').pop()!);
  assert.deepEqual(last, ['--account', 'owner_one', '--limit', '5', '--cursor', 'AbC_-=:.|x']);
});

test('ssh collector gets remote-shell-quoted arguments', async () => {
  const bin = join(dir, 'ssh');
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${join(dir, 'ssh.out')}"\necho '{"status":"end","items":[]}'\n`);
  chmodSync(bin, 0o755);
  process.env.PHROG_IG_COLLECTOR_CMD = `${bin} host python3 x.py`;
  await getFeed({ provider: 'instagram', account: 'owner_one', limit: 2, cursor: 'a|b' });
  assert.equal(readFileSync(join(dir, 'ssh.out'), 'utf8').trim(), "host python3 x.py --account 'owner_one' --limit 2 --cursor 'a|b'");
  process.env.PHROG_IG_COLLECTOR_CMD = `${process.execPath} ${fake}`;
});

test('end status returns its items', async () => {
  process.env.FAKE_MODE = 'end';
  const f = await getFeed({ provider: 'instagram', account: 'owner_one', limit: 3 });
  assert.equal(f.status, 'end');
  assert.equal(f.next_cursor, null);
  assert.equal(f.items.length, 1);
});

for (const [mode, status] of [['auth', 'auth_required'], ['garbage', 'failed'], ['empty_ok', 'failed']] as const) {
  test(`${mode} -> ${status} with no items`, async () => {
    process.env.FAKE_MODE = mode;
    const before = counts();
    const f = await getFeed({ provider: 'instagram', account: 'owner_one', limit: 3 });
    assert.equal(f.status, status);
    assert.equal(f.items.length, 0);
    assert.equal(counts().obs, before.obs);
    assert.equal(counts().items, before.items);
  });
}

test('timeout -> failed', async () => {
  process.env.FAKE_MODE = 'hang';
  process.env.PHROG_IG_COLLECTOR_TIMEOUT_S = '0.5';
  const f = await getFeed({ provider: 'instagram', account: 'owner_one', limit: 3 });
  process.env.PHROG_IG_COLLECTOR_TIMEOUT_S = '30';
  assert.equal(f.status, 'failed');
  assert.match(f.error ?? '', /timed out/);
  assert.equal(f.items.length, 0);
});

test('invalid account, cursor, limit are rejected before running the collector', async () => {
  const n = readFileSync(argsFile, 'utf8').split('\n').length;
  for (const bad of [{ account: 'a b' }, { account: 'x;rm -rf' }, { account: '' }, { account: 'ok', cursor: "a'b" }, { account: 'ok', cursor: 'x'.repeat(4097) }, { account: 'ok', limit: 0 }]) {
    await assert.rejects(getFeed({ provider: 'instagram', limit: 3, ...bad } as any), FeedInputError);
  }
  assert.equal(readFileSync(argsFile, 'utf8').split('\n').length, n);
});

test('migrations: checksum mismatch is detected', () => {
  const p = join(dir, 'm.db');
  openPersonalDb(p).close();
  const d = new DatabaseSync(p);
  d.exec("UPDATE schema_migrations SET checksum = 'bad'");
  d.close();
  assert.throws(() => openPersonalDb(p), /checksum mismatch/);
});

test('splitCommand handles quotes', () => {
  assert.deepEqual(splitCommand(`ssh h "python3 a b" 'c d'`), ['ssh', 'h', 'python3 a b', 'c d']);
});

test('REST: 401 without token, 401 wrong token, 200 with token', async () => {
  const app = Fastify();
  registerPersonalRoutes(app);
  const url = '/api/personal/feed?provider=instagram&account=owner_two&limit=3';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const ok = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().items.length, 3);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/feed?account=bad%20name', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 400);
  delete process.env.PHROG_PERSONAL_TOKEN;
  assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 503);
  process.env.PHROG_PERSONAL_TOKEN = TOKEN;
  await app.close();
});

test('checkBearer', () => {
  assert.equal(checkBearer(`Bearer ${TOKEN}`), 'ok');
  assert.equal(checkBearer(undefined), 'unauthorized');
  assert.equal(checkBearer('Bearer nope'), 'unauthorized');
});

async function mcpClient(ctx: { personalAuthorized?: boolean }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

test('MCP: feed without auth returns auth-required, anonymous tools still listed; with auth works', async () => {
  const anon = await mcpClient({});
  const tools = (await anon.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('quick_search') && tools.includes('web_search') && tools.includes('feed'));
  const r: any = await anon.callTool({ name: 'feed', arguments: { account: 'owner_one', limit: 3 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /auth_required/);
  const authed = await mcpClient({ personalAuthorized: true });
  const ok: any = await authed.callTool({ name: 'feed', arguments: { account: 'owner_one', limit: 3 } });
  assert.notEqual(ok.isError, true);
  assert.equal(JSON.parse(ok.content[0].text).schema_version, 'feed.v1');
});

test('run log for personal calls holds no captions or token', () => {
  const log = process.env.PHROG_WEB_RUNLOG;
  if (!log || !existsSync(log)) return;
  const txt = readFileSync(log, 'utf8');
  assert.ok(!txt.includes('Caption number') && !txt.includes(TOKEN));
});
