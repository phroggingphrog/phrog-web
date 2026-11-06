import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepResearchStart } from '../../src/providers/compat.js';

// These never reach Feynman: the validation runs first, which is the point — the option is refused
// instead of being accepted and quietly ignored.
test('spend and style options are refused, not silently dropped', () => {
  for (const opt of [{ budget_usd: 5 }, { register: 'teach' }, { inference_depth: 'deep' }, { domain_notes: 'x' }]) {
    assert.throws(() => deepResearchStart({ topic: 't', ...opt } as any), /does not support/);
  }
});

test('the message names every unsupported option at once', () => {
  assert.throws(
    () => deepResearchStart({ topic: 't', budget_usd: 5, register: 'teach' } as any),
    /budget_usd, register/,
  );
});

test('a workflow outside the engine list is refused before dispatch', () => {
  assert.throws(() => deepResearchStart({ topic: 't', workflow: 'help' } as any), /workflow must be one of/);
});
