import { loadConfig } from '../config.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  score?: number;
}

export interface SearchOptions {
  mode?: 'quick' | 'live' | 'deep';
  categories?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
  engines?: string[];
  limit?: number;
  provider?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  provider_used: string;
  total: number;
}

async function searchSearxng(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const config = loadConfig();
  const providerCfg = config.search.providers.searxng || {};
  const baseUrl = providerCfg.url || 'http://127.0.0.1:8888';
  const timeoutMs = providerCfg.timeoutMs || 4500;

  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  if (options.categories?.length) {
    url.searchParams.set('categories', options.categories.join(','));
  } else if (options.mode === 'live') {
    url.searchParams.set('categories', 'news,general');
    url.searchParams.set('time_range', options.timeRange || 'day');
  } else if (options.mode === 'deep') {
    url.searchParams.set('categories', 'general,it,science');
  }

  if (options.timeRange && !url.searchParams.has('time_range')) {
    url.searchParams.set('time_range', options.timeRange);
  }

  if (options.engines?.length) {
    url.searchParams.set('engines', options.engines.join(','));
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`SearXNG HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string; score?: number }> };
  if (!Array.isArray(data.results)) return [];

  const max = options.limit || 15;
  return data.results.slice(0, max).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    engine: r.engine,
    score: r.score,
  }));
}

async function searchTinyFish(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const apiKey = process.env['TINY' + 'FISH_API_KEY'];
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

export async function executeSearch(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const config = loadConfig();
  const pipeline = options.provider ? [options.provider] : config.search.pipeline;
  const errors: string[] = [];

  for (const provider of pipeline) {
    try {
      let results: SearchResult[] = [];
      if (provider === 'searxng') {
        results = await searchSearxng(query, options);
      } else if (provider === 'tinyfish') {
        results = await searchTinyFish(query, options);
      } else {
        throw new Error(`Unknown search provider: ${provider}`);
      }

      if (results.length > 0 || pipeline.length === 1) {
        return {
          query,
          results,
          provider_used: provider,
          total: results.length,
        };
      }
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All search providers failed for query "${query}". Errors: ${errors.join('; ')}`);
}
