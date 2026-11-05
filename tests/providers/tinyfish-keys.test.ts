import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tinyfishCredentials, tinyfishKeyOrder, isKeyExhaustedStatus,
  noteTinyfishKeySuccess, resetTinyfishKeyPreference, runWithTinyfishKeys,
} from '../../src/providers/tinyfish-keys.js';

function withKeys(paid: string | undefined, free: string | undefined, fn: () => Promise<void>) {
  const saved = [process.env.TINYFISH_API_KEY, process.env.TINYFISH_API_KEY_2];
  if (paid === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = paid;
  if (free === undefined) delete process.env.TINYFISH_API_KEY_2; else process.env.TINYFISH_API_KEY_2 = free;
  resetTinyfishKeyPreference();
  return fn().finally(() => {
    if (saved[0] === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = saved[0];
    if (saved[1] === undefined) delete process.env.TINYFISH_API_KEY_2; else process.env.TINYFISH_API_KEY_2 = saved[1];
    resetTinyfishKeyPreference();
  });
}

const exhausted = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test('TINYFISH_API_KEY is the Builder plan and TINYFISH_API_KEY_2 is the free Hobby plan', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    assert.deepEqual(tinyfishCredentials(), [
      { key: 'hobby-key', plan: 'free' },
      { key: 'builder-key', plan: 'paid' },
    ]);
  });
});

test('search spends the free allowance before the paid one', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    assert.deepEqual(tinyfishKeyOrder('search'), ['hobby-key', 'builder-key']);
  });
});

test('agent and browser work prefers the paid plan', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    assert.deepEqual(tinyfishKeyOrder('agent'), ['builder-key', 'hobby-key']);
  });
});

test('blank keys are dropped and a single key works for either role', async () => {
  await withKeys('builder-key', '   ', async () => {
    assert.deepEqual(tinyfishKeyOrder('search'), ['builder-key']);
    assert.deepEqual(tinyfishKeyOrder('agent'), ['builder-key']);
  });
});

test('an exhausted free key rotates to the paid key and reports which plan answered', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    const tried: Array<[string, string]> = [];
    const out = await runWithTinyfishKeys(async (key, plan) => {
      tried.push([key, plan]);
      if (plan === 'free') throw exhausted(429);
      return plan;
    });
    assert.equal(out, 'paid');
    assert.deepEqual(tried, [['hobby-key', 'free'], ['builder-key', 'paid']]);
  });
});

test('agent role tries the paid key first', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    const tried: string[] = [];
    await runWithTinyfishKeys(async (key) => { tried.push(key); return 'ok'; }, 'agent');
    assert.deepEqual(tried, ['builder-key']);
  });
});

test('a non-quota error does not silently switch accounts', async () => {
  await withKeys('builder-key', 'hobby-key', async () => {
    const tried: string[] = [];
    await assert.rejects(() => runWithTinyfishKeys(async (key) => {
      tried.push(key);
      throw exhausted(500);
    }), /HTTP 500/);
    assert.deepEqual(tried, ['hobby-key']);
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
  await withKeys('builder-key', 'hobby-key', async () => {
    noteTinyfishKeySuccess('not-a-key');
    assert.deepEqual(tinyfishKeyOrder('search'), ['hobby-key', 'builder-key']);
  });
});
