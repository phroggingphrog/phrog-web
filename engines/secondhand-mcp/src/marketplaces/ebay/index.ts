/**
 * eBay Marketplace implementation
 *
 * Uses eBay's official Browse API for searching and retrieving listings.
 * Requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.
 * Docs: https://developer.ebay.com/api-docs/buy/browse/overview.html
 */

import { BaseMarketplace } from '../base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../../types.js';
import { EbayToken } from './auth.js';
import { marketplaceCurrency } from './currency.js';
import { searchFilter } from './filters.js';
import { itemDetails, summaryListing } from './parse.js';
import { Item, ItemSummary, SearchResponse } from './wire.js';

export { currencySymbol } from './currency.js';
export { resizeEbayImageUrl } from './images.js';

const BROWSE_API_URL = 'https://api.ebay.com/buy/browse/v1';

// eBay Browse API pagination limits: max 200 items per request, and
// offset + limit may not exceed 10,000.
const EBAY_PAGE_SIZE = 200;
const EBAY_MAX_OFFSET = 10_000;

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  /** eBay marketplace ID, e.g. 'EBAY_US', 'EBAY_DE', 'EBAY_GB'. Defaults to 'EBAY_US'. */
  marketplaceId?: string;
}

export class EbayMarketplace extends BaseMarketplace {
  readonly name = 'ebay';
  readonly displayName = 'eBay';
  readonly requiresAuth = true;

  readonly marketplaceId: string;
  private readonly token: EbayToken | undefined;

  constructor(credentials?: EbayCredentials) {
    super();
    const clientId = credentials?.clientId ?? process.env.EBAY_CLIENT_ID;
    const clientSecret = credentials?.clientSecret ?? process.env.EBAY_CLIENT_SECRET;
    this.token = clientId && clientSecret ? new EbayToken(clientId, clientSecret) : undefined;
    this.marketplaceId = credentials?.marketplaceId ?? process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, limit = 20, offset = 0 } = params;

    if (!this.token) {
      return this.createError(
        'eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.'
      );
    }

    try {
      const token = await this.token.get();
      const filter = searchFilter(params, marketplaceCurrency(this.marketplaceId));

      // eBay's Browse API returns at most 200 items per request and caps
      // offset + limit at 10,000, so fetch successive pages until we've
      // collected `limit` listings (or run out of results).
      const target = Math.max(0, limit);
      const listings: Listing[] = [];
      let total = 0;
      let currentOffset = Math.max(0, offset);

      while (listings.length < target && currentOffset < EBAY_MAX_OFFSET) {
        const pageLimit = Math.min(target - listings.length, EBAY_PAGE_SIZE, EBAY_MAX_OFFSET - currentOffset);
        if (pageLimit <= 0) break;

        const response = await this.browse(`/item_summary/search?${pageQuery(query, pageLimit, currentOffset, filter)}`, token);

        if (!response.ok) {
          // If earlier pages succeeded, return what we have rather than failing.
          if (listings.length > 0) break;
          return this.createError(await searchFailure(response));
        }

        const data = (await response.json()) as SearchResponse;
        total = data.total ?? total;
        const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
        if (items.length === 0) break;

        collectListings(items, target, listings);
        currentOffset += items.length;

        if (total && currentOffset >= total) break;
      }

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: total || listings.length,
        ...(listings.length === 0 && {
          note: 'No eBay listings found for this query. eBay searches nationally (not location-based). Try broadening your search terms.',
        }),
      };
    } catch (error) {
      return this.createError(`eBay search failed: ${error}`);
    }
  }

  async getListingDetails(itemId: string): Promise<ListingDetails> {
    if (!this.token) {
      throw new Error('eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.');
    }
    const token = await this.token.get();

    // Listing URLs show a bare number; the Browse API wants "v1|123456|0".
    const apiItemId = /^\d+$/.test(itemId) ? `v1|${itemId}|0` : itemId;
    const response = await this.browse(`/item/${encodeURIComponent(apiItemId)}`, token);

    if (!response.ok) {
      throw new Error(`eBay API returned ${response.status}`);
    }

    return itemDetails((await response.json()) as Item, itemId);
  }

  async healthCheck(): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.token.get();
      return true;
    } catch {
      return false;
    }
  }

  private browse(path: string, token: string): Promise<Response> {
    return fetch(`${BROWSE_API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
      },
    });
  }
}

function pageQuery(query: string, limit: number, offset: number, filter: string | undefined): string {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  if (filter) params.set('filter', filter);
  return params.toString();
}

async function searchFailure(response: Response): Promise<string> {
  const body = await response.text();
  const hint =
    response.status === 401 || response.status === 403 ? '. Check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.' : '';
  return `eBay API returned ${response.status}: ${body}${hint}`;
}

function collectListings(items: ItemSummary[], target: number, listings: Listing[]): void {
  for (const item of items) {
    if (listings.length >= target) break;
    try {
      listings.push(summaryListing(item));
    } catch {
      continue;
    }
  }
}
