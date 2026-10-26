import { loadConfig } from '../config.js';
import { executeSearch } from './search.js';

export type MediaType = 'book' | 'film' | 'music';

export interface MediaRating {
  source: string;
  score: number;
  scale: number;
  count?: number;
}

export interface MediaItem {
  title: string;
  year?: number;
  creators?: string[];
  url: string;
  source: string;
  metadata?: Record<string, unknown>;
  ratings?: MediaRating[];
  image?: string;
}

export interface MediaResponse {
  query: string;
  type: MediaType;
  results: MediaItem[];
  sources_used: string[];
  sources_failed: { source: string; error: string }[];
}

const TIMEOUT_MS = 8000;
const UA = 'phrog-web/0.1 ( local )';

const env = (k: string): string | undefined => globalThis.process?.env[k] || undefined;

async function getJson<T>(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return await res.json() as T;
}

async function searxng(query: string, engines: string[], limit: number): Promise<Array<{ title?: string; url?: string; content?: string; engine?: string }>> {
  const base = loadConfig().search.providers.searxng?.url || 'http://127.0.0.1:8888';
  const url = new URL('/search', base);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('engines', engines.join(','));
  const data = await getJson<{ results?: Array<{ title?: string; url?: string; content?: string; engine?: string }> }>(url.toString());
  return (data.results || []).slice(0, limit);
}

function yearOf(s?: string): number | undefined {
  const m = s?.match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : undefined;
}

// Books
async function openLibrary(query: string, limit: number): Promise<MediaItem[]> {
  const url = new URL('https://openlibrary.org/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'key,title,first_publish_year,author_name,isbn,ratings_average,ratings_count');
  const data = await getJson<{ docs?: Array<{ key: string; title: string; first_publish_year?: number; author_name?: string[]; isbn?: string[]; ratings_average?: number; ratings_count?: number }> }>(url.toString());
  return (data.docs || []).map(d => ({
    title: d.title,
    year: d.first_publish_year,
    creators: d.author_name,
    url: `https://openlibrary.org${d.key}`,
    source: 'openlibrary',
    metadata: { isbn: d.isbn?.slice(0, 3) },
    ratings: d.ratings_average ? [{ source: 'openlibrary', score: d.ratings_average, scale: 5, count: d.ratings_count }] : undefined,
  }));
}

async function searxngBooks(query: string, limit: number): Promise<MediaItem[]> {
  const rs = await searxng(query, ['openlibrary'], limit);
  return rs.map(r => ({ title: r.title || '', url: r.url || '', source: 'searxng:openlibrary', metadata: { snippet: r.content } }));
}

async function hardcover(query: string, limit: number): Promise<MediaItem[]> {
  const key = env('HARDCOVER_API_KEY');
  if (!key) throw new Error('no key');
  const gql = 'query($q:String!,$n:Int){search(query:$q,query_type:"Book",per_page:$n){results}}';
  const data = await getJson<{ data?: { search?: { results?: { hits?: Array<{ document: Record<string, any> }> } } } }>(
    'https://api.hardcover.app/v1/graphql',
    { Authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`, 'Content-Type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ query: gql, variables: { q: query, n: limit } }) },
  );
  const hits = data.data?.search?.results?.hits || [];
  return hits.map(h => ({
    title: h.document.title,
    year: h.document.release_year,
    creators: h.document.author_names,
    url: `https://hardcover.app/books/${h.document.slug}`,
    source: 'hardcover',
    ratings: h.document.rating ? [{ source: 'hardcover', score: h.document.rating, scale: 5, count: h.document.ratings_count }] : undefined,
  }));
}

// Film
function parseSensCritique(content?: string): MediaRating[] | undefined {
  const m = content?.match(/Rating:\s*([\d.,]+)\s*\/\s*(\d+)/i);
  if (!m) return undefined;
  return [{ source: 'senscritique', score: Number(m[1].replace(',', '.')), scale: Number(m[2]) }];
}

async function searxngFilm(query: string, limit: number): Promise<MediaItem[]> {
  const rs = await searxng(query, ['imdb', 'rottentomatoes', 'senscritique'], limit * 2);
  const bad = ['/livre/', '/bd/', '/album/', '/jeuvideo/'];
  return rs.filter(r => !bad.some(b => (r.url || '').includes(b))).slice(0, limit * 2).map(r => ({
    title: r.title || '',
    year: yearOf(r.title) ?? yearOf(r.content),
    url: r.url || '',
    source: `searxng:${r.engine || 'film'}`,
    metadata: { snippet: r.content },
    ratings: parseSensCritique(r.content),
  }));
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const unhtml = (x: string) => x.replace(/<[^>]+>/g, ' ').replace(/&#0?34;|&quot;/g, '"').replace(/&#0?39;|&#039;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Letterboxd: its search and review pages are bot-blocked, so films are found via web search and read from the film page
 *  (JSON-LD rating + the popular reviews embedded in it). */
async function letterboxd(query: string, limit: number): Promise<MediaItem[]> {
  const web = await executeSearch(`letterboxd ${query}`, { limit: 20 });
  const slugs = [...new Set((web.results as any[]).map((r) => String(r.url).match(/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/?$/)?.[1]).filter(Boolean))] as string[];
  const pages = await Promise.all(slugs.slice(0, Math.min(limit, 3)).map(async (slug) => {
    const url = `https://letterboxd.com/film/${slug}/`;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();
    const ld = (() => { try { return JSON.parse(html.match(/<script type="application\/ld\+json">\s*(?:\/\*[\s\S]*?\*\/)?\s*([\s\S]*?)\s*(?:\/\*[\s\S]*?\*\/)?\s*<\/script>/)?.[1] || '{}'); } catch { return {}; } })();
    const agg = ld.aggregateRating;
    const reviews = html.split('class="production-viewing -viewing').slice(1, 6).map((b) => ({
      by: b.match(/class="displayname">([^<]+)</)?.[1],
      text: unhtml(b.match(/js-review-body[^>]*>([\s\S]*?)<\/div>/)?.[1] || '').slice(0, 400),
      likes: Number(b.match(/data-count="(\d+)"/)?.[1]) || undefined,
      spoiler: b.includes('This review may contain spoilers') || undefined,
    })).filter((r) => r.text);
    const title = unhtml(html.match(/og:title" content="([^"]*)"/)?.[1] || ld.name || slug);
    return {
      title,
      year: yearOf(title),
      creators: (ld.director || []).map((d: any) => d.name),
      url,
      image: html.match(/og:image" content="([^"]*)"/)?.[1],
      source: 'letterboxd',
      metadata: { genres: ld.genre, popular_reviews: reviews },
      ratings: agg ? [{ source: 'letterboxd', score: agg.ratingValue, scale: 5, count: agg.ratingCount }] : undefined,
    } as MediaItem;
  }));
  return pages.filter(Boolean) as MediaItem[];
}

/** Pages of one review site found through web search (the sites' own search pages are bot-blocked or JS-only). */
async function sitePages(query: string, site: string, re: RegExp, max: number): Promise<{ url: string; html: string }[]> {
  const web = await executeSearch(`${site} ${query}`, { limit: 20 });
  const seen = new Set<string>();
  const urls = ((web.results as any[]).map((r) => String(r.url).match(re)?.[0]).filter(Boolean) as string[])
    .filter((u) => { const k = u.match(/\/show\/(\d+)/)?.[1] || u.replace(/\/$/, ''); return !seen.has(k) && !!seen.add(k); });
  const pages = await Promise.all(urls.slice(0, max).map(async (url) => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? { url, html: await res.text() } : null;
    } catch { return null; }
  }));
  return pages.filter(Boolean) as { url: string; html: string }[];
}

const ogImage = (html: string) => html.match(/og:image" content="([^"]*)"/)?.[1];
const ogTitle = (html: string) => unhtml(html.match(/og:title" content="([^"]*)"/)?.[1] || '');
const jsonField = (html: string, re: RegExp) => { const m = html.match(re); if (!m) return undefined; try { return JSON.parse(m[1]); } catch { return undefined; } };

async function rottenTomatoes(query: string, limit: number): Promise<MediaItem[]> {
  const pages = await sitePages(query, 'rotten tomatoes', /^https:\/\/www\.rottentomatoes\.com\/(m|tv)\/[a-z0-9_]+/, Math.min(limit, 3));
  return pages.map(({ url, html }) => {
    const critics = jsonField(html, /"criticsScore":(\{[^}]*\})/);
    const audience = jsonField(html, /"audienceScore":(\{[^}]*\})/);
    const block = unhtml(html.slice(html.indexOf('id="critics-consensus"'), html.indexOf('id="critics-consensus"') + 3000));
    const consensus = html.includes('id="critics-consensus"') ? block.match(/Critics Consensus\s*(.*?)\s*Read Critics Reviews/)?.[1] : undefined;
    const ratings: MediaRating[] = [];
    if (critics?.score) ratings.push({ source: 'rottentomatoes:tomatometer', score: Number(critics.score), scale: 100, count: Number(critics.ratingCount) || undefined });
    if (audience?.score) ratings.push({ source: 'rottentomatoes:audience', score: Number(audience.score), scale: 100, count: Number(audience.reviewCount) || undefined });
    const title = ogTitle(html).replace(/\s*\|\s*Rotten Tomatoes$/, '');
    return { title, year: yearOf(title), url, image: ogImage(html), source: 'rottentomatoes', metadata: { critics_consensus: consensus || undefined, critics_average: critics?.averageRating, certified_fresh: critics?.certified }, ratings: ratings.length ? ratings : undefined };
  });
}

async function pitchfork(query: string, limit: number): Promise<MediaItem[]> {
  const pages = await sitePages(query, 'pitchfork review', /^https:\/\/pitchfork\.com\/reviews\/(albums|tracks)\/[a-z0-9-]+\/?/, Math.min(limit, 3));
  return pages.map(({ url, html }) => {
    const score = Number(html.match(/"rating":(\d+(?:\.\d)?)/)?.[1]);
    const deks = [...html.matchAll(/"dangerousDek":"((?:[^"\\]|\\.)*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }).filter((d) => !/your |saved|review is/i.test(d));
    const genres = [...new Set([...html.matchAll(/"genres":\[\{"node":\{"name":"([^"]+)"/g)].map((m) => m[1].replace(/\\u002F/g, '/')))];
    const title = ogTitle(html).replace(/\s*(Album|Track) Review\s*\|\s*Pitchfork$/, '');
    return {
      title, url, image: ogImage(html), source: 'pitchfork',
      metadata: { summary: unhtml(deks.sort((a, b) => b.length - a.length)[0] || '') || undefined, best_new_music: /isBestNewMusic":true/.test(html) || undefined, genres, author: unhtml(html.match(/"author":\{[^}]*"name":"([^"]+)"/)?.[1] || '') || undefined },
      ratings: Number.isFinite(score) ? [{ source: 'pitchfork', score, scale: 10 }] : undefined,
    } as MediaItem;
  });
}

async function goodreads(query: string, limit: number): Promise<MediaItem[]> {
  const pages = await sitePages(query, 'goodreads', /^https:\/\/www\.goodreads\.com\/book\/show\/[0-9]+[a-zA-Z0-9._-]*/, Math.min(limit, 3));
  const titles = new Set<string>();
  return pages.filter(({ html }) => { const t = ogTitle(html); return !titles.has(t) && !!titles.add(t); }).map(({ url, html }) => {
    const agg = jsonField(html, /"aggregateRating":(\{[^}]*\})/);
    const reviews = html.split('class="ReviewCard"').slice(1, 6).map((b) => ({
      by: b.match(/aria-label="Review by ([^"]+)"/)?.[1] || b.match(/data-testid="name"[^>]*><a[^>]*>([^<]+)</)?.[1],
      stars: Number(b.match(/aria-label="Rating (\d) out of 5"/)?.[1]) || undefined,
      text: unhtml(b.match(/ReviewText__content"[^>]*>([\s\S]*?)<\/section>/)?.[1] || '').slice(0, 400),
      likes: Number(b.match(/([\d,]+) likes/)?.[1]?.replace(/,/g, '')) || undefined,
    })).filter((r) => r.text);
    const title = ogTitle(html);
    const author = unhtml(html.match(/class="ContributorLink__name"[^>]*>([^<]+)</)?.[1] || '');
    return {
      title, url, image: ogImage(html), source: 'goodreads', creators: author ? [author] : undefined,
      metadata: { popular_reviews: reviews },
      ratings: agg ? [{ source: 'goodreads', score: agg.ratingValue, scale: 5, count: agg.ratingCount }] : undefined,
    } as MediaItem;
  });
}

/** Community discussion from one subreddit through Reddit's public search feed. */
async function subreddit(sub: string, query: string, limit: number): Promise<MediaItem[]> {
  const url = `https://www.reddit.com/r/${sub}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=on&sort=relevance&limit=${limit}`;
  let res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2500));
    res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return xml.split('<entry>').slice(1, limit + 1).map((e) => ({
    title: unhtml(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
    url: e.match(/<link href="([^"]+)"/)?.[1] || '',
    source: `reddit:r/${sub}`,
    metadata: { posted: e.match(/<published>([^<]+)</)?.[1]?.slice(0, 10) },
  })).filter((i) => i.url);
}

async function tmdb(query: string, limit: number): Promise<MediaItem[]> {
  const key = env('TMDB_API_KEY');
  if (!key) throw new Error('no key');
  const url = new URL('https://api.themoviedb.org/3/search/multi');
  url.searchParams.set('query', query);
  const headers: Record<string, string> = {};
  if (key.length > 40) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  const data = await getJson<{ results?: Array<{ id: number; media_type: string; title?: string; name?: string; release_date?: string; first_air_date?: string; vote_average?: number; vote_count?: number; overview?: string }> }>(url.toString(), headers);
  return (data.results || []).filter(r => r.media_type !== 'person').slice(0, limit).map(r => ({
    title: r.title || r.name || '',
    year: yearOf(r.release_date || r.first_air_date),
    url: `https://www.themoviedb.org/${r.media_type}/${r.id}`,
    source: 'tmdb',
    metadata: { media_type: r.media_type, overview: r.overview },
    ratings: r.vote_average ? [{ source: 'tmdb', score: r.vote_average, scale: 10, count: r.vote_count }] : undefined,
  }));
}

async function omdb(query: string): Promise<MediaItem[]> {
  const key = env('OMDB_API_KEY');
  if (!key) throw new Error('no key');
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('t', query);
  url.searchParams.set('apikey', key);
  const d = await getJson<{ Response?: string; Title?: string; Year?: string; imdbID?: string; Director?: string; imdbRating?: string; imdbVotes?: string; Ratings?: Array<{ Source: string; Value: string }> }>(url.toString());
  if (d.Response === 'False' || !d.Title) return [];
  const ratings: MediaRating[] = [];
  for (const r of d.Ratings || []) {
    const [a, b] = r.Value.split('/');
    if (b) ratings.push({ source: r.Source, score: Number(a), scale: Number(b) });
    else if (r.Value.endsWith('%')) ratings.push({ source: r.Source, score: parseFloat(r.Value), scale: 100 });
  }
  return [{
    title: d.Title,
    year: yearOf(d.Year),
    creators: d.Director && d.Director !== 'N/A' ? d.Director.split(', ') : undefined,
    url: `https://www.imdb.com/title/${d.imdbID}/`,
    source: 'omdb',
    ratings,
  }];
}

// Music
async function musicBrainz(query: string, limit: number): Promise<MediaItem[]> {
  const url = new URL('https://musicbrainz.org/ws/2/release-group');
  url.searchParams.set('query', query);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', String(limit));
  const data = await getJson<{ 'release-groups'?: Array<{ id: string; title: string; 'first-release-date'?: string; 'primary-type'?: string; 'artist-credit'?: Array<{ name: string }>; rating?: { value: number | null; 'votes-count'?: number } }> }>(url.toString());
  return (data['release-groups'] || []).map(g => ({
    title: g.title,
    year: yearOf(g['first-release-date']),
    creators: g['artist-credit']?.map(a => a.name),
    url: `https://musicbrainz.org/release-group/${g.id}`,
    source: 'musicbrainz',
    metadata: { type: g['primary-type'] },
    ratings: g.rating?.value ? [{ source: 'musicbrainz', score: g.rating.value, scale: 5, count: g.rating['votes-count'] }] : undefined,
  }));
}

async function searxngMusic(query: string, limit: number): Promise<MediaItem[]> {
  const rs = await searxng(query, ['bandcamp', 'genius'], limit);
  return rs.map(r => ({ title: r.title || '', url: r.url || '', source: `searxng:${r.engine || 'music'}`, metadata: { snippet: r.content } }));
}

async function discogs(query: string, limit: number): Promise<MediaItem[]> {
  const token = env('DISCOGS_TOKEN');
  if (!token) throw new Error('no key');
  const url = new URL('https://api.discogs.com/database/search');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', String(limit));
  const data = await getJson<{ results?: Array<{ title: string; year?: string; uri: string; type?: string; genre?: string[]; community?: { have?: number; want?: number } }> }>(url.toString(), { Authorization: `Discogs token=${token}` });
  return (data.results || []).map(r => ({
    title: r.title,
    year: yearOf(r.year),
    url: `https://www.discogs.com${r.uri}`,
    source: 'discogs',
    metadata: { type: r.type, genre: r.genre, community: r.community },
  }));
}

export async function searchMedia(query: string, type: MediaType, opts: { limit?: number } = {}): Promise<MediaResponse> {
  const limit = opts.limit || 10;
  const jobs: Array<[string, Promise<MediaItem[]>]> = [];
  const add = (name: string, fn: () => Promise<MediaItem[]>) => jobs.push([name, fn()]);

  if (type === 'book') {
    add('openlibrary', () => openLibrary(query, limit));
    add('searxng:openlibrary', () => searxngBooks(query, limit));
    add('hardcover', () => hardcover(query, limit));
    add('goodreads', () => goodreads(query, limit));
    add('reddit:r/books', () => subreddit('books', query, 3));
  } else if (type === 'film') {
    add('letterboxd', () => letterboxd(query, limit));
    add('rottentomatoes', () => rottenTomatoes(query, limit));
    add('reddit:r/movies', () => subreddit('movies', query, 3));
    add('searxng:film', () => searxngFilm(query, limit));
    add('tmdb', () => tmdb(query, limit));
    add('omdb', () => omdb(query));
  } else {
    add('musicbrainz', () => musicBrainz(query, limit));
    add('searxng:music', () => searxngMusic(query, limit));
    add('discogs', () => discogs(query, limit));
    add('pitchfork', () => pitchfork(query, limit));
    add('reddit:r/indieheads', () => subreddit('indieheads', query, 3));
  }

  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const results: MediaItem[] = [];
  const sources_used: string[] = [];
  const sources_failed: { source: string; error: string }[] = [];
  settled.forEach((s, i) => {
    const name = jobs[i][0];
    if (s.status === 'fulfilled') {
      sources_used.push(name);
      results.push(...s.value);
    } else {
      sources_failed.push({ source: name, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    }
  });

  // Rated items first, keeping source order otherwise.
  results.sort((a, b) => (b.ratings?.length ? 1 : 0) - (a.ratings?.length ? 1 : 0));
  return { query, type, results: results.slice(0, limit), sources_used, sources_failed };
}
