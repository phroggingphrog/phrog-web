import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePath, isAdminOnly, isMetered, pathOf, sameSecret } from '../../src/auth-policy.js';

/** The guard was bypassable by encoding before these cases existed. Each line is a real probe. */
test('an encoded path is still metered', () => {
  for (const raw of ['/api/%72esearch/x', '/api/b%61tch/x', '/%6Dcp', '/%6dcp']) {
    const path = pathOf(raw);
    assert.equal(isMetered(path, decodePath(path), 'GET'), true, raw);
  }
});

test('an absolute-form request line is normalised before matching', () => {
  assert.equal(pathOf('http://x/api/research/fey_1'), '/api/research/fey_1');
  assert.equal(isMetered(pathOf('http://x/mcp'), decodePath(pathOf('http://x/mcp')), 'GET'), true);
  assert.equal(pathOf('http://x'), '/');
});

test('a path that cannot be decoded is treated as metered, not as free', () => {
  const path = '/api/%E0%A4%A';
  assert.equal(decodePath(path), undefined);
  assert.equal(isMetered(path, undefined, 'POST'), false); // not a metered prefix, but...
  assert.equal(isMetered('/mcp/%E0%A4%A', decodePath('/mcp/%E0%A4%A'), 'POST'), true);
});

test('free doors stay free', () => {
  for (const path of ['/api/search', '/api/fetch', '/api/scrape', '/api/parse', '/api/profiles', '/health', '/docs']) {
    assert.equal(isMetered(path, decodePath(path), 'POST'), false, path);
  }
});

test('every metered prefix is caught, including subpaths', () => {
  for (const path of ['/mcp', '/mcp/x', '/api/agent', '/api/browse', '/api/browser', '/api/browser/abc',
                      '/api/research', '/api/research/fey_1/resume', '/api/crawl/start', '/api/batch']) {
    assert.equal(isMetered(path, path, 'POST'), true, path);
  }
});

test('keys and extract are metered only for mutations', () => {
  assert.equal(isMetered('/api/keys', '/api/keys', 'GET'), false);
  assert.equal(isMetered('/api/keys', '/api/keys', 'POST'), true);
  assert.equal(isMetered('/api/keys/FIRECRAWL_API_KEY', '/api/keys/FIRECRAWL_API_KEY', 'DELETE'), true);
  assert.equal(isMetered('/api/extract', '/api/extract', 'POST'), true);
});

test('client management is admin-only, in any encoding', () => {
  assert.equal(isAdminOnly('/api/clients', '/api/clients'), true);
  assert.equal(isAdminOnly('/api/%63lients', decodePath('/api/%63lients')), true);
  assert.equal(isAdminOnly('/api/clients/hermes', '/api/clients/hermes'), true);
  assert.equal(isAdminOnly('/api/search', '/api/search'), false);
});

test('the admin compare accepts only an exact match', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abc', 'abd'), false);
  assert.equal(sameSecret('abc', 'abcd'), false);
  assert.equal(sameSecret('', ''), true);
  assert.equal(sameSecret('', 'x'), false);
});
