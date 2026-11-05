import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/providers/agent.js';

// Validation happens before any network call, so these run offline.

test('the agent refuses an empty request', async () => {
  await assert.rejects(() => runAgent({}), /goal \(or query\) must be 1-2000 characters/);
});

test('a goal without a url is refused: query is the query-only spelling', async () => {
  await assert.rejects(() => runAgent({ goal: 'something' }), /url is required unless query is given/);
});

test('a query cannot ask for a page-bound rung', async () => {
  await assert.rejects(() => runAgent({ query: 'podman', mode: 'browse' }), /mode browse needs a url/);
  await assert.rejects(() => runAgent({ query: 'podman', mode: 'fetch' }), /mode fetch needs a url/);
});

test('a page-bound goal still requires an http(s) url', async () => {
  await assert.rejects(() => runAgent({ url: 'ftp://example.com', goal: 'x' }), /url must start with http/);
});

test('an over-long goal is refused rather than truncated silently', async () => {
  await assert.rejects(() => runAgent({ query: 'x'.repeat(2001) }), /1-2000 characters/);
});
