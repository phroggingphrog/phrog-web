// TS port of web_crawl, web_map, web_batch_start, web_crawl_status (engines/web_acquisition).
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { loadConfig } from '../config.js';
import { executeFetch, renderedLinks } from './fetch.js';

const MAX_URLS = Number(process.env.WEB_MCP_MAX_URLS || 10);
const MAX_MARKDOWN_CHARS = Number(process.env.WEB_MCP_MAX_MARKDOWN_CHARS || 50000);
const MAX_BATCH_URLS = 500;
const MAX_JOBS = 100;
const MAX_JOB_RESULTS = 500;
const MAX_CONCURRENT_JOBS = 3;
const JOB_TTL_MS = 60 * 60 * 1000;
const UA = 'self-hosted-web-mcp';

type Args = Record<string, any>;
const pick = (a: Args, snake: string, camel: string, def: any) => a[snake] ?? a[camel] ?? def;

function allowPrivate(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.ALLOW_PRIVATE_URLS || '0').toLowerCase());
}

function isPrivateIp(ip: string): boolean {
  ip = ip.split('%')[0].toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && ip.startsWith('192.0.0.')) || (a === 198 && (b === 18 || b === 19));
  }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
}

async function validatePublicUrl(value: string): Promise<string> {
  if (typeof value !== 'string') throw new Error('each URL must be a string');
  const url = value.trim();
  let p: URL;
  try { p = new URL(url); } catch { throw new Error(`only absolute http(s) URLs are allowed: ${JSON.stringify(value)}`); }
  if (!['http:', 'https:'].includes(p.protocol) || !p.hostname) throw new Error(`only absolute http(s) URLs are allowed: ${JSON.stringify(value)}`);
  if (p.username || p.password) throw new Error('URLs containing username/password credentials are not allowed');
  if (url.length > 4096) throw new Error('URL exceeds 4096 characters');
  if (allowPrivate()) return url;
  const host = p.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address); }
  catch { throw new Error(`could not resolve URL host '${host}'`); }
  if (addrs.some(isPrivateIp)) throw new Error(`private or non-public URL host is blocked: ${host}`);
  return url;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function crawlOne(url: string, maxChars: number, mode: string, extra: Args = {}): Promise<Args> {
  const provider = mode === 'plain' ? 'plain' : mode === 'browser' ? 'crawl4ai' : undefined;
  try {
    const r = await executeFetch(url, { provider, maxChars: MAX_MARKDOWN_CHARS, ...extra });
    const content = r.markdown || '';
    const returned = content.slice(0, maxChars);
    return {
      url: r.url, requested_url: url, success: true, blocked: false, status_code: r.statusCode ?? 200,
      title: r.title, description: '', error: null, fetched_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'),
      redirected_url: null, egress: 'direct', fetcher: r.provider_used === 'plain' ? 'plain:ts' : r.provider_used,
      markdown: returned, truncated: content.length > maxChars, total_chars: content.length,
      sha256: sha(returned), full_sha256: sha(content),
    };
  } catch (err) {
    return { requested_url: url, url, success: false, error: err instanceof Error ? err.message : String(err), fetcher: mode };
  }
}

export async function webCrawl(args: Args): Promise<Args> {
  const urls = args.urls;
  let mode: string = args.mode ?? 'auto';
  if (args.actions || args.stealth) mode = 'browser';
  if (!['auto', 'plain', 'browser'].includes(mode)) throw new Error('mode must be auto, plain, or browser');
  const maxChars = Math.max(500, Math.min(Number(pick(args, 'max_chars', 'maxChars', 12000)), MAX_MARKDOWN_CHARS));
  if (!Array.isArray(urls) || !urls.length) throw new Error('urls must be a non-empty list');
  if (urls.length > MAX_URLS) throw new Error(`at most ${MAX_URLS} URLs may be crawled per call`);
  const clean: string[] = [];
  for (const u of urls) { const c = await validatePublicUrl(u); if (!clean.includes(c)) clean.push(c); }
  const results = await Promise.all(clean.map((u) => crawlOne(u, maxChars, mode, { actions: args.actions, stealth: args.stealth })));
  return { success: results.some((r) => r.success), results, count: results.length, primary_error: null };
}

// ---- map ----

async function httpGet(url: string, timeoutMs = 20000): Promise<{ final: string; status: number; body: string }> {
  await validatePublicUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA }, redirect: 'follow' });
  return { final: res.url || url, status: res.status, body: await res.text() };
}

function linksOf(base: string, html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try {
      const u = new URL((m[1] ?? m[2]).trim(), base);
      u.hash = '';
      if (['http:', 'https:'].includes(u.protocol)) out.push(u.toString());
    } catch { /* skip */ }
  }
  return out;
}

function sameSite(u: string, root: string, subs: boolean): boolean {
  try {
    const a = new URL(u).hostname, b = new URL(root).hostname;
    return a === b || (subs && a.endsWith('.' + b));
  } catch { return false; }
}

async function sitemapUrls(sm: string, limit: number, depth = 0): Promise<string[]> {
  let body: string;
  try { const r = await httpGet(sm); if (r.status !== 200) return []; body = r.body; } catch { return []; }
  const locs = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex/i.test(body) && depth < 2) {
    const found: string[] = [];
    for (const child of locs.slice(0, 5)) {
      found.push(...(await sitemapUrls(child, limit - found.length, depth + 1)));
      if (found.length >= limit) break;
    }
    return found;
  }
  return locs.slice(0, limit);
}

export async function webMap(args: Args): Promise<Args> {
  const url = await validatePublicUrl(args.url);
  const limit = Math.max(1, Math.min(Number(args.limit ?? 200), 5000));
  const search: string | null = args.search ?? null;
  const subs = Boolean(pick(args, 'include_subdomains', 'includeSubdomains', false));
  const p = new URL(url);
  let sitemaps: string[] = [];
  try {
    const r = await httpGet(`${p.protocol}//${p.host}/robots.txt`, 10000);
    if (r.status === 200) sitemaps = [...r.body.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  } catch { /* none */ }
  const candidates = sitemaps.length ? sitemaps : [`${p.protocol}//${p.host}/sitemap.xml`];
  let urls: string[] = [];
  let source = 'sitemap';
  for (const sm of candidates.slice(0, 3)) urls.push(...(await sitemapUrls(sm, limit)));
  if (!urls.length) {
    source = 'links';
    try {
      const r = await httpGet(url);
      urls = [r.final, ...linksOf(r.final, r.body)];
      if (urls.filter((u) => sameSite(u, url, subs)).length < 4) urls.push(...(await renderedLinks(r.final)));
    } catch (err) {
      return { url, source: 'none', count: 0, urls: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (seen.has(u) || !sameSite(u, url, subs)) continue;
    if (search && !u.toLowerCase().includes(search.toLowerCase())) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return { url, source, count: out.length, urls: out };
}

// ---- background jobs ----

interface Job {
  id: string; kind: 'batch' | 'crawl'; status: 'queued' | 'running' | 'completed' | 'failed';
  completed: number; total: number | null; stopped?: string | null; skipped?: Args[]; created: string; updated: string;
  error: string | null; results: Args[];
}
const jobs = new Map<string, Job>();
const queue: Array<() => Promise<void>> = [];
let active = 0;

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.status === 'completed' || j.status === 'failed') && now - Date.parse(j.updated) > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].find((j) => j.status === 'completed' || j.status === 'failed');
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}

function pump() {
  while (active < MAX_CONCURRENT_JOBS && queue.length) {
    const run = queue.shift()!;
    active++;
    run().finally(() => { active--; pump(); });
  }
}

export async function webBatchStart(args: Args): Promise<Args> {
  const urls = args.urls;
  if (!Array.isArray(urls)) throw new Error('urls must be a list');
  for (const u of urls) if (typeof u !== 'string' || !u.trim()) throw new Error('each URL must be a non-empty string');
  const maxChars = Number(pick(args, 'max_chars', 'maxChars', 8000));
  const mode = args.mode ?? 'auto';
  const list: string[] = urls.slice(0, MAX_BATCH_URLS);
  prune();
  const now = () => new Date().toISOString();
  const job: Job = { id: randomUUID(), kind: 'batch', status: 'queued', completed: 0, total: list.length, created: now(), updated: now(), error: null, results: [] };
  jobs.set(job.id, job);
  queue.push(async () => {
    job.status = 'running'; job.updated = now();
    try {
      for (let i = 0; i < list.length; i += 5) {
        const r = await webCrawl({ urls: list.slice(i, i + 5), max_chars: maxChars, mode });
        job.results.push(...r.results);
        if (job.results.length > MAX_JOB_RESULTS) job.results.length = MAX_JOB_RESULTS;
        job.completed = Math.min(i + 5, list.length); job.updated = now();
      }
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = `${err instanceof Error ? err.name : 'Error'}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
    }
    job.updated = now();
  });
  pump();
  return { job_id: job.id, status: job.status, runs_in: 'this process (ends with the session)' };
}

export function webCrawlStatus(jobId: string, includeResults = false, offset = 0, limit = 10): Args {
  const job = jobs.get(jobId);
  if (!job) return { job_id: jobId, status: 'unknown', error: 'no such job' };
  const out: Args = { job_id: job.id, kind: job.kind, status: job.status, completed: job.completed, total: job.total, error: job.error, count: job.results.length, stopped: job.stopped ?? (job.status === 'completed' ? 'done' : null) };
  if (includeResults) {
    out.offset = offset;
    out.results = job.results.slice(offset, offset + Math.max(1, Math.min(limit, 50)));
  }
  return out;
}

// ---- site crawl job (port of sitecrawl.crawl_site) ----

async function robotsRules(url: string): Promise<string[]> {
  const p = new URL(url);
  try {
    const r = await httpGet(`${p.protocol}//${p.host}/robots.txt`, 10000);
    if (r.status !== 200) return [];
    const rules: string[] = [];
    let applies = false;
    for (const raw of r.body.split(/\r?\n/)) {
      const line = raw.split('#')[0].trim();
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k === 'user-agent') applies = m[2].trim() === '*';
      else if (k === 'disallow' && applies && m[2].trim()) rules.push(m[2].trim());
    }
    return rules;
  } catch { return []; }
}

export async function webCrawlStart(args: Args): Promise<Args> {
  const start = await validatePublicUrl(args.url ?? args.start);
  const maxPages = Math.max(1, Math.min(Number(pick(args, 'max_pages', 'maxPages', 20)), 200));
  const maxDepth = Math.max(0, Math.min(Number(pick(args, 'max_depth', 'maxDepth', 2)), 6));
  const inc = (args.include ?? []).map((x: string) => new RegExp(x));
  const exc = (args.exclude ?? []).map((x: string) => new RegExp(x));
  const subs = Boolean(pick(args, 'include_subdomains', 'includeSubdomains', false));
  const respect = Boolean(pick(args, 'respect_robots', 'respectRobots', true));
  const maxChars = Math.max(500, Math.min(Number(pick(args, 'max_chars', 'maxChars', 8000)), MAX_MARKDOWN_CHARS));
  const mode = args.mode ?? 'auto';
  if (!['auto', 'plain', 'browser'].includes(mode)) throw new Error('mode must be auto, plain, or browser');
  const stealth = Boolean(args.stealth);
  prune();
  const now = () => new Date().toISOString();
  const job: Job = { id: randomUUID(), kind: 'crawl', status: 'queued', completed: 0, total: null, created: now(), updated: now(), error: null, results: [], skipped: [], stopped: null };
  jobs.set(job.id, job);
  queue.push(async () => {
    job.status = 'running'; job.updated = now();
    try {
      const rules = respect ? await robotsRules(start) : [];
      const deadline = Date.now() + 300_000;
      const q: Array<[string, number]> = [[start, 0]];
      const norm = (u: string) => u.replace(/\/$/, '');
      const seen = new Set([norm(start)]);
      while (q.length && job.results.length < maxPages && Date.now() < deadline) {
        const [url, depth] = q.shift()!;
        if (rules.some((r) => new URL(url).pathname.startsWith(r))) { job.skipped!.push({ url, reason: 'robots.txt' }); continue; }
        let links: string[] = [];
        try {
          const r = await httpGet(url);
          if (/html/i.test(r.body.slice(0, 2000)) || r.body.includes('<a ')) links = linksOf(r.final, r.body);
          if (links.filter((l) => sameSite(l, start, subs)).length < 3 && mode !== 'plain') links.push(...(await renderedLinks(r.final)));
        } catch { /* content fetch below reports the failure */ }
        const page = await crawlOne(url, maxChars, mode, { stealth });
        job.results.push({ ...page, depth });
        job.completed = job.results.length; job.total = job.results.length + q.length; job.updated = now();
        if (depth < maxDepth) {
          for (const link of links) {
            if (seen.has(norm(link)) || !sameSite(link, start, subs)) continue;
            if ((inc.length && !inc.some((r: RegExp) => r.test(link))) || exc.some((r: RegExp) => r.test(link))) continue;
            seen.add(norm(link)); q.push([link, depth + 1]);
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      job.stopped = job.results.length >= maxPages ? 'max_pages' : q.length ? 'budget' : 'done';
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = `${err instanceof Error ? err.name : 'Error'}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
    }
    job.updated = now();
  });
  pump();
  return { job_id: job.id, status: job.status, runs_in: 'this process (ends with the session)' };
}
