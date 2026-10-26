import { Listing } from '../../types.js';
import { FeedUnitsReading } from './parse.js';

const MIN_TRUSTED_LISTINGS = 5;

export type GraphAnswer =
  | { kind: 'read'; reading: FeedUnitsReading }
  | { kind: 'failed'; error: unknown };

export type SearchAnswer =
  | { kind: 'listings'; listings: Listing[] }
  | { kind: 'unreadable' }
  | { kind: 'failed'; error: unknown };

function isGatedVersion(graph: FeedUnitsReading, limit: number): boolean {
  const thin = graph.listings.length < Math.min(limit, MIN_TRUSTED_LISTINGS);
  return thin && (graph.malformed || graph.hasNextPage);
}

export function needsSearchPage(graph: GraphAnswer, limit: number): boolean {
  return graph.kind === 'failed' || isGatedVersion(graph.reading, limit);
}

/** `page` is null when the search page was not read at all. */
export function chooseAnswer(graph: GraphAnswer, page: Listing[] | null): SearchAnswer {
  if (graph.kind === 'failed') return page ? { kind: 'listings', listings: page } : graph;
  const { listings, malformed } = graph.reading;
  if (page && page.length > listings.length) return { kind: 'listings', listings: page };
  if (!page && malformed && listings.length === 0) return { kind: 'unreadable' };
  return { kind: 'listings', listings };
}
