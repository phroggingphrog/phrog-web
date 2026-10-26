import { SearchParams } from '../../types.js';

// The Browse API `conditions` filter only accepts NEW, USED and UNSPECIFIED;
// finer grades are reachable only through the numeric `conditionIds` filter.
const CONDITION_MAP: Record<string, string> = {
  new: 'NEW',
  like_new: 'LIKE_NEW',
  excellent: 'USED',
  good: 'GOOD',
  fair: 'FAIR',
  used: 'USED',
};

/** The Browse `filter` parameter for a search, or undefined when it has none. */
export function searchFilter(
  { minPrice, maxPrice, condition }: Pick<SearchParams, 'minPrice' | 'maxPrice' | 'condition'>,
  currency: string
): string | undefined {
  const filters: string[] = [];
  if (minPrice != null || maxPrice != null) {
    // Browse silently drops a price filter that arrives without a currency,
    // returning unfiltered results rather than an error.
    filters.push(`price:[${minPrice ?? ''}..${maxPrice ?? ''}]`, `priceCurrency:${currency}`);
  }
  if (condition && condition !== 'any') {
    const ebayCondition = CONDITION_MAP[condition];
    if (ebayCondition) filters.push(`conditions:{${ebayCondition}}`);
  }
  return filters.length > 0 ? filters.join(',') : undefined;
}
