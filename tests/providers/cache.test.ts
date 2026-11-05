import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cacheSet, cacheClear, cacheResetStats, cacheStats, cacheKeyFetch } from '../../src/cache.js';

beforeEach(() => { cacheClear(); cacheResetStats(); });

test('a stored value comes back with its age', () => {
  cacheSet('k', { markdown: 'x' });
  const hit = cacheGet<{ markdown: string }>('k');
  assert.equal(hit?.value.markdown, 'x');
  assert.equal(hit?.ageSeconds, 0);
});

test('the key differs by mode and maxChars, so a browser read is not served a plain body', () => {
  const a = cacheKeyFetch('https://x.test/', { mode: 'auto', maxChars: 100 });
  const b = cacheKeyFetch('https://x.test/', { mode: 'browser', maxChars: 100 });
  const c = cacheKeyFetch('https://x.test/', { mode: 'auto', maxChars: 200 });
  assert.equal(new Set([a, b, c]).size, 3);
});

test('an expired entry is a miss and is dropped', () => {
  cacheSet('k', { a: 1 });
  assert.equal(cacheGet('k', { ttlMs: -1 }), undefined);
  assert.equal(cacheStats().expired, 1);
  assert.equal(cacheGet('k'), undefined);
});

test('entries beyond maxEntries are evicted oldest first', () => {
  for (let i = 0; i < 5; i++) cacheSet(`k${i}`, { i }, { maxEntries: 2 });
  const stats = cacheStats({ maxEntries: 2 });
  assert.equal(stats.entries, 2);
  assert.ok(stats.evictions >= 3);
  assert.equal(cacheGet('k0'), undefined);
  assert.equal(cacheGet('k4')?.value.i, 4);
});

test('a value larger than maxBytes is refused rather than stored', () => {
  cacheSet('big', { blob: 'x'.repeat(500) }, { maxBytes: 100 });
  assert.equal(cacheGet('big'), undefined);
});

test('stats count hits and misses', () => {
  cacheSet('k', 1);
  cacheGet('k');
  cacheGet('missing');
  const s = cacheStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.hit_rate, 0.5);
});

test('clear reports how many entries it dropped but keeps the lifetime counters', () => {
  cacheSet('a', 1); cacheSet('b', 2);
  cacheGet('a');
  assert.equal(cacheClear(), 2);
  const s = cacheStats();
  assert.equal(s.entries, 0);
  assert.equal(s.hits, 1);
});
