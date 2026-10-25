import { loadConfig } from '../config.js';

export interface GithubRepo {
  name: string;
  description: string;
  url: string;
  stars?: number;
  language?: string;
  license?: string;
}

export interface GithubSearchResponse {
  query: string;
  repos: GithubRepo[];
  provider_used: string;
  total: number;
}

export async function searchGithubRepos(query: string, limit = 10): Promise<GithubSearchResponse> {
  const config = loadConfig();
  const searxUrl = config.search?.providers?.searxng?.url || 'http://127.0.0.1:8888';

  // 1. Try local SearXNG GitHub engine first
  try {
    const url = new URL('/search', searxUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('engines', 'github');
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });

    if (res.ok) {
      const data = await res.json() as any;
      if (Array.isArray(data.results) && data.results.length > 0) {
        const repos: GithubRepo[] = data.results.slice(0, limit).map((r: any) => ({
          name: r.title || r.package_name || '',
          description: r.content || '',
          url: r.url || '',
          stars: r.popularity,
          language: r.tags?.[0],
          license: r.license_name,
        }));

        return {
          query,
          repos,
          provider_used: 'searxng-github',
          total: repos.length,
        };
      }
    }
  } catch (err) {
    // Fall back to direct GitHub API
  }

  // 2. Direct GitHub Search API fallback
  const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`;
  const res = await fetch(ghUrl, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': 'Phrog-Web-Agent',
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub Search API HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  const repos: GithubRepo[] = (data.items || []).slice(0, limit).map((item: any) => ({
    name: item.full_name || item.name,
    description: item.description || '',
    url: item.html_url,
    stars: item.stargazers_count,
    language: item.language,
    license: item.license?.spdx_id || item.license?.name,
  }));

  return {
    query,
    repos,
    provider_used: 'github-api',
    total: repos.length,
  };
}
