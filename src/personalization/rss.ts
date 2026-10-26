import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { rssConfig } from '../config.js';

/** Result of reading one feed, already in the item shape the feed store uses. */
export interface RssResult {
  status: 'ok' | 'end' | 'auth_required' | 'unsupported' | 'failed';
  error: string | null;
  fetched_at: string;
  items: RssItem[];
}
export interface RssItem {
  native_id: string;
  url: string | null;
  caption: string | null;
  media_type: 'article' | 'video' | 'photo';
  author: { handle: null; name: string | null; followed: null } | null;
  hashtags: string[];
  mentions: string[];
  media: { type: string; url: string; width: null; height: null; alt_text: null }[];
  taken_at: number | null;
  posted_precision: 'exact' | 'day' | 'unknown';
}

export type FetchFn = typeof fetch;
export type ResolveFn = (host: string) => Promise<string[]>;
let fetchImpl: FetchFn | null = null;
let resolveImpl: ResolveFn | null = null;
/** Test hooks. */
export function setRssFetch(f: FetchFn | null, r?: ResolveFn | null) { fetchImpl = f; resolveImpl = r ?? null; }

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 100;
const MAX_REDIRECTS = 3;
const ROUTE_RE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && ip.startsWith('192.0.0.')) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`); }
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true;
}

async function assertPublicHost(host: string) {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h)) { if (isPrivateIp(h)) throw new Error('blocked: private address'); return; }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('blocked: private host name');
  const addrs = resolveImpl ? await resolveImpl(h) : (await lookup(h, { all: true })).map((a) => a.address);
  if (addrs.length === 0) throw new Error('host did not resolve');
  if (addrs.some(isPrivateIp)) throw new Error('blocked: host resolves to a private address');
}

/** Valid source: an RSSHub route (starts with '/') or an absolute http(s) URL. Returns the normalised handle or null. */
export function normalizeSource(s: unknown): string | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 500) return null;
  if (s.startsWith('/')) return ROUTE_RE.test(s) && !s.split('?')[0].split('/').includes('..') ? s : null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

async function readBody(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('feed too large');
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > MAX_BYTES) throw new Error('feed too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchText(source: string): Promise<{ status: number; body: string }> {
  const cfg = rssConfig();
  const f = fetchImpl ?? fetch;
  const headers = { accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5', 'user-agent': 'phrog-web-feed/1.0' };
  let url: string;
  let viaRsshub = false;
  if (source.startsWith('/')) {
    if (!cfg.rsshubUrl) throw new Error('PHROG_RSSHUB_URL is not configured');
    url = cfg.rsshubUrl.replace(/\/+$/, '') + source;
    viaRsshub = true;
  } else url = source;
  const rsshubOrigin = cfg.rsshubUrl ? new URL(cfg.rsshubUrl).origin : null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked: only http/https');
    if (u.username || u.password) throw new Error('blocked: credentials in URL');
    if (u.origin !== rsshubOrigin) await assertPublicHost(u.hostname);
    const res = await f(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (viaRsshub) throw new Error('unexpected redirect from RSSHub');
      url = new URL(res.headers.get('location')!, url).href;
      continue;
    }
    return { status: res.status, body: await readBody(res) };
  }
  throw new Error('too many redirects');
}

// ---------- parsing ----------

interface Node { name: string; attrs: Record<string, string>; kids: Node[]; text: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  }
  return ENT[e.toLowerCase()] ?? m;
});

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/gi;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

export function parseXml(xml: string): Node {
  const root: Node = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3]) {
      const name = m[3].toLowerCase();
      if (m[2]) {
        const i = stack.map((n) => n.name).lastIndexOf(name);
        if (i > 0) stack.length = i;
      } else {
        const attrs: Record<string, string> = {};
        for (const a of m[4].matchAll(ATTR)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? '');
        const node: Node = { name, attrs, kids: [], text: '' };
        top.kids.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}

const find = (n: Node, name: string): Node | undefined => n.kids.find((k) => k.name === name);
const all = (n: Node, name: string) => n.kids.filter((k) => k.name === name);
const txt = (n: Node | undefined) => (n ? n.text.trim() : '') || null;
function descendants(n: Node, name: string, out: Node[] = []): Node[] {
  for (const k of n.kids) { if (k.name === name) out.push(k); descendants(k, name, out); }
  return out;
}

const htmlToText = (h: string) => decode(h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, ' '))
  .replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const absUrl = (u: string | null | undefined, base: string | null): string | null => {
  if (!u) return null;
  try { const r = new URL(u.trim(), base ?? undefined); return r.protocol === 'http:' || r.protocol === 'https:' ? r.href : null; } catch { return null; }
};

function parseDate(s: string | null | undefined): { at: number | null; precision: 'exact' | 'day' | 'unknown' } {
  if (!s) return { at: null, precision: 'unknown' };
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t)) return { at: null, precision: 'unknown' };
  return { at: Math.floor(t / 1000), precision: /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? 'day' : 'exact' };
}

interface Raw {
  guid: string | null; link: string | null; title: string | null; html: string | null; text: string | null;
  date: string | null; author: string | null; categories: string[];
  media: { kind: 'image' | 'video' | 'audio'; url: string; enclosure: boolean }[];
}

const kindOf = (type: string | undefined, medium: string | undefined, url: string): 'image' | 'video' | 'audio' | null => {
  const t = (type || medium || '').toLowerCase();
  if (t.startsWith('video')) return 'video';
  if (t.startsWith('audio')) return 'audio';
  if (t.startsWith('image')) return 'image';
  if (!t) { if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url)) return 'image'; if (/\.(mp4|webm|m4v|mov)(\?|$)/i.test(url)) return 'video'; if (/\.(mp3|m4a|ogg|opus)(\?|$)/i.test(url)) return 'audio'; }
  return null;
};

function xmlMedia(n: Node): Raw['media'] {
  const out: Raw['media'] = [];
  for (const e of all(n, 'enclosure')) { const k = kindOf(e.attrs.type, undefined, e.attrs.url ?? ''); if (e.attrs.url && k) out.push({ kind: k, url: e.attrs.url, enclosure: true }); }
  for (const e of [...descendants(n, 'media:content'), ...descendants(n, 'media:thumbnail')]) {
    if (!e.attrs.url) continue;
    const k = e.name === 'media:thumbnail' ? 'image' : kindOf(e.attrs.type, e.attrs.medium, e.attrs.url);
    if (k) out.push({ kind: k, url: e.attrs.url, enclosure: e.name === 'media:content' });
  }
  for (const l of all(n, 'link')) if (l.attrs.rel === 'enclosure' && l.attrs.href) { const k = kindOf(l.attrs.type, undefined, l.attrs.href); if (k) out.push({ kind: k, url: l.attrs.href, enclosure: true }); }
  return out;
}

function rawFromXml(root: Node): { title: string | null; author: string | null; link: string | null; items: Raw[] } | null {
  const rss = find(root, 'rss') ?? find(root, 'rdf:rdf');
  const channel = rss ? (find(rss, 'channel') ?? rss) : null;
  if (channel) {
    return {
      title: txt(find(channel, 'title')), author: null, link: txt(find(channel, 'link')),
      items: all(rss!.name === 'rss' ? channel : rss!, 'item').map((i) => ({
        guid: txt(find(i, 'guid')), link: txt(find(i, 'link')), title: txt(find(i, 'title')),
        html: txt(find(i, 'content:encoded')) ?? txt(find(i, 'description')), text: null,
        date: txt(find(i, 'pubdate')) ?? txt(find(i, 'dc:date')),
        author: txt(find(i, 'dc:creator')) ?? txt(find(i, 'author')),
        categories: all(i, 'category').map((c) => c.text.trim()).filter(Boolean), media: xmlMedia(i),
      })),
    };
  }
  const feed = find(root, 'feed');
  if (!feed) return null;
  const linkOf = (n: Node) => { const ls = all(n, 'link'); return (ls.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? ls[0])?.attrs.href ?? null; };
  return {
    title: txt(find(feed, 'title')), author: txt(find(find(feed, 'author') ?? feed, 'name')) , link: linkOf(feed),
    items: all(feed, 'entry').map((e) => ({
      guid: txt(find(e, 'id')), link: linkOf(e), title: txt(find(e, 'title')),
      html: txt(find(e, 'content')) ?? txt(find(e, 'summary')) ?? txt(find(find(e, 'media:group') ?? e, 'media:description')), text: null,
      date: txt(find(e, 'published')) ?? txt(find(e, 'updated')),
      author: txt(find(find(e, 'author') ?? e, 'name')),
      categories: all(e, 'category').map((c) => c.attrs.term || c.text.trim()).filter(Boolean), media: xmlMedia(find(e, 'media:group') ? { ...e, kids: [...e.kids, ...find(e, 'media:group')!.kids] } : e),
    })),
  };
}

function rawFromJson(o: any): { title: string | null; author: string | null; link: string | null; items: Raw[] } | null {
  if (!o || typeof o !== 'object' || !Array.isArray(o.items)) return null;
  const s = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return {
    title: s(o.title), author: s(o.authors?.[0]?.name) ?? s(o.author?.name), link: s(o.home_page_url),
    items: o.items.filter((i: any) => i && typeof i === 'object').map((i: any): Raw => {
      const media: Raw['media'] = [];
      for (const a of Array.isArray(i.attachments) ? i.attachments : []) { const k = kindOf(a?.mime_type, undefined, a?.url ?? ''); if (s(a?.url) && k) media.push({ kind: k, url: a.url, enclosure: true }); }
      if (s(i.image)) media.push({ kind: 'image', url: i.image, enclosure: false });
      else if (s(i.banner_image)) media.push({ kind: 'image', url: i.banner_image, enclosure: false });
      return {
        guid: s(i.id), link: s(i.url) ?? s(i.external_url), title: s(i.title), html: s(i.content_html) ?? s(i.summary), text: s(i.content_text),
        date: s(i.date_published) ?? s(i.date_modified), author: s(i.authors?.[0]?.name) ?? s(i.author?.name),
        categories: (Array.isArray(i.tags) ? i.tags : []).filter((t: unknown) => typeof t === 'string'), media,
      };
    }),
  };
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|tiktok\.com|bilibili\.com)$/i;

export function parseFeed(body: string, source: string): { items: RssItem[] } | null {
  const trimmed = body.trimStart();
  let parsed: ReturnType<typeof rawFromXml>;
  if (trimmed.startsWith('{')) { try { parsed = rawFromJson(JSON.parse(trimmed)); } catch { return null; } }
  else parsed = rawFromXml(parseXml(body));
  if (!parsed) return null;
  const items: RssItem[] = [];
  const base = source.startsWith('/') ? null : source;
  for (const r of parsed.items.slice(0, MAX_ITEMS)) {
    const link = absUrl(r.link, parsed.link ?? base);
    const body = r.html ?? r.text;
    const summary = r.html ? htmlToText(r.html) : r.text ? r.text.trim() : '';
    const sum = summary.slice(0, 1500);
    const caption = (r.title && sum && sum !== r.title && !sum.startsWith(r.title) ? `${r.title}\n\n${sum}` : sum.startsWith(r.title ?? '\u0000') ? sum : r.title ?? (sum || null)) || null;
    const guid = r.guid;
    const guidUrl = absUrl(guid, null);
    const nativeId = guidUrl && /^https?:\/\//i.test(guid ?? '') ? guidUrl : link ?? (guid ? `${source}#${guid}` : null);
    if (!nativeId || (!caption && !link)) continue;

    const media = r.media.map((m) => ({ ...m, url: absUrl(m.url, link ?? base) })).filter((m): m is typeof m & { url: string } => !!m.url);
    if (!media.some((m) => m.kind === 'image') && body) {
      const img = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(body);
      const u = absUrl(img ? decode(img[1]) : null, link ?? base);
      if (u) media.push({ kind: 'image', url: u, enclosure: false });
    }
    let host = '';
    try { host = link ? new URL(link).hostname : ''; } catch { /* no host */ }
    const yt = /(^|\.)youtube\.com$/i.test(host) && link ? new URL(link).searchParams.get('v') : null;
    if (yt && /^[\w-]{6,20}$/.test(yt) && !media.some((m) => m.kind === 'image')) media.push({ kind: 'image', url: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, enclosure: false });
    const type: RssItem['media_type'] = media.some((m) => m.kind === 'video' && m.enclosure) || VIDEO_HOSTS.test(host) ? 'video'
      : media.some((m) => m.kind === 'image' && m.enclosure) && summary.length < 200 ? 'photo' : 'article';
    const d = parseDate(r.date);
    const name = r.author ?? parsed.author ?? parsed.title;
    items.push({
      native_id: nativeId, url: link, caption, media_type: type,
      author: name ? { handle: null, name: name.slice(0, 200), followed: null } : null,
      hashtags: r.categories.slice(0, 10).map((c) => c.slice(0, 60)), mentions: [],
      media: media.slice(0, 6).map((m) => ({ type: m.kind, url: m.url, width: null, height: null, alt_text: null })),
      taken_at: d.at, posted_precision: d.precision,
    });
  }
  return { items };
}

export async function readFeed(source: string): Promise<RssResult> {
  const fetched_at = new Date().toISOString();
  const fail = (status: RssResult['status'], error: string): RssResult => ({ status, error, fetched_at, items: [] });
  let res: { status: number; body: string };
  try { res = await fetchText(source); }
  catch (e) { return fail('failed', ((e as Error).name === 'TimeoutError' ? 'feed fetch timed out' : (e as Error).message).slice(0, 200)); }
  if (res.status === 401 || res.status === 403 || /ConfigNotFoundError|AuthenticationError|cookie.*(required|not configured)/i.test(res.body.slice(0, 4000)) && res.status >= 400) {
    return fail('auth_required', `source needs credentials (HTTP ${res.status})`);
  }
  if (res.status === 404) return fail('unsupported', 'feed or route not found (HTTP 404)');
  if (res.status < 200 || res.status >= 300) return fail('failed', `HTTP ${res.status}`);
  const parsed = parseFeed(res.body, source);
  if (!parsed) return fail('failed', 'response is not RSS, Atom or JSON Feed');
  return { status: parsed.items.length ? 'ok' : 'end', error: null, fetched_at, items: parsed.items };
}
