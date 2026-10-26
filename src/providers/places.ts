// Places: Google rating, review count, category, address and opening status.
// With GOOGLE_PLACES_API_KEY it uses the Places API (adds up to 5 review texts per place); without it, it reads the
// Google Maps results list in headless Chrome (signed-out "limited view": ratings and counts, no review text).
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';

export interface PlaceReview {
  by?: string;
  stars?: number;
  when?: string;
  text: string;
}

export interface Place {
  name: string;
  rating?: number;
  reviews_count?: number;
  category?: string;
  address?: string;
  status?: string;
  summary?: string;
  url?: string;
  reviews?: PlaceReview[];
}

export interface PlacesResult {
  query: string;
  source: 'google-places-api' | 'google-maps';
  results: Place[];
  note?: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUPPETEER = resolve(REPO_ROOT, 'engines/secondhand-mcp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = resolve(homedir(), '.cache/ms-playwright');
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return dirs.map((d) => resolve(base, d, 'chrome-linux64/chrome')).find((p) => existsSync(p));
}

async function viaApi(query: string, limit: number, key: string): Promise<Place[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri,places.currentOpeningHours.openNow,places.editorialSummary,places.reviews',
    },
    body: JSON.stringify({ textQuery: query, pageSize: limit }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Places API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.places || []).map((p: any) => ({
    name: p.displayName?.text,
    rating: p.rating,
    reviews_count: p.userRatingCount,
    category: p.primaryTypeDisplayName?.text,
    address: p.formattedAddress,
    status: p.currentOpeningHours ? (p.currentOpeningHours.openNow ? 'Open now' : 'Closed now') : undefined,
    summary: p.editorialSummary?.text,
    url: p.googleMapsUri,
    reviews: (p.reviews || []).map((r: any) => ({ by: r.authorAttribution?.displayName, stars: r.rating, when: r.relativePublishTimeDescription, text: r.text?.text || r.originalText?.text || '' })),
  }));
}

async function viaMaps(query: string, limit: number): Promise<Place[]> {
  if (!existsSync(PUPPETEER)) throw new Error('puppeteer-core not installed (run `npm install` in engines/secondhand-mcp)');
  const { default: puppeteer } = await import(pathToFileURL(PUPPETEER).href);
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--lang=en-AU'], headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // A single exact match opens the place panel directly instead of a results list.
    await page.waitForFunction(
      () => document.querySelector('div[role="article"] a[aria-label]') || document.querySelector('div.F7nice'),
      { timeout: 15000 },
    );
    await new Promise((r) => setTimeout(r, 2500));
    const rows: any[] = await page.evaluate((max: number) => {
      const list = location.pathname.startsWith('/maps/place/') ? [] : [...document.querySelectorAll('div[role="article"]')].slice(0, max).map((a) => {
        const lines = [...a.querySelectorAll('.W4Efsd')].map((x) => (x as HTMLElement).innerText).filter(Boolean);
        return {
          name: a.querySelector('a[aria-label]')?.getAttribute('aria-label') || '',
          url: (a.querySelector('a[href*="/maps/place/"]') as HTMLAnchorElement | null)?.href,
          stars: a.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute('aria-label') || (a.querySelector('.MW4etd') ? `${a.querySelector('.MW4etd')?.textContent} ${a.querySelector('.UY7F9')?.textContent}` : ''),
          info: lines[1] || '',
        };
      });
      if (list.some((r) => r.name)) return list;
      const h1 = document.querySelector('h1') as HTMLElement | null;
      if (!h1) return [];
      return [{
        name: h1.innerText,
        url: location.href,
        stars: (document.querySelector('div.F7nice') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') || '',
        info: [document.querySelector('button.DkEaL')?.textContent, document.querySelector('button[data-item-id="address"]')?.getAttribute('aria-label')?.replace(/^Address:\s*/, '')].filter(Boolean).join(' · '),
      }];
    }, limit);
    return rows.filter((r) => r.name).map((r) => {
      const m = r.stars.match(/([\d.]+)\s*(?:stars)?\s*\(?([\d,]+)/);
      const [first, ...rest] = String(r.info).split('\n');
      const parts = first.split('·').map((s: string) => s.trim()).filter((s: string) => /[a-z0-9]/i.test(s));
      return {
        name: r.name,
        rating: m ? Number(m[1]) : undefined,
        reviews_count: m ? Number(m[2].replace(/,/g, '')) : undefined,
        category: parts[0],
        address: parts.slice(1).join(', ') || undefined,
        summary: rest.find((l: string) => !/^(Open|Closed|Opens|Closes)/.test(l)),
        status: rest.find((l: string) => /^(Open|Closed|Opens|Closes)/.test(l)),
        url: r.url?.split('?')[0],
      };
    });
  } finally {
    await browser.close();
  }
}

export async function searchPlaces(query: string, opts: { limit?: number } = {}): Promise<PlacesResult> {
  loadConfig();
  const limit = Math.min(opts.limit ?? 8, 20);
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (key) return { query, source: 'google-places-api', results: await viaApi(query, limit, key) };
  return {
    query,
    source: 'google-maps',
    results: await viaMaps(query, limit),
    note: 'Ratings and counts only; set GOOGLE_PLACES_API_KEY to include review text.',
  };
}
