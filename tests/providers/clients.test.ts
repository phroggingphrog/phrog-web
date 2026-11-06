import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authMode, clientsPath, createClient, listClients, resolveToken, revokeClient, tokenFromHeaders,
} from '../../src/clients.js';
import { runWithClient } from '../../src/context.js';
import { writeRun } from '../../src/runlog.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phrog-clients-'));
  process.env.PHROG_WEB_CLIENTS_FILE = join(dir, 'clients.json');
  process.env.PHROG_WEB_RUNLOG = join(dir, 'runs.jsonl');
  delete process.env.PHROG_WEB_MCP_AUTH;
});
afterEach(() => {
  delete process.env.PHROG_WEB_CLIENTS_FILE;
  delete process.env.PHROG_WEB_RUNLOG;
  delete process.env.PHROG_WEB_MCP_AUTH;
});

test('a created client resolves its own token and nothing else', () => {
  const { name, token } = createClient('codex');
  assert.equal(name, 'codex');
  assert.equal(resolveToken(token), 'codex');
  assert.equal(resolveToken('not-a-real-token'), undefined);
  assert.equal(resolveToken(undefined), undefined);
});

test('the registry stores a hash, never the token', () => {
  const { token } = createClient('hermes');
  const raw = readFileSync(clientsPath(), 'utf8');
  assert.ok(!raw.includes(token));
  assert.match(raw, /[0-9a-f]{64}/);
  assert.equal(statSync(clientsPath()).mode & 0o777, 0o600);
});

test('listing never exposes a token or a hash', () => {
  const { token } = createClient('claude-code');
  const listed = listClients();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'claude-code');
  assert.ok(!('hash' in listed[0]) && !('token' in listed[0]));
  assert.equal(listed[0].last_seen, undefined);
  assert.ok(!JSON.stringify(listed).includes(token));
});

test('rotation invalidates the previous token', () => {
  const first = createClient('opencode');
  const second = createClient('opencode');
  assert.equal(second.rotated, true);
  assert.equal(resolveToken(first.token), undefined);
  assert.equal(resolveToken(second.token), 'opencode');
});

test('revoking removes access and reports whether it existed', () => {
  const { token } = createClient('codex');
  assert.equal(revokeClient('codex'), true);
  assert.equal(revokeClient('codex'), false);
  assert.equal(resolveToken(token), undefined);
  assert.equal(listClients().length, 0);
});

test('names that could break a URL or a log are refused', () => {
  for (const bad of ['', 'has space', 'UPPER ok but space', 'x'.repeat(33), '../etc', 'a/b']) {
    assert.throws(() => createClient(bad), /Client name/);
  }
  assert.doesNotThrow(() => createClient('a.b_c-d9'));
});

test('usage is counted per client', () => {
  const { token } = createClient('codex');
  resolveToken(token);
  resolveToken(token);
  assert.equal(listClients()[0].calls, 2);
});

test('token headers: bearer, bare, header, and an unexpanded variable', () => {
  assert.equal(tokenFromHeaders({ authorization: 'Bearer abc123' }), 'abc123');
  assert.equal(tokenFromHeaders({ authorization: 'abc123' }), 'abc123');
  assert.equal(tokenFromHeaders({ 'x-phrog-client': 'abc123' }), 'abc123');
  // Hermes writes ${VAR} into its config; an unexpanded name must read as "no token", not as a bad one.
  assert.equal(tokenFromHeaders({ authorization: 'Bearer ${HERMES_PHROG_WEB_AUTHORIZATION}' }), undefined);
  assert.equal(tokenFromHeaders({}), undefined);
});

test('auth mode defaults to warn and honours the override', () => {
  assert.equal(authMode(), 'warn');
  process.env.PHROG_WEB_MCP_AUTH = 'enforce';
  assert.equal(authMode(), 'enforce');
  process.env.PHROG_WEB_MCP_AUTH = 'nonsense';
  assert.equal(authMode(), 'warn');
});

test('a run record carries the client that made it, and none when there is no request', () => {
  runWithClient('codex', () => writeRun({ kind: 'mcp', tool: 'fetch', ok: true }));
  writeRun({ kind: 'mcp', tool: 'boot', ok: true });
  const lines = readFileSync(process.env.PHROG_WEB_RUNLOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].client, 'codex');
  assert.equal(lines[1].client, undefined);
});

test('an unreadable registry is treated as empty rather than crashing', () => {
  writeFileSync(clientsPath(), 'not json at all');
  assert.deepEqual(listClients(), []);
  const { token } = createClient('hermes');
  assert.equal(resolveToken(token), 'hermes');
});
