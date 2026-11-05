import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCitations } from '../../src/providers/research.js';

test('citations are numbered from 1 in rank order', () => {
  const c = buildCitations([{ title: 'A', url: 'https://a.test' }, { title: 'B', url: 'https://b.test' }]);
  assert.deepEqual(c, [
    { n: 1, title: 'A', url: 'https://a.test' },
    { n: 2, title: 'B', url: 'https://b.test' },
  ]);
});

test('a url cited twice is only numbered once', () => {
  const c = buildCitations([
    { title: 'A', url: 'https://a.test' },
    { title: 'A again', url: 'https://a.test' },
    { title: 'B', url: 'https://b.test' },
  ]);
  assert.equal(c.length, 2);
  assert.equal(c[1].n, 2);
  assert.equal(c[1].url, 'https://b.test');
});

test('hits without a url are dropped, and title falls back to the url', () => {
  const c = buildCitations([{ title: 'no url' }, { url: 'https://b.test' }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].title, 'https://b.test');
});

test('the citation count is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://x.test/${i}` }));
  assert.equal(buildCitations(many).length, 8);
  assert.equal(buildCitations(many, 3).length, 3);
  assert.equal(buildCitations(many, 3)[2].n, 3);
});
