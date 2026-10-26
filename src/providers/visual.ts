// Visual search: identify an item from a photo, then look it up in shops, deals and secondhand listings.
// The image goes to the vision model (VISION_MODEL, default claude/haiku via OmniRoute; not a free route) and, only when it
// is a public URL, to Bing Visual Search. Google Lens is not used: it answers this server with a CAPTCHA.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { omnirouteKey } from './browse.js';
import { searchAliexpress, searchSecondhand } from './marketplace.js';
import { searchDeals } from './ozbargain.js';
import { chromePath } from './places.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUPPETEER = resolve(REPO_ROOT, 'engines/secondhand-mcp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js');
const MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface Identified {
  item?: string;
  brand?: string;
  model?: string;
  colour?: string;
  condition?: string;
  description?: string;
  search_query?: string;
}

async function loadImage(image: string): Promise<{ dataUrl: string; publicUrl?: string }> {
  if (image.startsWith('data:image/')) return { dataUrl: image };
  if (/^https?:\/\//.test(image)) {
    const res = await fetch(image, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('image larger than 8 MB');
    return { dataUrl: `data:${type.split(';')[0]};base64,${buf.toString('base64')}`, publicUrl: image };
  }
  const path = resolve(image);
  if (!existsSync(path)) throw new Error(`image file not found: ${image}`);
  if (statSync(path).size > MAX_BYTES) throw new Error('image larger than 8 MB');
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error('unsupported image type (jpg, png, webp, gif)');
  return { dataUrl: `data:${mime};base64,${readFileSync(path).toString('base64')}` };
}

async function identify(dataUrl: string, hint?: string): Promise<Identified> {
  const base = process.env.WEB_AGENT_LLM_BASE_URL || 'http://127.0.0.1:20128/v1';
  const model = process.env.VISION_MODEL || 'claude/haiku';
  const prompt = 'Identify the main item in this photo for shopping. Reply with ONLY JSON: ' +
    '{"item":"what it is","brand":"brand or null","model":"model/name or null","colour":"...","condition":"new/used/unknown",' +
    '"description":"one sentence","search_query":"best short shop search query"}' + (hint ? `\nUser note: ${hint}` : '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${omnirouteKey()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }] }),
  });
  if (!res.ok) throw new Error(`vision model HTTP ${res.status}`);
  const text: string = ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('vision model gave no JSON');
  return JSON.parse(m[0]);
}

/** Bing Visual Search on a public image URL: Bing redirects to a text search for what it recognised. */
async function bingIdentify(url: string): Promise<string | undefined> {
  if (!existsSync(PUPPETEER)) return undefined;
  const { default: puppeteer } = await import(pathToFileURL(PUPPETEER).href);
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox', '--lang=en-AU'], headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36');
    await page.goto(`https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForFunction(() => location.pathname === '/search', { timeout: 15000 }).catch(() => {});
    const q = new URL(page.url()).searchParams.get('q');
    return q && !q.startsWith('imgurl:') ? q : undefined;
  } finally {
    await browser.close();
  }
}

export interface VisualResult {
  identified: Identified;
  bing_label?: string;
  query: string;
  shops?: any;
  deals?: any;
  secondhand?: any;
  errors: { source: string; error: string }[];
}

export async function visualSearch(image: string, opts: { hint?: string; shop?: boolean; limit?: number; near?: string } = {}): Promise<VisualResult> {
  loadConfig();
  const errors: VisualResult['errors'] = [];
  const err = (source: string) => (e: any) => { errors.push({ source, error: e instanceof Error ? e.message : String(e) }); return undefined; };
  const { dataUrl, publicUrl } = await loadImage(image);
  const [identified, bing] = await Promise.all([
    identify(dataUrl, opts.hint).catch(err('vision')),
    publicUrl ? bingIdentify(publicUrl).catch(err('bing')) : Promise.resolve(undefined),
  ]);
  const query = (identified?.search_query || bing || identified?.item || '').trim();
  if (!query) throw new Error(`could not identify the image (${errors.map((e) => `${e.source}: ${e.error}`).join('; ')})`);
  const out: VisualResult = { identified: identified ?? {}, bing_label: bing, query, errors };
  if (opts.shop !== false) {
    const limit = opts.limit ?? 5;
    const [shops, deals, secondhand] = await Promise.all([
      searchAliexpress(query, limit).catch(err('aliexpress')),
      searchDeals(query, { limit, near: opts.near }).catch(err('deals')),
      searchSecondhand(query, { limit: 3 }).catch(err('secondhand')),
    ]);
    Object.assign(out, { shops, deals, secondhand });
  }
  return out;
}
