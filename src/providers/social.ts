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
  instance?: string;
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

const decodeHtml = (s: string) =>
  s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&bull;/g, '*').replace(/&amp;/g, '&').trim();

function parseRedlib(html: string, base: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const chunk of html.split('<div class="post" id="').slice(1)) {
    const href = /class="post_title">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>/.exec(chunk);
    if (!href) continue;
    const sub = /class="post_subreddit" href="[^"]*">([^<]+)</.exec(chunk)?.[1];
    const author = /class="post_author[^"]*" href="[^"]*">u\/([^<]+)</.exec(chunk)?.[1];
    const score = /class="post_score" title="(-?\d+)"/.exec(chunk)?.[1];
    const comments = /class="post_comments" title="(\d+) comments?"/.exec(chunk)?.[1];
    const created = /class="created" title="([^"]+)"/.exec(chunk)?.[1];
    const body = /<div class="md">([\s\S]*?)<\/div><!-- SC_ON -->/.exec(chunk)?.[1];
    const title = decodeHtml(href[2]);
    const path = decodeHtml(href[1]);
    const ts = created ? Date.parse(created.replace(' UTC', 'Z').replace(/^(\w+ \d+ \d+), /, '$1 ')) : NaN;
    posts.push({
      source: 'reddit',
      title,
      text: body ? decodeHtml(body) : title,
      url: path.startsWith('/') ? 'https://www.reddit.com' + path : path,
      author,
      community: sub ? decodeHtml(sub) : undefined,
      score: score ? Number(score) : undefined,
      comments: comments ? Number(comments) : undefined,
      created_at: Number.isNaN(ts) ? undefined : new Date(ts).toISOString(),
      instance: base,
    });
  }
  return posts;
}

async function reddit(q: string, limit: number, t?: string): Promise<SocialPost[]> {
  const bases = (process.env.REDLIB_URLS || 'http://127.0.0.1:18095,https://safereddit.com')
    .split(',').map((b) => b.trim().replace(/\/$/, '')).filter(Boolean);
  const errs: string[] = [];
  for (const base of bases) {
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(base);
    // public Redlib instances intermittently return 404 / empty pages when Reddit rate-limits them
    for (let attempt = 0; attempt < (local ? 1 : 3); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&type=link${t ? `&t=${t}` : ''}`, {
        headers: { 'User-Agent': 'phrog-web/1.0', Accept: 'text/html' }, // browser UAs trigger Anubis challenges on public Redlib instances
        signal: AbortSignal.timeout(local ? 3000 : REDDIT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const posts = parseRedlib(await res.text(), base).slice(0, limit);
      if (posts.length) return posts;
      throw new Error('no posts parsed');
    } catch (e: any) {
      errs.push(`${base}${attempt ? ` (retry ${attempt})` : ''}: ${e?.cause?.code || e?.message}`);
      if (e?.cause?.code === 'ECONNREFUSED') break;
    }
    }
  }
  try {
    const posts = await redditRss(q, limit, t);
    if (posts.length) return posts;
    errs.push('reddit rss: no posts');
  } catch (e: any) {
    errs.push(`reddit rss: ${e?.message}`);
  }
  throw new Error(`redlib failed (${errs.join('; ')})`);
}

/** Reddit's own public Atom search feed: no score/comment counts, but works when Redlib instances are blocked. */
async function redditRss(q: string, limit: number, t?: string): Promise<SocialPost[]> {
  const res = await fetch(`https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=relevance${t ? `&t=${t}` : ''}&limit=${limit}`, {
    headers: { 'User-Agent': UA, Accept: 'application/atom+xml' },
    signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const dec = (x: string) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return xml.split('<entry>').slice(1).map((e) => ({
    source: 'reddit',
    title: dec(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
    text: dec(dec(e.match(/<content type="html">([\s\S]*?)<\/content>/)?.[1] || '')).replace(/<[^>]+>/g, ' ').replace(/[\s\u200b]+/g, ' ').replace(/\s*submitted by\s+\/u\/.*$/, '').trim().slice(0, 500),
    url: e.match(/<link href="([^"]+)"/)?.[1] || '',
    author: e.match(/<name>\/u\/([^<]+)<\/name>/)?.[1],
    community: e.match(/<category term="([^"]+)"/)?.[1],
    created_at: e.match(/<published>([^<]+)<\/published>/)?.[1] || e.match(/<updated>([^<]+)<\/updated>/)?.[1],
    instance: 'reddit.com/rss',
  })).filter((p) => p.url).slice(0, limit);
}

async function xSearch(q: string, limit: number): Promise<SocialPost[]> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    if (process.env.X_AUTH_TOKEN && process.env.X_CT0) throw new Error('cookie login not implemented yet');
    throw new Error('not configured');
  }
  const max = Math.min(100, Math.max(10, limit));
  const data = await getJson(
    `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=${max}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const users = new Map<string, string>((data.includes?.users || []).map((u: any) => [u.id, u.username]));
  return (data.data || []).slice(0, limit).map((tw: any): SocialPost => {
    const user = users.get(tw.author_id);
    return {
      source: 'x',
      text: tw.text || '',
      url: `https://x.com/${user || 'i'}/status/${tw.id}`,
      author: user,
      score: tw.public_metrics?.like_count,
      comments: tw.public_metrics?.reply_count,
      created_at: tw.created_at,
    };
  });
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
    reddit: () => reddit(query, limit, range),
    hackernews: () => hackernews(query, limit, range),
    bluesky: () => bluesky(query, limit),
    lemmy: () => searx('lemmy', query, limit, range),
    mastodon: () => searx('mastodon', query, limit, range),
    youtube: () => searx('youtube', query, limit, range),
  };
  const defaults = Object.keys(all);
  all.x = () => xSearch(query, limit);
  const names = (opts.sources?.length ? opts.sources : defaults).filter((s) => all[s]);
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
