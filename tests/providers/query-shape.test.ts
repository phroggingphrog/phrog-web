import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeQuery } from '../../src/providers/query-shape.js';

test('long natural-language prompt is compacted', () => {
  const r = shapeQuery('melbourne events november 1 2026 november 10 film screening book club volunteer writing competition submissions');
  assert.ok(r.shaped);
  assert.ok(r.primary.split(' ').length <= 8, r.primary);
  assert.ok(!r.primary.includes(' the '));
});

test('short queries are left alone', () => {
  const r = shapeQuery('podman quadlet');
  assert.equal(r.shaped, false);
  assert.equal(r.primary, 'podman quadlet');
  assert.deepEqual(r.variants, []);
});

test('site: operator survives intact', () => {
  const r = shapeQuery('site:events.humanitix.com Melbourne events November 2026 film screenings and book clubs');
  assert.ok(r.primary.includes('site:events.humanitix.com'), r.primary);
});

test('quoted phrase survives and becomes its own variant', () => {
  const r = shapeQuery('"remote execution env" pi-env github repository design notes for agents');
  assert.ok(r.primary.includes('"remote execution env"'));
  assert.ok(r.variants.some((v) => v.includes('"remote execution env"')));
});

test('technical tokens are never dropped', () => {
  const r = shapeQuery('how does qwen3.6 35b-a3b run on 16gb with iq2_m quantization for the model');
  for (const t of ['qwen3.6', '35b-a3b', '16gb', 'iq2_m']) assert.ok(r.primary.includes(t), t + ' missing from ' + r.primary);
});

test('CJK is returned untouched', () => {
  const q = '如何在本地运行 podman quadlet 服务';
  const r = shapeQuery(q);
  assert.equal(r.primary, q);
  assert.equal(r.shaped, false);
});

test('duplicate words collapse', () => {
  const r = shapeQuery('hermes hermes agent agent memory memory architecture documentation');
  assert.equal(r.primary.split(' ').filter((w) => w === 'hermes').length, 1);
});

test('variants never duplicate the primary or the raw query', () => {
  const r = shapeQuery('what is the best way to configure fd limits for postgres on linux servers please');
  for (const v of r.variants) { assert.notEqual(v, r.primary); }
  assert.equal(new Set(r.variants).size, r.variants.length);
});
