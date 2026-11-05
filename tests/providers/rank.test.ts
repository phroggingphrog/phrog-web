import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalKey, freshnessScore, officialDomainScore, fuseEngineRanks, DEFAULT_RRF,
} from '../../src/providers/rank.js';

test('two engines agreeing at rank 1 outrank a single engine rank 1', () => {
  const fused = fuseEngineRanks([
    { url: 'https://a.example/x', engines: ['bing'], positions: [1] },
    { url: 'https://b.example/y', engines: ['bing', 'ddg'], positions: [1, 1] },
  ], {}, {}, 'test');
  assert.equal(fused[0].url, 'https://b.example/y');
  assert.ok(fused[0].score > fused[1].score);
});

test('a deep-but-duplicated row can beat a shallow single-engine hit', () => {
  const fused = fuseEngineRanks([
    { url: 'https://shallow.example/', engines: ['bing'], positions: [1] },
    { url: 'https://deep.example/', engines: ['bing', 'ddg', 'mwmbl'], positions: [6, 7, 8] },
  ], {}, {}, 'test');
  assert.equal(fused[0].url, 'https://deep.example/');
});

test('official docs host wins a tie against an SEO farm', () => {
  const fused = fuseEngineRanks([
    { url: 'https://seo-farm.example/podman', engines: ['bing'], positions: [1] },
    { url: 'https://docs.podman.io/en/latest/', engines: ['bing'], positions: [1] },
  ], {}, {}, 'podman quadlet');
  assert.equal(fused[0].url, 'https://docs.podman.io/en/latest/');
});

test('query naming the project promotes its own host', () => {
  assert.equal(officialDomainScore('kubernetes.io', ['kubernetes', 'ingress']), 1);
  assert.equal(officialDomainScore('random-blog.example', ['kubernetes', 'ingress']), 0);
});

test('fresh page beats a stale one at equal rank', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const fused = fuseEngineRanks([
    { url: 'https://old.example/a', engines: ['bing'], positions: [1], publishedDate: '2024-01-01T00:00:00Z' },
    { url: 'https://new.example/b', engines: ['bing'], positions: [1], publishedDate: '2026-11-01T00:00:00Z' },
  ], {}, {}, 'test', now);
  assert.equal(fused[0].url, 'https://new.example/b');
});

test('freshnessScore decays and refuses unparseable dates', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(freshnessScore(null, 30, now), 0);
  assert.equal(freshnessScore('not a date', 30, now), 0);
  assert.equal(freshnessScore('2026-11-05T00:00:00Z', 30, now), 1);
  const half = freshnessScore('2026-10-21T00:00:00Z', 30, now);
  assert.ok(half > 0.4 && half < 0.6, 'expected ~0.5, got ' + half);
});

test('canonicalKey drops tracking params, hashes and trailing slashes', () => {
  assert.equal(canonicalKey('https://A.example/x/'), 'https://a.example/x');
  assert.equal(canonicalKey('https://a.example/x#frag'), 'https://a.example/x');
  assert.equal(canonicalKey('https://a.example/x?utm_source=feed'), 'https://a.example/x?utm_source=feed');
});

test('duplicate rows merge engines instead of splitting votes', () => {
  const fused = fuseEngineRanks([
    { url: 'https://a.example/x/', engines: ['bing'], positions: [2] },
    { url: 'https://a.example/x', engines: ['ddg'], positions: [1] },
  ], {}, {}, 'test');
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0].engines.sort(), ['bing', 'ddg']);
});

test('rows without engines/positions fall back to input order', () => {
  const fused = fuseEngineRanks([
    { url: 'https://one.example/' },
    { url: 'https://two.example/' },
  ], {}, {}, 'test');
  assert.equal(fused[0].url, 'https://one.example/');
});

test('engine weights lift a precise engine', () => {
  const fused = fuseEngineRanks([
    { url: 'https://noisy.example/', engines: ['noisy'], positions: [1] },
    { url: 'https://precise.example/', engines: ['anysearch'], positions: [1] },
  ], {}, undefined, 'test');
  assert.equal(fused[0].url, 'https://precise.example/');
});

test('knobs are overridable and defaults match upstream', () => {
  assert.equal(DEFAULT_RRF.rrfConstant, 60);
  assert.equal(DEFAULT_RRF.authorityBoost, 0.25);
  assert.equal(DEFAULT_RRF.freshnessBoost, 0.2);
  assert.equal(DEFAULT_RRF.freshnessDays, 30);
  const strict = fuseEngineRanks([
    { url: 'https://seo.example/', engines: ['bing'], positions: [1] },
    { url: 'https://docs.podman.io/', engines: ['bing'], positions: [1] },
  ], { authorityBoost: 0 }, {}, 'podman');
  assert.equal(strict[0].url, 'https://seo.example/');
});
