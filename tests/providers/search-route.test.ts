import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSearchRoute } from '../../src/providers/search-route.js';

const TOKEN = 'test-only-secret';

test('POST /v1/search rejects missing auth and validates input', async () => {
  const app = Fastify();
  registerSearchRoute(app, async () => { throw new Error('should not execute'); });
  const original = process.env.PHROG_WEB_SEARCH_API_KEY;
  process.env.PHROG_WEB_SEARCH_API_KEY = TOKEN;
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'test' } })).statusCode, 401);
    const headers = { authorization: 'Bearer ' + TOKEN };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/search', headers, payload: { query: '   ' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/search', headers, payload: { query: 'valid', options: { limit: 0 } } })).statusCode, 400);
  } finally {
    if (original === undefined) delete process.env.PHROG_WEB_SEARCH_API_KEY;
    else process.env.PHROG_WEB_SEARCH_API_KEY = original;
    await app.close();
  }
});

test('POST /v1/search returns shared results and options on success', async () => {
  const app = Fastify();
  const expected = { query: 'test', results: [], provider_used: 'searxng', total: 0, contributingEngines: ['searxng'], failures: [] };
  let invoked: unknown;
  registerSearchRoute(app, async (query, options) => { invoked = { query, options }; return expected; });
  const original = process.env.PHROG_WEB_SEARCH_API_KEY;
  process.env.PHROG_WEB_SEARCH_API_KEY = TOKEN;
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/search', headers: { authorization: 'Bearer ' + TOKEN }, payload: { query: ' test ', options: { limit: 7 } } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), expected);
    assert.deepEqual(invoked, { query: 'test', options: { limit: 7 } });
  } finally {
    if (original === undefined) delete process.env.PHROG_WEB_SEARCH_API_KEY;
    else process.env.PHROG_WEB_SEARCH_API_KEY = original;
    await app.close();
  }
});

test('POST /v1/search reports provider failure as gateway error', async () => {
  const app = Fastify();
  registerSearchRoute(app, async () => { throw new Error('All search providers failed'); });
  const original = process.env.PHROG_WEB_SEARCH_API_KEY;
  process.env.PHROG_WEB_SEARCH_API_KEY = TOKEN;
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/search', headers: { authorization: 'Bearer ' + TOKEN }, payload: { query: 'test' } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error, 'All search providers failed');
  } finally {
    if (original === undefined) delete process.env.PHROG_WEB_SEARCH_API_KEY;
    else process.env.PHROG_WEB_SEARCH_API_KEY = original;
    await app.close();
  }
});
