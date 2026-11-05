import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keysOverview } from '../../src/provider-keys.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-keys-'));
const env = (body: string) => { const f = join(dir, `env-${Math.random().toString(36).slice(2)}`); writeFileSync(f, body); return f; };

test('a configured free key means search spends the free plan', () => {
  const o = keysOverview(env('TINYFISH_API_KEY_2=hobby-not-a-real-key\n'));
  assert.equal(o.tinyfish.search_plan, 'free');
});

test('only a paid key means search is spending paid credit', () => {
  const o = keysOverview(env('TINYFISH_API_KEY=builder-not-a-real-key\n'));
  assert.equal(o.tinyfish.search_plan, 'paid');
  assert.equal(o.tinyfish.plans.find(p => p.plan === 'paid')?.configured, true);
});

test('the overview never carries the value itself', () => {
  const secret = 'sup3r-secret-value-should-not-leak';
  const o = keysOverview(env(`TINYFISH_API_KEY_2=${secret}\n`));
  assert.equal(JSON.stringify(o).includes(secret), false);
});

test('non-tinyfish keys are reported under keys, never under the plan split', () => {
  // keyStatus merges the env file with process.env, so only the split itself is asserted here.
  const o = keysOverview(env('FIRECRAWL_API_KEY=fc-not-a-real-key\n'));
  assert.ok(o.keys.some(k => k.provider === 'firecrawl'));
  assert.equal(o.tinyfish.plans.some(p => p.key.startsWith('FIRECRAWL')), false);
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
