import { loadConfig } from '../config.js';

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
        ({ results, envelope } = await searchSearxng(query, { ...options, limit: Math.max(limit, 30) }));
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
  for (const { engine, results } of successful) {
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
  const results = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ result, score, engines: contributing }) => ({ ...result, score, engine: [...contributing].join(',') }));
  const response: SearchResponse = { query, results, provider_used: successful.map(({ engine }) => engine).join(','), total: results.length, contributingEngines: successful.map(({ engine }) => engine), failures, envelope: successful.find(({ envelope }) => envelope)?.envelope };
  if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, value: response });
  return response;
}
