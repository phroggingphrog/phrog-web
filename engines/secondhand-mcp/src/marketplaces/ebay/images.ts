/** 1600px is the largest size eBay reliably hosts for every image. */
const FULL_RES_PX = 1600;

/**
 * eBay's Browse API returns image URLs at a small default size (e.g. s-l225 /
 * s-l500). The same CDN object is available at other sizes by rewriting the
 * `s-l<N>` size token (max dimension in px) and dropping any `/thumbs/` path
 * segment. Non-eBay URLs, or shapes we don't recognize, pass through unchanged.
 */
export function resizeEbayImageUrl(url: string, maxPx: number): string {
  if (!url || !url.includes('ebayimg.com')) return url;
  return url
    .replace('/thumbs/images/', '/images/')
    .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, `/s-l${maxPx}.$1`);
}

export function toFullResImageUrl(url: string): string {
  return resizeEbayImageUrl(url, FULL_RES_PX);
}
