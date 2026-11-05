import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createBrowserSession, closeBrowserSession, parseDocument, checkMonitor, listMonitors } from '../../src/providers/cookbook.js';

function withEnv(vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test('a browser session without a url is refused before it can meter', async () => {
  const restore = withEnv({ TINYFISH_API_KEY: 'k' });
  await assert.rejects(() => createBrowserSession({}), /url is required/);
  restore();
});

test('a browser session without the Builder key is refused', async () => {
  const restore = withEnv({ TINYFISH_API_KEY: undefined });
  await assert.rejects(() => createBrowserSession({ url: 'https://example.com' }), /TINYFISH_API_KEY/);
  restore();
});

test('createBrowserSession POSTs to the session endpoint with the API key header', async () => {
  const restore = withEnv({ TINYFISH_API_KEY: 'builder-key', PHROG_WEB_BROWSER_URL: 'https://example.test/v1/browser' });
  let seen: { url: string; method?: string; key?: string; body?: string } = { url: '' };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), method: init.method, key: (init.headers as Record<string, string>)['X-API-Key'], body: String(init.body) };
    return new Response(JSON.stringify({ session_id: 'tf-1', cdp_url: 'wss://x', base_url: 'https://x' }), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await createBrowserSession({ url: 'https://example.com', profile: 'stealth' });
    assert.equal(out.session_id, 'tf-1');
    assert.equal(out.plan, 'paid');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.key, 'builder-key');
    assert.match(seen.body!, /example\.com/);
  } finally { globalThis.fetch = original; restore(); }
});

test('closeBrowserSession DELETEs the session id and reports a 204 as closed', async () => {
  const restore = withEnv({ TINYFISH_API_KEY: 'builder-key', PHROG_WEB_BROWSER_URL: 'https://example.test/v1/browser' });
  let seenUrl = ''; let seenMethod = '';
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seenUrl = String(url); seenMethod = String(init.method);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const out = await closeBrowserSession('tf-9');
    assert.deepEqual(out, { closed: true, status: 204 });
    assert.equal(seenMethod, 'DELETE');
    assert.equal(seenUrl, 'https://example.test/v1/browser/tf-9');
  } finally { globalThis.fetch = original; restore(); }
});

test('closeBrowserSession reports an unknown session as not closed', async () => {
  const restore = withEnv({ TINYFISH_API_KEY: 'builder-key', PHROG_WEB_BROWSER_URL: 'https://example.test/v1/browser' });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  try {
    assert.deepEqual(await closeBrowserSession('tf-gone'), { closed: false, status: 404 });
  } finally { globalThis.fetch = original; restore(); }
});

test('parseDocument needs a url or base64, and base64 needs a known document extension', async () => {
  await assert.rejects(() => parseDocument({}), /url or base64 is required/);
  await assert.rejects(() => parseDocument({ base64: 'aGVsbG8=', filename: 'notes.txt' }), /filename must end with/);
  await assert.rejects(() => parseDocument({ base64: '', filename: 'doc.pdf' }), /decoded to zero bytes/);
});

test('checkMonitor refuses an unknown id instead of inventing a result', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mon-'));
  const file = resolve(dir, 'monitors.json');
  writeFileSync(file, '{}');
  const restore = withEnv({ PHROG_WEB_MONITOR_FILE: file });
  try {
    await assert.rejects(() => checkMonitor('does-not-exist'), /unknown monitor/);
    assert.deepEqual(listMonitors(), []);
  } finally { restore(); }
});
