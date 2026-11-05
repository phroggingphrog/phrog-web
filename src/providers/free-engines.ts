import { loadConfig } from '../config.js';
// Type-only import: erased at compile time, so this does not create a runtime cycle with search.ts.
import type { SearchOptions, SearchResult } from './search.js';

/**
 * Two keyless search backends taken from the dsh-web-search plugin, each admitted on measured
 * evidence rather than on its README:
 *
 *  - Exa over its anonymous MCP endpoint. It is a semantic index, not a keyword page, and on the
 *    query "podman quadlet" it put docs.podman.io first — the page the official-docs query is
 *    supposed to find. Latency 0.7-1.8 s, so it can sit in the default pipeline.
 *  - AnySearch's JSON API. Genuinely keyless and alive, but 2.7-4.6 s per call and tuned for CJK:
 *    on "nginx proxy_pass websocket" it answered with Italian, Russian and Chinese blogs. Too slow
 *    to put in front of an interactive search and too noisy for English technical work, so it is
 *    opt-in (deep mode or an explicit provider).
 *
 * Firecrawl's keyless tier is NOT here: it answers 403 to this box with an explicit "your IP looks
 * like a VPN or proxy" body, which is the same refusal dsh documents.
 */

/** Anonymous Exa allows 2 concurrent calls; five parallel queries come back 429 on four. */
const EXA_MAX_CONCURRENT = 2;
let exaInFlight = 0;
const exaQueue: Array<() => void> = [];

async function acquireExa(): Promise<() => void> {
  if (exaInFlight < EXA_MAX_CONCURRENT) { exaInFlight += 1; return releaseExa; }
  await new Promise<void>((resolve) => exaQueue.push(resolve));
  exaInFlight += 1;
  return releaseExa;
}

function releaseExa(): void {
  exaInFlight = Math.max(0, exaInFlight - 1);
  const next = exaQueue.shift();
  if (next) next();
}

/** Parse the text blob Exa returns: repeated blocks of Title/URL/Published/Author/Highlights. */
export function parseExaText(text: string, engine = 'exa'): SearchResult[] {
  const blocks = text.split(/\n(?=Title: )/);
  const out: SearchResult[] = [];
  for (const block of blocks) {
    const url = /^URL:\s*(\S+)/m.exec(block)?.[1];
    if (!url) continue;
    const title = (/^Title:\s*(.+)$/m.exec(block)?.[1] || url).trim();
    const highlights = block.split(/^Highlights:\s*$/m)[1] || '';
    const snippet = highlights.replace(/\s+/g, ' ').trim().slice(0, 320);
    out.push({ title, url, snippet, engine });
  }
  return out;
}

/** Exa via its anonymous MCP endpoint — no API key, JSON-RPC over SSE. */
export async function searchExaMcp(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const cfg = loadConfig().search?.providers?.exa || {};
  const url = cfg.url || 'https://mcp.exa.ai/mcp';
  const timeoutMs = cfg.timeoutMs || 6000;
  const numResults = Math.max(1, Math.min(20, options.limit || 10));

  const release = await acquireExa();
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'web_search_exa', arguments: { query, numResults } },
      }),
    });
    if (!res.ok) throw new Error(`Exa MCP HTTP ${res.status}: ${res.statusText}`);
    const raw = await res.text();
    // The endpoint answers with one or more SSE frames; a plain JSON body is also accepted.
    let text = '';
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const frame = JSON.parse(line.slice(6)) as { result?: { content?: Array<{ type?: string; text?: string }> } };
        for (const part of frame.result?.content || []) if (part?.text) text += part.text + '\n';
      } catch { /* skip a frame we cannot read, the next one may carry the payload */ }
    }
    if (!text && raw.trim().startsWith('{')) {
      const frame = JSON.parse(raw) as { result?: { content?: Array<{ text?: string }> } };
      for (const part of frame.result?.content || []) if (part?.text) text += part.text + '\n';
    }
    if (!text) throw new Error('Exa MCP returned no parsable content');
    return parseExaText(text).slice(0, numResults);
  } finally {
    release();
  }
}

interface AnySearchPayload {
  data?: { results?: Array<{ title?: string; url?: string; snippet?: string; description?: string }> };
}

export function parseAnySearch(payload: AnySearchPayload, engine = 'anysearch'): SearchResult[] {
  const rows = payload?.data?.results;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title || r.url || '',
      url: r.url as string,
      snippet: (r.snippet || r.description || '').replace(/\s+/g, ' ').trim().slice(0, 320),
      engine,
    }));
}

/** AnySearch JSON API — keyless, but slow and CJK-oriented: opt-in only. */
export async function searchAnySearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const cfg = loadConfig().search?.providers?.anysearch || {};
  const url = cfg.url || 'https://api.anysearch.com/v1/search';
  const timeoutMs = cfg.timeoutMs || 7000;
  const maxResults = Math.max(1, Math.min(20, options.limit || 10));

  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!res.ok) throw new Error(`AnySearch HTTP ${res.status}: ${res.statusText}`);
  return parseAnySearch(await res.json() as AnySearchPayload).slice(0, maxResults);
}

/**
 * Firecrawl search, in preference order:
 *
 *  1. omniroute (/v1/search, provider "firecrawl"). The owner's Firecrawl key already lives in
 *     omniroute's provider_connections, so this spends real quota instead of scraping a keyless
 *     tier, keeps the key out of phrog-web's env, and inherits omniroute's result cache: a cold
 *     query measured 1.43 s, a repeat 6 ms.
 *  2. The crawl-egress tunnel. Keyless Firecrawl answers 403 to this box directly ("your IP
 *     address looks like a VPN or proxy") but 200 through the tunnel, which is what dsh documents.
 *     Kept as the fallback for when omniroute is down.
 *  3. Direct, behind PHROG_WEB_FIRECRAWL_DIRECT=1.
 *
 * Node's fetch cannot take a proxy without undici, which is not a dependency, so the tunnelled
 * call goes through curl.
 */
interface FirecrawlPayload {
  success?: boolean;
  data?: Array<{ url?: string; title?: string; description?: string; markdown?: string }>;
}

export function parseFirecrawl(payload: FirecrawlPayload, engine = 'firecrawl'): SearchResult[] {
  const rows = payload?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
    .map((r) => {
      const prose = (r.description || r.markdown || '').replace(/\[¶\][^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim();
      return { title: r.title || r.url || '', url: r.url as string, snippet: prose.slice(0, 320), engine };
    });
}

async function firecrawlViaTunnel(body: string, timeoutMs: number): Promise<string> {
  const proxy = process.env.PHROG_WEB_EGRESS_PROXY || 'http://127.0.0.1:18118';
  const url = loadConfig().search?.providers?.firecrawl?.url || 'https://api.firecrawl.dev/v1/search';
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile) as unknown as (
    file: string, args: string[], opts: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  const { stdout } = await run('curl', ['-s', '-m', String(Math.ceil(timeoutMs / 1000)), '-x', proxy,
    '-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', body], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

interface OmnirouteSearchPayload {
  results?: Array<{ title?: string; url?: string; snippet?: string; content?: string }>;
}

export function parseOmnirouteSearch(payload: OmnirouteSearchPayload, engine = 'firecrawl'): SearchResult[] {
  const rows = payload?.results;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title || r.url || '',
      url: r.url as string,
      snippet: (r.snippet || r.content || '').replace(/\s+/g, ' ').trim().slice(0, 320),
      engine,
    }));
}

/** Ask omniroute to run a search provider it already holds credentials for. */
export async function searchViaOmniroute(
  provider: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const key = globalThis.process?.env.OMNIROUTE_API_KEY;
  if (!key) throw new Error('OMNIROUTE_API_KEY is not configured');
  const base = globalThis.process?.env.OMNIROUTE_URL || 'http://127.0.0.1:20128';
  const limit = Math.max(1, Math.min(20, options.limit || 10));
  const res = await fetch(`${base}/v1/search`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, query, limit }),
  });
  if (!res.ok) throw new Error(`omniroute /v1/search ${provider} HTTP ${res.status}`);
  return parseOmnirouteSearch(await res.json() as OmnirouteSearchPayload).slice(0, limit);
}

export async function searchFirecrawl(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const cfg = loadConfig().search?.providers?.firecrawl || {};
  const url = cfg.url || 'https://api.firecrawl.dev/v1/search';
  const timeoutMs = cfg.timeoutMs || 20000;
  const limit = Math.max(1, Math.min(20, options.limit || 10));
  const body = JSON.stringify({ query, limit });

  // 1. omniroute holds the owner's key, so prefer it: real quota, cached repeats, no secret here.
  if (process.env.OMNIROUTE_API_KEY && process.env.PHROG_WEB_FIRECRAWL_VIA_OMNIROUTE !== '0') {
    try {
      const rows = await searchViaOmniroute('firecrawl', query, { ...options, limit });
      if (rows.length) return rows;
    } catch { /* fall through to the tunnel route below */ }
  }

  const direct = process.env.PHROG_WEB_FIRECRAWL_DIRECT === '1';
  if (direct) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return parseFirecrawl(await res.json() as FirecrawlPayload).slice(0, limit);
  }
  const raw = await firecrawlViaTunnel(body, timeoutMs);
  if (!raw.trim()) throw new Error('Firecrawl tunnel route returned nothing');
  return parseFirecrawl(JSON.parse(raw) as FirecrawlPayload).slice(0, limit);
}

/**
 * Wikimedia's own search API. Keyless and generous, and it is the wikipedia source that the
 * SearXNG engine could not reach (its engine records 429 on every query while this same API
 * answers 200 from both the host and the container). Opt-in: an encyclopedia page is not a web
 * result, so it should never enter the general fan-in unasked.
 */
interface WikimediaPayload {
  query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
}

export function parseWikimedia(payload: WikimediaPayload, engine = 'wikimedia'): SearchResult[] {
  const rows = payload?.query?.search;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.title === 'string' && r.title.length > 0)
    .map((r) => ({
      title: r.title as string,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((r.title as string).replace(/ /g, '_'))}`,
      snippet: (r.snippet || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 320),
      engine,
    }));
}

export async function searchWikimedia(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const limit = Math.max(1, Math.min(20, options.limit || 10));
  const url = new URL(loadConfig().search?.providers?.wikimedia?.url || 'https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', String(limit));
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(loadConfig().search?.providers?.wikimedia?.timeoutMs || 6000),
    headers: { 'User-Agent': 'phrog-web/1.0 (+https://github.com/phroggingphrog/phrog-web)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}: ${res.statusText}`);
  return parseWikimedia(await res.json() as WikimediaPayload).slice(0, limit);
}
