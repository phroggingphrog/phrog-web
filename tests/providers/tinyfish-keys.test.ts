import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tinyfishKeys, tinyfishKeyOrder, isKeyExhaustedStatus,
  noteTinyfishKeySuccess, resetTinyfishKeyPreference, runWithTinyfishKeys,
} from '../../src/providers/tinyfish-keys.js';

function withKeys(a: string | undefined, b: string | undefined, fn: () => Promise<void>) {
  const saved = [process.env.TINYFISH_API_KEY, process.env.TINYFISH_API_KEY_2];
  if (a === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = a;
  if (b === undefined) delete process.env.TINYFISH_API_KEY_2; else process.env.TINYFISH_API_KEY_2 = b;
  resetTinyfishKeyPreference();
  return fn().finally(() => {
    if (saved[0] === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.TINYFISH_API_KEY_2; else process.env.TINYFISH_API_KEY_2 = saved[1];
    resetTinyfishKeyPreference();
  });
}

const exhausted = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test('tinyfishKeys collects both keys and drops blanks', async () => {
  await withKeys('key-one', '   ', async () => {
    assert.deepEqual(tinyfishKeys(), ['key-one']);
  });
  await withKeys('key-one', 'key-two', async () => {
    assert.deepEqual(tinyfishKeys(), ['key-one', 'key-two']);
  });
});

test('an exhausted key rotates to the next one and the working key sticks', async () => {
  await withKeys('dead', 'alive', async () => {
    const tried: string[] = [];
    const out = await runWithTinyfishKeys(async (key) => {
      tried.push(key);
      if (key === 'dead') throw exhausted(429);
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.deepEqual(tried, ['dead', 'alive']);
    // the key that worked is now preferred, so the dead one is not retried first
    assert.deepEqual(tinyfishKeyOrder(), ['alive', 'dead']);
  });
});

test('a non-quota error does not silently switch accounts', async () => {
  await withKeys('key-one', 'key-two', async () => {
    const tried: string[] = [];
    await assert.rejects(() => runWithTinyfishKeys(async (key) => {
      tried.push(key);
      throw exhausted(500);
    }), /HTTP 500/);
    assert.deepEqual(tried, ['key-one']);
  });
});

test('every key exhausted surfaces the last error, not a silent empty result', async () => {
  await withKeys('a', 'b', async () => {
    await assert.rejects(() => runWithTinyfishKeys(async () => { throw exhausted(401); }), /HTTP 401/);
  });
});

test('no keys configured is an explicit error', async () => {
  await withKeys(undefined, undefined, async () => {
    await assert.rejects(() => runWithTinyfishKeys(async () => 'never'), /not configured/);
  });
});

test('isKeyExhaustedStatus covers quota and auth codes only', () => {
  for (const s of [401, 402, 403, 429]) assert.equal(isKeyExhaustedStatus(s), true);
  for (const s of [200, 400, 404, 500, 502, 0]) assert.equal(isKeyExhaustedStatus(s), false);
});

test('noteTinyfishKeySuccess ignores unknown keys', async () => {
  await withKeys('a', 'b', async () => {
    noteTinyfishKeySuccess('not-a-key');
    assert.deepEqual(tinyfishKeyOrder(), ['a', 'b']);
  });
});
