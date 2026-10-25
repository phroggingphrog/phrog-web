import { loadConfig } from '../config.js';

export interface SocialPost {
  source: string;
  title?: string;
  text: string;
  url: string;
  author?: string;
  community?: string;
  score?: number;
  comments?: number;
  created_at?: string;
}

export interface SocialOptions {
  sources?: string[];
  limit?: number;
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

export interface SocialResponse {
  query: string;
  results: SocialPost[];
  sources_used: string[];
  sources_failed: { source: string; error: string }[];
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const REDDIT_TIMEOUT_MS = 25000;
const SEARXNG = 'http://127.0.0.1:8888';
const CRAWL4AI = process.env.REDDIT_CRAWL4AI_URL || 'http://127.0.0.1:11236';

const SEARX_ENGINES: Record<string, string> = {
  lemmy: 'lemmy posts',
  mastodon: 'mastodon hashtags',
  youtube: 'youtube',
};

async function getJson(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const iso = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : undefined);

async function redditJson(url: string): Promise<any> {
  try {
    return await getJson(url, {}, REDDIT_TIMEOUT_MS);
  } catch (directErr) {
    // Reddit blocks plain clients; same fallback as engines/web_acquisition/reddit.py (Crawl4AI renders the .json page).
    const token = process.env.CRAWL4AI_API_TOKEN;
    if (!token) throw directErr;
    const res = await fetch(`${CRAWL4AI}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [url], priority: 10 }),
      signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`reddit direct failed, crawl4ai HTTP ${res.status}`);
    const payload: any = await res.json();
    const r = payload?.results?.[0];
    const m = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(String(r?.html || ''));
    if (!r?.success || !m) throw new Error('reddit blocked (no JSON via crawl4ai)');
    const unescaped = m[1]
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return JSON.parse(unescaped);
  }
}

async function reddit(q: string, limit: number, t: string): Promise<SocialPost[]> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&t=${t}&limit=${limit}&type=link&raw_json=1`;
  const data = await redditJson(url);
  return (data?.data?.children || []).map((c: any) => c.data).map((d: any): SocialPost => ({
    source: 'reddit',
    title: d.title,
    text: d.selftext || d.title || '',
    url: 'https://www.reddit.com' + d.permalink,
    author: d.author,
    community: d.subreddit_name_prefixed,
    score: d.score,
    comments: d.num_comments,
    created_at: iso(d.created_utc),
  }));
}

async function hackernews(q: string, limit: number, range?: string): Promise<SocialPost[]> {
  const secs: Record<string, number> = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
  let url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${limit}`;
  if (range) url += `&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - secs[range]}`;
  const data = await getJson(url);
  return (data.hits || []).map((h: any): SocialPost => ({
    source: 'hackernews',
    title: h.title || h.story_title || undefined,
    text: h.story_text || h.comment_text || h.title || h.story_title || '',
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    author: h.author,
    score: h.points ?? undefined,
    comments: h.num_comments ?? undefined,
    created_at: h.created_at,
  }));
}

async function bluesky(q: string, limit: number): Promise<SocialPost[]> {
  const data = await getJson(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${limit}&sort=top`,
  );
  return (data.posts || []).map((p: any): SocialPost => ({
    source: 'bluesky',
    text: p.record?.text || '',
    url: `https://bsky.app/profile/${p.author?.handle}/post/${String(p.uri).split('/').pop()}`,
    author: p.author?.handle,
    score: p.likeCount,
    comments: p.replyCount,
    created_at: p.record?.createdAt || p.indexedAt,
  }));
}

async function searx(source: string, q: string, limit: number, range?: string): Promise<SocialPost[]> {
  let url = `${SEARXNG}/search?format=json&q=${encodeURIComponent(q)}&engines=${encodeURIComponent(SEARX_ENGINES[source])}`;
  if (range) url += `&time_range=${range}`;
  const data = await getJson(url);
  return (data.results || []).slice(0, limit).map((r: any): SocialPost => ({
    source,
    title: r.title,
    text: r.content || r.title || '',
    url: r.url,
    author: r.author || undefined,
    created_at: r.publishedDate ? new Date(r.publishedDate).toISOString() : undefined,
  }));
}

export async function searchSocial(query: string, opts: SocialOptions = {}): Promise<SocialResponse> {
  loadConfig(); // loads ~/.config/phrog-web.env into process.env
  const limit = opts.limit ?? 10;
  const range = opts.timeRange;
  const all: Record<string, () => Promise<SocialPost[]>> = {
    reddit: () => reddit(query, limit, range || 'year'),
    hackernews: () => hackernews(query, limit, range),
    bluesky: () => bluesky(query, limit),
    lemmy: () => searx('lemmy', query, limit, range),
    mastodon: () => searx('mastodon', query, limit, range),
    youtube: () => searx('youtube', query, limit, range),
  };
  const names = (opts.sources?.length ? opts.sources : Object.keys(all)).filter((s) => all[s]);
  const settled = await Promise.allSettled(names.map((s) => all[s]()));

  const results: SocialPost[] = [];
  const sources_used: string[] = [];
  const sources_failed: { source: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value.length) sources_used.push(names[i]);
      results.push(...r.value);
    } else {
      sources_failed.push({ source: names[i], error: String(r.reason?.message || r.reason).slice(0, 200) });
    }
  });
  results.sort((a, b) => (b.created_at ? Date.parse(b.created_at) : 0) - (a.created_at ? Date.parse(a.created_at) : 0));
  return { query, results, sources_used, sources_failed };
}
