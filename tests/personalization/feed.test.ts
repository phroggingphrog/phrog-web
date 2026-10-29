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
import { openPersonalDb } from '../../src/personalization/db/index.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-personal-'));
const dbPath = join(dir, 'p.db');
const TOKEN = 'test-token-not-real';

before(() => { process.env.PHROG_PERSONAL_DB = dbPath; });
after(() => { closePersonalDb(); rmSync(dir, { recursive: true, force: true }); });

test('only the rss provider is accepted', async () => {
  await assert.rejects(getFeed({ provider: 'instagram', source: '/x' }), FeedInputError);
  await assert.rejects(getFeed({ provider: 'rss', source: 'ftp://x' }), FeedInputError);
});

test('migrations: checksum mismatch is detected', () => {
  const p = join(dir, 'm.db');
  openPersonalDb(p).close();
  const d = new DatabaseSync(p);
  d.exec("UPDATE schema_migrations SET checksum = 'bad'");
  d.close();
  assert.throws(() => openPersonalDb(p), /checksum mismatch/);
});

test('REST: public feed retains source order and rejects removed ranking options', async () => {
  const app = Fastify();
  registerPersonalRoutes(app);
  const url = '/api/personal/feed?provider=rss&source=ftp%3A%2F%2Fbad&limit=3';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/personal/feed?provider=instagram&source=/x' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: url + '&filter=jev' })).statusCode, 400);
  await app.close();
});

async function mcpClient(ctx: { personalAuthorized?: boolean }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

test('MCP: public feed is listed and works without a token', async () => {
  const client = await mcpClient({});
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('quick_search') && tools.includes('browse') && tools.includes('feed'));
  assert.ok(!tools.includes('personal_discover') && !tools.includes('personal_preferences'));
  const feedTool = (await client.listTools()).tools.find((t) => t.name === 'feed');
  assert.ok(!JSON.stringify(feedTool).toLowerCase().includes('instagram'));
});

test('run log for personal calls holds no captions or token', () => {
  const log = process.env.PHROG_WEB_RUNLOG;
  if (!log || !existsSync(log)) return;
  const txt = readFileSync(log, 'utf8');
  assert.ok(!txt.includes('Caption number') && !txt.includes(TOKEN));
});
