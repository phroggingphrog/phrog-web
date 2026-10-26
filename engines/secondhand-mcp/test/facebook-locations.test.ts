import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationResolver, lookupCandidates } from '../src/marketplaces/facebook/locations.js';

vi.mock('undici', () => ({ ProxyAgent: class {} }));

describe('lookupCandidates', () => {
  it.each([
    ['Montclair, NJ', ['montclair, new jersey', 'montclair']],
    ['Montclair, New Jersey', ['montclair, new jersey', 'montclair']],
    ['Old Toronto, Ontario', ['old toronto, ontario', 'old toronto']],
    ['Austin', ['austin']],
  ])('asks for %j as %j', (query, expected) => {
    expect(lookupCandidates(query)).toEqual(expected);
  });

  // A foreign region that shares a US state code is spelled out as the US
  // state; the city-page distance check then rejects the US match.
  it('reads a trailing state code as the US state', () => {
    expect(lookupCandidates('Perth, WA')).toEqual(['perth, washington', 'perth']);
  });
});

describe('LocationResolver.coordinates for places outside the offline table', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks Facebook with the state spelled out', async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const query = JSON.parse(new URLSearchParams(String(init?.body)).get('variables')!).params.query;
        queries.push(query);
        const edges =
          query === 'zqxville, new jersey'
            ? [{ node: { subtitle: 'City · New Jersey', single_line_address: 'Zqxville, NJ', location: { latitude: 40.8, longitude: -74.2 } } }]
            : [];
        return new Response(JSON.stringify({ data: { city_street_search: { street_results: { edges } } } }));
      })
    );

    const coords = await new LocationResolver().coordinates('Zqxville, NJ');

    expect(queries).toEqual(['zqxville, new jersey']);
    expect(coords).toEqual({ latitude: 40.8, longitude: -74.2, name: 'Zqxville, NJ' });
  });
});
