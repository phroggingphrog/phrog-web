import { loadConfig } from '../config.js';
import { canonicalKey, fuseEngineRanks, type EngineRankedRow } from './rank.js';
import { shapeQuery } from './query-shape.js';
import { refineEnabled, refineQuery } from './query-llm.js';
import { rerank, rerankEnabled, rerankMaxCandidates } from './rerank.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  score?: number;
  image?: string;
  thumbnail?: string;
  raw?: Record<string, unknown>;
  metadata?: {
    studyType?: string;
    sampleSize?: number;
    year?: number;
    citationCount?: number;
    journal?: string;
    doi?: string;
  };
}

export interface SearchOptions {
  mode?: 'quick' | 'live' | 'deep' | 'academic';
  domain?: string;
  categories?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
  engines?: string[];
  limit?: number;
  provider?: string;
  pageno?: number;
  language?: string;
  safesearch?: string;
}

export interface SearchResponse {
  /** Present when engines were unresponsive or the candidate set is thin. */
  degraded?: { unresponsive_engines: string[]; thin: boolean };
  /** Present only when the cross-encoder stage ran or was attempted. */
  rerank?: Record<string, unknown>;
  query: string;
  results: SearchResult[];
  provider_used: string;
  total: number;
  envelope?: Record<string, unknown>;
  contributingEngines?: string[];
  failures?: { engine: string; error: string }[];
}

const engineCooldowns = new Map<string, number>();
const searchCache = new Map<string, { expires: number; value: SearchResponse }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 100;
const RRF_K = 60;

async function searchSearxng(query: string, options: SearchOptions): Promise<{ results: SearchResult[]; envelope?: Record<string, unknown> }> {
  const config = loadConfig();
  const providerCfg = config.search.providers.searxng || {};
  const baseUrl = providerCfg.url || 'http://127.0.0.1:8888';
  const timeoutMs = providerCfg.timeoutMs || 4500;

  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const explicitCats = options.categories || (options.domain ? [options.domain] : undefined);
  if (explicitCats?.length) {
    url.searchParams.set('categories', explicitCats.join(','));
  } else if (options.mode === 'academic') {
    url.searchParams.set('categories', 'science,academic');
  } else if (options.mode === 'live') {
    url.searchParams.set('categories', 'news,general');
    url.searchParams.set('time_range', options.timeRange || 'day');
  } else if (options.mode === 'deep') {
    // Domain-agnostic by default; broad multi-engine web search
    url.searchParams.set('categories', 'general');
  }

  if (options.timeRange && !url.searchParams.has('time_range')) {
    url.searchParams.set('time_range', options.timeRange);
  }

  if (options.engines?.length) {
    url.searchParams.set('engines', options.engines.join(','));
  }
  if (options.pageno) url.searchParams.set('pageno', String(options.pageno));
  if (options.language) url.searchParams.set('language', options.language);
  if (options.safesearch) url.searchParams.set('safesearch', options.safesearch);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`SearXNG HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string; score?: number }> } & Record<string, unknown>;
  if (!Array.isArray(data.results)) return { results: [] };

  const max = options.limit || 15;
  const { results: _drop, ...envelope } = data;
  const images = (options.categories || []).includes('images');
  const noisy = new Set(['lucide', 'artic', 'iconify', 'svgrepo', 'openclipart']);
  const results = data.results.filter(r => !(images && noisy.has(r.engine as string))).slice(0, max).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    engine: r.engine,
    score: r.score,
    ...((r as any).img_src && { image: (r as any).img_src, thumbnail: (r as any).thumbnail_src || undefined }),
    raw: r as Record<string, unknown>,
  }));
  return { results, envelope };
}

async function searchTinyFish(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const p = globalThis.process;
  const apiKey = p ? p.env.TINYFISH_API_KEY : undefined;
  if (!apiKey) {
    throw new Error('TINYFISH_API_KEY is not configured in environment');
  }

  const config = loadConfig();
  const providerCfg = config.search.providers.tinyfish || {};
  const baseUrl = providerCfg.url || 'https://api.search.tinyfish.ai';
  const timeoutMs = providerCfg.timeoutMs || 5000;

  const url = new URL(baseUrl);
  url.searchParams.set('query', query);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`TinyFish HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as { results?: Array<{ title?: string; url?: string; snippet?: string; description?: string }> };
  if (!Array.isArray(data.results)) return [];

  const max = options.limit || 15;
  return data.results.slice(0, max).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.snippet || r.description || '',
    engine: 'tinyfish',
  }));
}

async function searchConsensus(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const p = globalThis.process;
  const apiKey = p ? p.env.CONSENSUS_API_KEY : undefined;
  if (!apiKey) {
    throw new Error('CONSENSUS_API_KEY is not configured in environment');
  }

  const config = loadConfig();
  const providerCfg = config.search?.providers?.consensus || {};
  const baseUrl = providerCfg.url || 'https://api.consensus.app/v1/search';
  const timeoutMs = providerCfg.timeoutMs || 7000;

  const url = new URL(baseUrl);
  url.searchParams.set('query', query);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Consensus HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      doi?: string;
      abstract?: string;
      takeaway?: string;
      study_type?: string;
      sample_size?: number;
      publish_year?: number;
      citation_count?: number;
      journal_name?: string;
    }>;
  };

  if (!Array.isArray(data.results)) return [];

  const max = options.limit || 10;
  return data.results.slice(0, max).map(r => {
    const parts: string[] = [];
    if (r.takeaway) parts.push(r.takeaway);
    else if (r.abstract) parts.push(r.abstract);

    const metaParts: string[] = [];
    if (r.study_type) metaParts.push(r.study_type.toUpperCase());
    if (r.sample_size) metaParts.push(`n=${r.sample_size}`);
    if (r.publish_year) metaParts.push(String(r.publish_year));
    if (r.citation_count) metaParts.push(`${r.citation_count} citations`);

    const snippetText = parts.join(' ') + (metaParts.length ? ` [${metaParts.join(', ')}]` : '');
    const paperUrl = r.doi ? `https://doi.org/${r.doi}` : (r.url || '');

    return {
      title: r.title || 'Untitled Research Paper',
      url: paperUrl,
      snippet: snippetText,
      engine: 'consensus',
      score: r.citation_count,
      metadata: {
        studyType: r.study_type,
        sampleSize: r.sample_size,
        year: r.publish_year,
        citationCount: r.citation_count,
        journal: r.journal_name,
        doi: r.doi,
      },
    };
  });
}

/**
 * Re-order one provider's rows by their per-engine positions (SearXNG reports `engines`
 * and parallel `positions`). Falls back untouched when the provider gave no engine data,
 * so non-SearXNG providers keep the previous behaviour.
 */
function rerankEngineLevel(results: SearchResult[], query: string): SearchResult[] {
  if (results.length < 2) return results;
  const rows: EngineRankedRow[] = results.map((r) => {
    const raw = (r.raw || {}) as Record<string, unknown>;
    return {
      url: r.url,
      engine: r.engine,
      content: r.snippet,
      engines: Array.isArray(raw.engines) ? (raw.engines as string[]) : undefined,
      positions: Array.isArray(raw.positions) ? (raw.positions as number[]) : undefined,
      publishedDate: typeof raw.publishedDate === 'string' ? raw.publishedDate : null,
    };
  });
  if (!rows.some((r) => Array.isArray(r.positions) && r.positions.length > 0)) return results;
  const byKey = new Map(results.map((r) => [canonicalKey(r.url), r]));
  return fuseEngineRanks(rows, {}, undefined, query)
    .map((f) => byKey.get(canonicalKey(f.url)))
    .filter((r): r is SearchResult => Boolean(r));
}

/**
 * Multi-query search: run the raw query and its shaped variants in parallel, then fuse the
 * lists with engine-level RRF. This is the case RRF was built for — several ranked lists of
 * the same intent, where agreement between variants is evidence.
 *
 * Rows are tagged with synthetic engines `q0..qn` so fuseEngineRanks treats each variant as
 * its own voter; q0 keeps a weight premium because it is what the caller actually asked for.
 */
async function searchSearxngShaped(query: string, options: SearchOptions): Promise<{ results: SearchResult[]; envelope?: Record<string, unknown> }> {
  const shaped = shapeQuery(query);
  const variants = [query, ...(shaped.shaped ? shaped.variants.slice(0, 2) : [])];
  if (refineEnabled()) {
    const refined = await refineQuery(query);
    if (refined.query && !variants.includes(refined.query)) variants.push(refined.query);
  }
  if (variants.length < 2) return searchSearxng(query, options);

  const lists = await Promise.all(variants.map(async (v, i) => {
    try {
      const r = await searchSearxng(v, { ...options, limit: Math.max(options.limit || 15, 20) });
      return { i, results: r.results, envelope: r.envelope };
    } catch {
      return { i, results: [] as SearchResult[], envelope: undefined as Record<string, unknown> | undefined };
    }
  }));

  const weights: Record<string, number> = { q0: 1.5 };
  const rows: EngineRankedRow[] = [];
  const byKey = new Map<string, SearchResult>();
  for (const { i, results } of lists) {
    results.forEach((r, idx) => {
      const key = canonicalKey(r.url);
      if (!byKey.has(key)) byKey.set(key, r);
      rows.push({
        url: r.url,
        engines: [`q${i}`],
        positions: [idx + 1],
        publishedDate: typeof (r.raw as Record<string, unknown> | undefined)?.publishedDate === 'string'
          ? ((r.raw as Record<string, unknown>).publishedDate as string) : null,
      });
    });
  }
  if (!rows.length) return { results: [], envelope: lists[0]?.envelope };

  const fused: SearchResult[] = [];
  for (const f of fuseEngineRanks(rows, {}, { ...weights }, query)) {
    const hit = byKey.get(canonicalKey(f.url));
    if (hit) fused.push({ ...hit, engine: f.engines.join(',') || hit.engine, score: f.score });
  }

  return { results: fused, envelope: lists[0]?.envelope };
}

export async function executeSearch(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const config = loadConfig();

  // If explicitly academic or science categories, use Consensus -> SearXNG
  const isAcademic =
    options.mode === 'academic' ||
    options.categories?.some(c => ['science', 'academic', 'papers'].includes(c.toLowerCase())) ||
    options.provider === 'consensus';

  let pipeline: string[];
  if (options.provider) {
    pipeline = [options.provider];
  } else if (isAcademic) {
    pipeline = ['consensus', 'searxng'];
  } else {
    pipeline = config.search.pipeline;
  }

  const limit = Math.max(1, Math.min(50, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 15));
  const cacheKey = JSON.stringify([query.trim(), { ...options, limit, provider: pipeline.join(',') }]);
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return { ...cached.value, results: cached.value.results.slice(0, limit) };
  if (cached) searchCache.delete(cacheKey);

  const now = Date.now();
  const eligible = pipeline.filter((id) => !engineCooldowns.has(id) || (engineCooldowns.get(id) ?? 0) <= now);
  const engines = eligible.length ? eligible : pipeline;
  const settled = await Promise.all(engines.map(async (engine) => {
    try {
      let results: SearchResult[] = [];
      let envelope: Record<string, unknown> | undefined;
      if (engine === 'searxng') {
        // Default OFF: measured neutral on the history corpus (+2.5% recall, -0.3% MRR, both CIs
        // spanning zero) while costing two extra SearXNG calls. Enable with PHROG_WEB_QUERY_SHAPING=1.
        const shaping = process.env.PHROG_WEB_QUERY_SHAPING === '1';
        ({ results, envelope } = shaping
          ? await searchSearxngShaped(query, { ...options, limit: Math.max(limit, 30) })
          : await searchSearxng(query, { ...options, limit: Math.max(limit, 30) }));
        results = results.map((item) => ({ ...item, engine: item.engine || engine }));
      }
      else if (engine === 'tinyfish') results = await searchTinyFish(query, { ...options, limit: Math.max(limit, 30) });
      else if (engine === 'consensus') results = await searchConsensus(query, { ...options, limit: Math.max(limit, 30) });
      else throw new Error(`Unknown search provider: ${engine}`);
      engineCooldowns.delete(engine);
      return { engine, results, envelope };
    } catch (err) {
      engineCooldowns.set(engine, Date.now() + 60_000);
      return { engine, results: [] as SearchResult[], error: err instanceof Error ? err.message : String(err) };
    }
  }));

  const failures = settled.flatMap((item) =>
    'error' in item && typeof item.error === 'string' ? [{ engine: item.engine, error: item.error }] : [],
  );
  const successful = settled.filter((item) => !('error' in item));
  if (!successful.length) throw new Error(`All search providers failed for query "${query}". Errors: ${failures.map(({ engine, error }) => `${engine}: ${error}`).join('; ')}`);

  const fused = new Map<string, { result: SearchResult; score: number; engines: Set<string> }>();
  for (const { engine, results: providerResults } of successful) {
    const results = engine === 'searxng' ? rerankEngineLevel(providerResults, query) : providerResults;
    results.forEach((result, index) => {
      let key = result.url;
      try { const u = new URL(result.url); u.hash = ''; u.hostname = u.hostname.toLowerCase(); if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, ''); key = u.toString(); } catch { /* keep provider URL */ }
      const row = fused.get(key) ?? { result, score: 0, engines: new Set<string>() };
      row.score += 1 / (RRF_K + index + 1);
      row.engines.add(result.engine || engine);
      if (!row.result.snippet && result.snippet) row.result = result;
      fused.set(key, row);
    });
  }
  const rankedAll = [...fused.values()].sort((a, b) => b.score - a.score)
    .map(({ result, score, engines: contributing }) => ({ ...result, score, engine: [...contributing].join(',') }));

  // Stage 3: cross-encoder precision over the head of the RRF order. Reranking can only
  // reorder what RRF found, so a miss here means the engines failed, not the reranker.
  let results = rankedAll.slice(0, limit);
  let rerankInfo: Record<string, unknown> | undefined;
  // Rerank is a DEEP-RESEARCH stage only (owner decision 2026-11-05): quick/live search must
  // stay single-second, and the cross-encoder's measured gain concentrates in multi-hop
  // research where precision on the head of the list compounds into the final answer.
  const deepRequest = options.mode === 'deep' || isAcademic || options.provider === 'feynman' || options.provider === 'vane';
  if (rerankEnabled() && deepRequest && rankedAll.length > 1 && rankedAll.length <= rerankMaxCandidates()) {
    const head = rankedAll.slice(0, Math.max(limit, 20));
    const outcome = await rerank(query, head.map((r) => ({ title: r.title, snippet: r.snippet, url: r.url })));
    rerankInfo = { model: outcome.model, ms: outcome.ms, applied: outcome.order.length === head.length, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    if (outcome.order.length === head.length) {
      results = outcome.order.map((i) => head[i]).slice(0, limit);
    }
  }

  const envelope = successful.find(({ envelope }) => envelope)?.envelope as Record<string, unknown> | undefined;
  const unresponsive = Array.isArray(envelope?.unresponsive_engines)
    ? (envelope!.unresponsive_engines as unknown[]).map((u) => (Array.isArray(u) ? String(u[0]) : String(u)))
    : [];
  // A degraded search must SAY it is degraded: a thin result set caused by a rate-limited
  // engine is not the same as "the web has nothing".
  const degraded = unresponsive.length ? { unresponsive_engines: unresponsive, thin: rankedAll.length < 15 } : undefined;
  const response: SearchResponse = { query, results, provider_used: successful.map(({ engine }) => engine).join(','), total: results.length, contributingEngines: successful.map(({ engine }) => engine), failures, envelope, ...(degraded ? { degraded } : {}), ...(rerankInfo ? { rerank: rerankInfo } : {}) };
  if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value: response });
  return response;
}
