// OzBargain deals. Its /search/ is disallowed in robots.txt (and returns 403), so deals are found through
// web search, then read from the public RSS feeds (tag/brand/category) and deal pages.
import { executeSearch } from './search.js';

const BASE = 'https://www.ozbargain.com.au';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 10000;
const MAX_FEEDS = 3;
const MAX_PAGES = 8;

export interface Deal {
  title: string;
  url: string;
  price?: string;
  store_url?: string;
  votes_up?: number;
  votes_down?: number;
  clicks?: number;
  comments?: number;
  posted?: string;
  expired?: boolean;
  snippet?: string;
}

export interface DealsResult {
  query?: string;
  results: Deal[];
  sources: string[];
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (s: string) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const priceOf = (title: string) => title.match(/(?:A?\$|AU\$)\s?[\d,]+(?:\.\d{2})?/)?.[0];
const attr = (s: string, name: string) => s.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const num = (v?: string) => (v === undefined ? undefined : Number(v));

function parseFeed(xml: string): Deal[] {
  return xml.split('<item>').slice(1).map((it) => {
    const title = decode(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    const meta = it.match(/<ozb:meta[^>]*>/)?.[0] || '';
    const date = it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    return {
      title,
      url: it.match(/<link>([^<]+)<\/link>/)?.[1] || '',
      price: priceOf(title),
      store_url: attr(meta, 'url') ? decode(attr(meta, 'url')!) : undefined,
      votes_up: num(attr(meta, 'votes-pos')),
      votes_down: num(attr(meta, 'votes-neg')),
      clicks: num(attr(meta, 'click-count')),
      comments: num(attr(meta, 'comment-count')),
      posted: date ? new Date(date).toISOString().slice(0, 10) : undefined,
      expired: /expired/i.test(meta) || undefined,
      snippet: strip(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 240),
    };
  }).filter((d) => d.url);
}

async function readDealPage(url: string, fallbackTitle: string): Promise<Deal | null> {
  const html = await get(url);
  if (!html) return null;
  const title = decode(html.match(/og:title" content="([^"]*)"/)?.[1] || fallbackTitle);
  const posted = html.match(/class="submitted"[\s\S]{0,400}? on (\d{2})\/(\d{2})\/(\d{4})/);
  return {
    title,
    url,
    price: priceOf(title),
    store_url: undefined,
    votes_up: num(html.match(/nvb voteup"><i[^>]*><\/i><span>(\d+)/)?.[1]),
    votes_down: num(html.match(/nvb votedown"><i[^>]*><\/i><span>(\d+)/)?.[1]),
    posted: posted ? `${posted[3]}-${posted[2]}-${posted[1]}` : undefined,
    expired: /nodeexpiry expired|tagger expired/.test(html),
    snippet: decode(html.match(/og:description" content="([^"]*)"/)?.[1] || '').slice(0, 240),
  };
}

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/** Latest deals (no query) or deals matching a product query, newest active and most upvoted first. */
export async function searchDeals(query?: string, opts: { limit?: number; includeExpired?: boolean } = {}): Promise<DealsResult> {
  const limit = opts.limit ?? 10;
  if (!query) {
    const xml = await get(`${BASE}/deals/feed`);
    return { results: xml ? parseFeed(xml).slice(0, limit) : [], sources: [`${BASE}/deals/feed`] };
  }

  const web = await executeSearch(`ozbargain ${query}`, { limit: 30 });
  const hits = (web.results as any[]).filter((r) => String(r.url).startsWith(BASE));
  const feeds = hits.map((r) => String(r.url).match(/^https:\/\/www\.ozbargain\.com\.au\/(tag|brand|cat)\/[^/?#]+/)?.[0]).filter(Boolean) as string[];
  const nodes = hits.filter((r) => /\/node\/\d+$/.test(r.url));

  const byUrl = new Map<string, Deal>();
  const sources: string[] = [];
  const want = tokens(query);
  const relevant = (title: string) => {
    const t = new Set(tokens(title));
    return want.filter((w) => t.has(w)).length >= (want.length <= 3 ? want.length : Math.ceil(want.length * 0.66));
  };

  for (const f of [...new Set(feeds)].slice(0, MAX_FEEDS)) {
    const xml = await get(`${f}/feed`);
    if (!xml) continue;
    sources.push(`${f}/feed`);
    for (const d of parseFeed(xml)) if (relevant(d.title)) byUrl.set(d.url, d);
  }
  const pages = await Promise.all(nodes.filter((n) => !byUrl.has(n.url)).slice(0, MAX_PAGES).map((n) => readDealPage(n.url, n.title)));
  for (const d of pages) if (d) byUrl.set(d.url, d);
  if (pages.some(Boolean)) sources.push('ozbargain deal pages via web search');

  const results = [...byUrl.values()]
    .filter((d) => opts.includeExpired !== false || !d.expired)
    .sort((a, b) => Number(!!a.expired) - Number(!!b.expired) || (b.votes_up ?? 0) - (a.votes_up ?? 0))
    .slice(0, limit);
  return { query, results, sources };
}
