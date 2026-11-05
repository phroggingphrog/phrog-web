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
