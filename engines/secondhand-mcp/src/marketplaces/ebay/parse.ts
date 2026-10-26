import { parsePrice } from '../base.js';
import { Listing, ListingDetails } from '../../types.js';
import { currencySymbol } from './currency.js';
import { descriptionText } from './description.js';
import { toFullResImageUrl } from './images.js';
import { BrowseLocation, Item, ItemSummary } from './wire.js';

export function summaryListing(item: ItemSummary): Listing {
  // Browse gives amount and currency as separate fields, so only the
  // amount needs parsing; the currency is already known.
  const currency = item.price?.currency ? currencySymbol(item.price.currency) : undefined;
  const price = item.price ? `${currency}${item.price.value}` : 'Price not listed';
  const parsed = item.price ? parsePrice(String(item.price.value)) : null;

  // Only the primary image for search results; the full set comes with details.
  const image = item.image?.imageUrl ? toFullResImageUrl(item.image.imageUrl) : undefined;

  return {
    id: item.itemId,
    title: item.title || 'Untitled Listing',
    price,
    priceNumeric: parsed?.numeric,
    currency: currency ?? '$',
    condition: item.condition,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince']),
    url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
    images: image ? [image] : undefined,
    seller: item.seller?.username,
    marketplace: 'ebay',
    scrapedAt: new Date().toISOString(),
  };
}

export function itemDetails(item: Item, requestedId: string): ListingDetails {
  const additional = Array.isArray(item.additionalImages) ? item.additionalImages : [];
  const images = [item.image, ...additional].flatMap((image) =>
    image?.imageUrl ? [toFullResImageUrl(image.imageUrl)] : []
  );

  return {
    id: item.itemId,
    description: itemDescription(item),
    images,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince', 'country']),
    seller: item.seller?.username ?? undefined,
    deliveryTypes: item.shippingOptions?.map((s) => s.shippingServiceCode) ?? undefined,
    isShippingOffered: Array.isArray(item.shippingOptions) && item.shippingOptions.length > 0,
    url: item.itemWebUrl ?? `https://www.ebay.com/itm/${requestedId}`,
  };
}

function itemDescription(item: Item): string | undefined {
  const text = item.description ? descriptionText(item.description) : '';
  return text || item.shortDescription || undefined;
}

function placeText(location: BrowseLocation | undefined, parts: Array<keyof BrowseLocation>): string | undefined {
  return parts.map((part) => location?.[part]).filter(Boolean).join(', ') || undefined;
}
