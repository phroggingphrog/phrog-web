// Book metadata search only (Anna's Archive). Never downloads book files.
import { loadConfig } from '../config.js';

export interface BookHit {
  title: string;
  authors?: string;
  year?: string;
  language?: string;
  format?: string;
  size?: string;
  url: string;
  source: string;
}

export interface BooksResult {
  query: string;
  results: BookHit[];
  sources_used: string[];
  sources_failed: { source: string; error: string }[];
}

const ANNAS_MIRRORS = ['annas-archive.gl', 'annas-archive.pk', 'annas-archive.gd', 'annas-archive.li'];

async function crawlHtml(url: string): Promise<{ html: string; status: number }> {
  loadConfig();
  const token = process.env.CRAWL4AI_API_TOKEN || '';
  let last: Error = new Error('Crawl4AI unreachable');
  for (const base of ['http://127.0.0.1:11235', 'http://127.0.0.1:11236']) {
    try {
      const res = await fetch(new URL('/crawl', base), {
        method: 'POST',
        signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          urls: [url],
          browser_config: { type: 'BrowserConfig', params: { headless: true } },
          crawler_config: { type: 'CrawlerRunConfig', params: { wait_until: 'networkidle', delay_before_return_html: 6, page_timeout: 60000 } },
        }),
      });
      if (!res.ok) throw new Error(`Crawl4AI HTTP ${res.status} from ${base}`);
      const data = (await res.json()) as any;
      const r = data.results?.[0];
      return { html: r?.html || '', status: r?.status_code || 0 };
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last;
}

const strip = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Best-effort parser: Anna's result blocks hold an /md5/<hash> link, a title,
// an author line and a "English [en], epub, 1.2MB, ..." metadata line.
// NOTE: not verified against live HTML (all mirrors blocked by DDoS-Guard from this VPS).
export function parseAnnas(html: string, host: string): BookHit[] {
  const hits: BookHit[] = [];
  const seen = new Set<string>();
  const parts = html.split(/(?=<a[^>]+href="\/md5\/[0-9a-f]{32})/i).slice(1);
  for (const part of parts) {
    const md5 = part.match(/\/md5\/([0-9a-f]{32})/i)?.[1];
    if (!md5 || seen.has(md5)) continue;
    seen.add(md5);
    const text = strip(part.slice(0, 3000));
    const meta = text.match(/([A-Za-z ]+\[[a-z]{2,3}\](?:, [A-Za-z ]+\[[a-z]{2,3}\])*)?,?\s*(epub|pdf|mobi|azw3|fb2|djvu|cbz|cbr|txt)\b,?\s*([\d.]+\s?[KMG]B)?/i);
    const year = text.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
    const title = strip((part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || part.match(/>([^<]{3,})</))?.[1] || '');
    if (!title) continue;
    hits.push({
      title,
      year,
      language: meta?.[1]?.trim(),
      format: meta?.[2]?.toLowerCase(),
      size: meta?.[3],
      url: `https://${host}/md5/${md5}`,
      source: 'annas-archive',
    });
  }
  return hits;
}

async function searchAnnas(query: string): Promise<BookHit[]> {
  const errors: string[] = [];
  for (const host of ANNAS_MIRRORS) {
    try {
      const { html, status } = await crawlHtml(`https://${host}/search?q=${encodeURIComponent(query)}`);
      const hits = parseAnnas(html, host);
      if (hits.length) return hits;
      const why = /ddos-guard/i.test(html) ? 'DDoS-Guard JS challenge' : /may be for sale/i.test(html) ? 'domain parked' : 'no /md5/ results';
      errors.push(`${host}: ${why} (HTTP ${status})`);
    } catch (e) {
      errors.push(`${host}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function searchZlib(_query: string): Promise<BookHit[]> {
  throw new Error('Z-Library search requires an account login (heartleo/zlib needs `zlib login`); SearXNG z-library engine inactive upstream (#3610); no account created');
}

export async function searchBooks(query: string, opts: { limit?: number } = {}): Promise<BooksResult> {
  const limit = opts.limit ?? 20;
  const out: BooksResult = { query, results: [], sources_used: [], sources_failed: [] };
  const sources: [string, (q: string) => Promise<BookHit[]>][] = [
    ['annas-archive', searchAnnas],
    ['z-library', searchZlib],
  ];
  await Promise.all(
    sources.map(async ([name, fn]) => {
      try {
        const hits = await fn(query);
        out.sources_used.push(name);
        out.results.push(...hits);
      } catch (e) {
        out.sources_failed.push({ source: name, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  out.results = out.results.slice(0, limit);
  return out;
}
