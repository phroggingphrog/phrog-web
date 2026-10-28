import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearch } from '../../src/providers/search.js';
import { webSearch } from '../../src/providers/compat.js';

test('executeSearch combines duplicate URLs and exposes contributing engines', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return Response.json({ results: [
      { title: 'One', url: 'https://example.com/a#first', content: 'from searx', engine: 'alpha' },
      { title: 'Two', url: 'https://example.com/b', content: 'unique', engine: 'alpha' },
    ] });
    throw new Error('not configured');
  };
  process.env.TINYFISH_API_KEY = '';
  try {
    const result = await executeSearch('rrf test ' + Date.now(), { limit: 10 });
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.contributingEngines, ['searxng']);
    assert.deepEqual(result.failures?.map((f) => f.engine), ['tinyfish']);
    assert.equal(result.results[0].url, 'https://example.com/a#first');
    assert.equal(result.results[0].engine, 'alpha');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeSearch rejects when every configured provider fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalPipeline = process.env.PHROG_SEARCH_PIPELINE;
  process.env.PHROG_SEARCH_PIPELINE = 'searxng';
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    await assert.rejects(() => executeSearch('all fail ' + Date.now()), /All search providers failed/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPipeline === undefined) delete process.env.PHROG_SEARCH_PIPELINE;
    else process.env.PHROG_SEARCH_PIPELINE = originalPipeline;
  }
});

test('executeSearch honors an explicit provider and permits a successful empty result', async () => {
  const originalFetch = globalThis.fetch;
  const originalPipeline = process.env.PHROG_SEARCH_PIPELINE;
  process.env.PHROG_SEARCH_PIPELINE = 'tinyfish';
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    assert.equal(new URL(String(input)).hostname, '127.0.0.1');
    return Response.json({ results: [] });
  };
  try {
    const result = await executeSearch('explicit provider empty ' + Date.now(), { provider: 'searxng', limit: 4 });
    assert.equal(calls, 1);
    assert.equal(result.provider_used, 'searxng');
    assert.deepEqual(result.contributingEngines, ['searxng']);
    assert.deepEqual(result.results, []);
    assert.equal(result.total, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPipeline === undefined) delete process.env.PHROG_SEARCH_PIPELINE;
    else process.env.PHROG_SEARCH_PIPELINE = originalPipeline;
  }
});

test('executeSearch reports an unsupported provider instead of returning empty success', async () => {
  await assert.rejects(
    () => executeSearch('unsupported provider ' + Date.now(), { provider: 'not-a-provider' }),
    /All search providers failed.*Unknown search provider: not-a-provider/,
  );
});

test('executeSearch bounds result limits and reports a provider timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalPipeline = process.env.PHROG_SEARCH_PIPELINE;
  process.env.PHROG_SEARCH_PIPELINE = 'searxng';
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  try {
    await assert.rejects(
      () => executeSearch('timeout test ' + Date.now(), { limit: 500 }),
      /searxng: The operation was aborted due to timeout/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPipeline === undefined) delete process.env.PHROG_SEARCH_PIPELINE;
    else process.env.PHROG_SEARCH_PIPELINE = originalPipeline;
  }
});

test('webSearch preserves source engine attribution when filtering fused image results', async () => {
  const originalFetch = globalThis.fetch;
  const originalTinyfishKey = process.env.TINYFISH_API_KEY;
  process.env.TINYFISH_API_KEY = 'test-key';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return Response.json({ results: [
      { title: 'Icon', url: 'https://example.com/icon', content: 'icon', engine: 'lucide' },
      { title: 'Photo', url: 'https://example.com/photo', content: 'photo', engine: 'google' },
    ] });
    if (url.hostname === 'api.search.tinyfish.ai') return Response.json({ results: [
      { title: 'Icon duplicate', url: 'https://example.com/icon', snippet: 'same icon' },
    ] });
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await webSearch({ query: 'image attribution ' + Date.now(), categories: 'images' });
    assert.equal(result.results.some((item) => item.url === 'https://example.com/icon'), true);
    assert.deepEqual(result.results.find((item) => item.url.includes('/icon'))?.engines, ['tinyfish']);
    assert.equal(result.results[0]?.url, 'https://example.com/photo');
    const fused = await executeSearch('provider attribution ' + Date.now(), { limit: 10 });
    assert.deepEqual(fused.contributingEngines, ['searxng', 'tinyfish']);
    assert.equal(fused.results.find((item) => item.url.includes('/icon'))?.engine, 'lucide,tinyfish');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTinyfishKey === undefined) delete process.env.TINYFISH_API_KEY;
    else process.env.TINYFISH_API_KEY = originalTinyfishKey;
  }
});
