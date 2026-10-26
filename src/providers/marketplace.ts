// Marketplace: secondhand listings via engines/secondhand-mcp (Facebook Marketplace, Depop, Poshmark, eBay with keys)
// and AliExpress products via engines/aliexpress-scraper (search through SearXNG, details through the scraper).
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../config.js';
import { executeSearch } from './search.js';
import { resolveLocation } from '../location.js';

export type SecondhandMarket = 'facebook' | 'depop' | 'poshmark' | 'ebay';
export const SECONDHAND_MARKETS: SecondhandMarket[] = ['facebook', 'depop', 'poshmark', 'ebay'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECONDHAND_DIR = resolve(REPO_ROOT, 'engines/secondhand-mcp');
const ALIEXPRESS_DIR = resolve(REPO_ROOT, 'engines/aliexpress-scraper');
const CALL_TIMEOUT_MS = 60000;

/** Chrome for puppeteer: CHROME_PATH, else the newest Playwright Chromium in the user cache. */
function chromePath(): string | undefined {
  loadConfig();
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = resolve(homedir(), '.cache/ms-playwright');
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const p = resolve(base, d, 'chrome-linux64/chrome');
    if (existsSync(p)) return p;
  }
  return undefined;
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!existsSync(resolve(SECONDHAND_DIR, 'dist/index.js'))) {
      throw new Error('engines/secondhand-mcp is not built (run `npm install && npm run build` inside it)');
    }
    loadConfig();
    const env: Record<string, string> = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' };
    for (const k of ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_MARKETPLACE_ID']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    const chrome = chromePath();
    if (chrome) env.PUPPETEER_EXECUTABLE_PATH = chrome;
    const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], cwd: SECONDHAND_DIR, env, stderr: 'ignore' });
    const c = new Client({ name: 'phrog-web', version: '0.1.0' });
    transport.onclose = () => { client = null; };
    await c.connect(transport);
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const c = await getClient();
  const res: any = await c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const out = (res.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
  if (res.isError) throw new Error(out || 'secondhand MCP error');
  return out;
}

export interface SecondhandOptions {
  marketplaces?: SecondhandMarket[];
  location?: string;
  radiusKm?: number;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  condition?: string;
  sort?: string;
  includeImages?: boolean;
}

export interface SecondhandResult {
  query: string;
  results: { marketplace: string; ok: boolean; text: string }[];
}

/** Search secondhand marketplaces in parallel; each marketplace reports its own text block or error. */
export async function searchSecondhand(query: string, opts: SecondhandOptions = {}): Promise<SecondhandResult> {
  loadConfig();
  const markets = opts.marketplaces?.length
    ? opts.marketplaces
    : SECONDHAND_MARKETS.filter((m) => m !== 'ebay' || (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET));
  const place = opts.location || process.env.MARKETPLACE_LOCATION || (await resolveLocation())?.name;
  const args = {
    query,
    ...(place && { location: place }),
    ...(opts.radiusKm !== undefined && { radiusMiles: Math.round(opts.radiusKm / 1.609) }),
    limit: opts.limit ?? 10,
    includeImages: opts.includeImages ?? true,
    ...(opts.minPrice !== undefined && { minPrice: opts.minPrice }),
    ...(opts.maxPrice !== undefined && { maxPrice: opts.maxPrice }),
    ...(opts.condition && { condition: opts.condition }),
    ...(opts.sort && { sort: opts.sort }),
  };
  const results = await Promise.all(markets.map(async (marketplace) => {
    try {
      const text = await call('search_marketplace', { ...args, marketplace });
      return { marketplace, ok: !text.startsWith('❌'), text };
    } catch (err) {
      return { marketplace, ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }));
  return { query, results };
}

export async function secondhandListing(listingId: string, marketplace: SecondhandMarket): Promise<{ marketplace: string; text: string }> {
  return { marketplace, text: await call('get_listing_details', { listingId, marketplace, includeImages: true }) };
}

export interface AliexpressHit {
  title: string;
  url: string;
  productId: string;
  snippet?: string;
}

/** AliExpress product search through SearXNG, keeping only product pages (/item/<id>.html). */
export async function searchAliexpress(query: string, limit = 10): Promise<{ query: string; results: AliexpressHit[] }> {
  const res = await executeSearch(`site:aliexpress.com/item ${query}`, { limit: 30 });
  const seen = new Set<string>();
  const results: AliexpressHit[] = [];
  for (const r of res.results as any[]) {
    const m = String(r.url).match(/aliexpress\.[a-z.]+\/item\/(\d+)\.html/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    results.push({ title: r.title, url: `https://www.aliexpress.com/item/${m[1]}.html`, productId: m[1], snippet: r.content || r.snippet });
    if (results.length >= limit) break;
  }
  return { query, results };
}

/** Full AliExpress product: price, variants, shipping, store, ratings, reviews. */
export async function aliexpressProduct(idOrUrl: string, reviewsCount = 5): Promise<any> {
  const id = idOrUrl.match(/(\d{10,})/)?.[1];
  if (!id) throw new Error('Give an AliExpress product id or /item/<id>.html URL');
  if (!existsSync(resolve(ALIEXPRESS_DIR, 'node_modules'))) {
    throw new Error('engines/aliexpress-scraper is not installed (run `pnpm install` inside it)');
  }
  const { default: scrape } = await import(pathToFileURL(resolve(ALIEXPRESS_DIR, 'index.js')).href);
  const data = await scrape(id, {
    reviewsCount,
    timeout: CALL_TIMEOUT_MS,
    puppeteerOptions: { executablePath: chromePath(), args: ['--no-sandbox'] },
  });
  const { description, reviews, ...rest } = data || {};
  return { url: `https://www.aliexpress.com/item/${id}.html`, ...rest, reviews: Array.isArray(reviews) ? reviews.slice(0, reviewsCount) : reviews, description: typeof description === 'string' ? description.slice(0, 3000) : description };
}
