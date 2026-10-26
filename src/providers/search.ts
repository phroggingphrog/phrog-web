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
}

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
  const results = data.results.slice(0, max).map(r => ({
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

  const errors: string[] = [];

  for (const provider of pipeline) {
    try {
      let results: SearchResult[] = [];
      let envelope: Record<string, unknown> | undefined;
      if (provider === 'searxng') {
        ({ results, envelope } = await searchSearxng(query, options));
      } else if (provider === 'tinyfish') {
        results = await searchTinyFish(query, options);
      } else if (provider === 'consensus') {
        results = await searchConsensus(query, options);
      } else {
        throw new Error(`Unknown search provider: ${provider}`);
      }

      if (results.length > 0 || pipeline.length === 1) {
        return {
          query,
          results,
          provider_used: provider,
          total: results.length,
          envelope,
        };
      }
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All search providers failed for query "${query}". Errors: ${errors.join('; ')}`);
}
