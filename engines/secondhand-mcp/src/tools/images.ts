export const IMAGE_SIZE_PX = { thumb: 400, standard: 800, full: 1600 } as const;
export type ImageSize = keyof typeof IMAGE_SIZE_PX;

const FETCH_BATCH_SIZE = 5;
const FETCH_TIMEOUT_MS = 10_000;

// A real browser UA + Referer — eBay's CDN serves placeholder responses to
// bare server-side fetches, which is why inline base64 came back blank.
const IMAGE_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface FetchedImage {
  url: string;
  ok: boolean;
  data?: string;
  mimeType?: string;
}

/** Magic-byte sniff so we never base64 an HTML error page or 1x1 placeholder as an image. */
export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true; // WEBP (RIFF....WEBP)
  return false;
}

/** Fetches in batches, in listing order; a failed photo keeps its slot and url as `ok: false`. */
export async function fetchImages(urls: string[]): Promise<FetchedImage[]> {
  const fetched: FetchedImage[] = [];
  for (let i = 0; i < urls.length; i += FETCH_BATCH_SIZE) {
    const batch = urls.slice(i, i + FETCH_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(fetchImage));
    settled.forEach((s, j) => fetched.push(s.status === 'fulfilled' ? s.value : { url: batch[j], ok: false }));
  }
  return fetched;
}

async function fetchImage(url: string): Promise<FetchedImage> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': IMAGE_FETCH_UA,
      Referer: 'https://www.ebay.com/',
      Accept: 'image/avif,image/webp,image/png,image/*,*/*',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { url, ok: false };
  const mimeType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!mimeType.startsWith('image/') || !looksLikeImage(buffer)) return { url, ok: false };
  return { url, ok: true, data: buffer.toString('base64'), mimeType };
}
