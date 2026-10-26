import { describe, expect, it } from 'vitest';
import { GraphAnswer, chooseAnswer, needsSearchPage } from '../src/marketplaces/facebook/route.js';
import type { Listing } from '../src/types.js';

const listings = (n: number): Listing[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    title: 'Trek',
    price: '$1',
    url: `https://fb/${i}`,
    marketplace: 'facebook',
    scrapedAt: '2026-01-01T00:00:00.000Z',
  }));

const read = (count: number, { malformed = false, hasNextPage = false } = {}): GraphAnswer => ({
  kind: 'read',
  reading: { listings: listings(count), malformed, hasNextPage },
});
const refused: GraphAnswer = { kind: 'failed', error: new Error('refused') };

describe('needsSearchPage', () => {
  it.each([
    ['a refusal', refused, true],
    ['a thin answer with more pages behind it', read(1, { hasNextPage: true }), true],
    ['a thin answer carrying stubs', read(0, { malformed: true }), true],
    ['a small complete answer', read(2), false],
    ['a full page', read(8, { hasNextPage: true }), false],
  ])('%s → %s', (_label, graph, expected) => {
    expect(needsSearchPage(graph, 24)).toBe(expected);
  });

  it('trusts a thin answer when the caller asked for fewer than it holds', () => {
    expect(needsSearchPage(read(2, { hasNextPage: true }), 2)).toBe(false);
  });
});

describe('chooseAnswer', () => {
  it.each([
    ['refused, page listings', refused, listings(3), { kind: 'listings', count: 3 }],
    ['refused, page answered empty', refused, [], { kind: 'listings', count: 0 }],
    ['refused, no page', refused, null, { kind: 'failed' }],
    ['thin graph, fuller page', read(1, { hasNextPage: true }), listings(4), { kind: 'listings', count: 4 }],
    ['graph ties the page', read(2, { hasNextPage: true }), listings(2), { kind: 'listings', count: 2 }],
    ['stub graph, no page', read(0, { malformed: true }), null, { kind: 'unreadable' }],
    ['thin graph, no page', read(1, { hasNextPage: true }), null, { kind: 'listings', count: 1 }],
  ])('%s', (_label, graph, page, expected) => {
    const answer = chooseAnswer(graph, page);
    expect(answer.kind).toBe(expected.kind);
    if (answer.kind === 'listings') expect(answer.listings).toHaveLength(expected.count!);
  });

  it('serves the page, not the graph, when the page is fuller', () => {
    const page = listings(4);
    const answer = chooseAnswer(read(1, { hasNextPage: true }), page);
    expect(answer).toEqual({ kind: 'listings', listings: page });
  });

  it('keeps the graph answer when the page only ties it', () => {
    const graphListings = listings(2);
    const graph: GraphAnswer = {
      kind: 'read',
      reading: { listings: graphListings, malformed: false, hasNextPage: true },
    };

    const answer = chooseAnswer(graph, listings(2));

    expect(answer.kind === 'listings' && answer.listings).toBe(graphListings);
  });
});
