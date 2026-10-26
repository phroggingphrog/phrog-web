/** The parts of eBay Browse API responses this adapter reads. */

export interface BrowsePrice {
  value?: string;
  currency?: string;
}

export interface BrowseImage {
  imageUrl?: string;
}

export interface BrowseLocation {
  city?: string;
  stateOrProvince?: string;
  country?: string;
}

export interface ItemSummary {
  itemId: string;
  title?: string;
  price?: BrowsePrice;
  condition?: string;
  image?: BrowseImage;
  itemLocation?: BrowseLocation;
  itemWebUrl?: string;
  seller?: { username?: string };
}

export interface SearchResponse {
  total?: number;
  itemSummaries?: ItemSummary[];
}

export interface Item {
  itemId: string;
  description?: string;
  shortDescription?: string;
  image?: BrowseImage;
  additionalImages?: BrowseImage[];
  itemLocation?: BrowseLocation;
  seller?: { username?: string };
  shippingOptions?: Array<{ shippingServiceCode: string }>;
  itemWebUrl?: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
}
