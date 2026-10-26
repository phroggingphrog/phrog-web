#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, personalConfig } from './config.js';

const USAGE = `phrog-web <command> [options]
  search <query> [--mode quick|academic|live] [--limit N]
  fetch <url...> [--format markdown|json]
  crawl <url> [--max-pages N] [--depth N]
  map <url>
  extract <url> --schema <file.json|inline json>
  social <query> [--sources a,b] [--limit N]
  media <query> --type book|film|music [--limit N]
  books <query> [--limit N]
  transcript <url> [--lang xx]
  agent <url> "<goal>" [--schema ...]
  feed instagram --account <name> [--limit N] [--cursor C]   (needs PHROG_PERSONAL_TOKEN)
Global: --url <base> (or PHROG_WEB_URL; default http://127.0.0.1:8890)
        --out <path>  write full result there (default ./phrog-web-out/<cmd>-<ts>.<ext>)
        --stdout      print full output     --json  print raw JSON`;

const { values: v, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' }, out: { type: 'string' }, stdout: { type: 'boolean' }, json: { type: 'boolean' },
    mode: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string' },
    'max-pages': { type: 'string' }, depth: { type: 'string' }, schema: { type: 'string' },
    sources: { type: 'string' }, account: { type: 'string' }, cursor: { type: 'string' }, type: { type: 'string' }, lang: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});

const base = (v.url || process.env.PHROG_WEB_URL || 'http://127.0.0.1:8890').replace(/\/$/, '');
const die = (msg: string): never => { console.error(msg); process.exit(1); };

async function call(method: 'GET' | 'POST', path: string, body?: unknown, params?: Record<string, string | undefined>, headers?: Record<string, string>): Promise<any> {
  const u = new URL(base + path);
  for (const [k, val] of Object.entries(params ?? {})) if (val !== undefined) u.searchParams.set(k, val);
  let res: Response;
  try {
    res = await fetch(u, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    return die(`Cannot reach gateway at ${base}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    if (res.status === 404 && path === '/api/agent') die('agent: /api/agent is not available on this gateway (404). It may not be deployed yet.');
    die(`HTTP ${res.status} from ${method} ${path}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function schemaArg(s: string): unknown {
  try { return JSON.parse(existsSync(s) ? readFileSync(s, 'utf8') : s); } catch { return die('--schema must be a JSON file path or inline JSON'); }
}

function items(d: any): any[] {
  if (Array.isArray(d)) return d;
  for (const k of ['results', 'pages', 'urls', 'links', 'items']) if (Array.isArray(d?.[k])) return d[k];
  return [];
}
const label = (r: any) => (typeof r === 'string' ? r : [r?.title, r?.url || r?.link].filter(Boolean).join(' - ') || JSON.stringify(r).slice(0, 100));

async function run(): Promise<{ data: any; ext: 'json' | 'md' }> {
  const [cmd, ...a] = pos;
  const need = (n: number, what: string) => { if (a.length < n) die(`${cmd}: missing ${what}\n\n${USAGE}`); };
  switch (cmd) {
    case 'search':
      need(1, '<query>');
      return { data: await call('GET', '/api/search', undefined, { q: a.join(' '), mode: v.mode, limit: v.limit }), ext: 'json' };
    case 'fetch': {
      need(1, '<url...>');
      const data = await call('POST', '/api/fetch', a.length === 1 ? { url: a[0] } : { urls: a });
      if (v.format !== 'json') {
        const md = items(data).map((r) => `# ${r.title || r.url || ''}\n${r.url ? r.url + '\n' : ''}\n${r.markdown ?? r.content ?? r.text ?? ''}`).join('\n\n---\n\n')
          || (typeof data?.markdown === 'string' ? data.markdown : typeof data?.content === 'string' ? data.content : '');
        if (md) return { data: md, ext: 'md' };
      }
      return { data, ext: 'json' };
    }
    case 'crawl': {
      need(1, '<url>');
      const start = await call('POST', '/api/crawl/start', { url: a[0], max_pages: v['max-pages'] ? Number(v['max-pages']) : undefined, max_depth: v.depth ? Number(v.depth) : undefined });
      const id = start.job_id; if (!id) return { data: start, ext: 'json' };
      const deadline = Date.now() + 330_000;
      let st: any;
      for (;;) {
        st = await call('GET', `/api/batch/${id}`);
        if (['completed', 'failed', 'cancelled', 'unknown'].includes(st.status) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const all: any[] = [];
      for (let off = 0; off < (st.count ?? 0); off += 50) {
        const p = await call('GET', `/api/batch/${id}`, undefined, { include_results: '1', offset: String(off), limit: '50' });
        all.push(...(p.results ?? []));
      }
      return { data: { ...st, results: all }, ext: 'json' };
    }
    case 'map':
      need(1, '<url>');
      return { data: await call('POST', '/api/map', { url: a[0] }), ext: 'json' };
    case 'extract': {
      need(1, '<url>');
      if (!v.schema) die('extract: --schema is required');
      return { data: await call('POST', '/api/extract', { urls: a, schema: schemaArg(v.schema!) }), ext: 'json' };
    }
    case 'social':
      need(1, '<query>');
      return { data: await call('GET', '/api/social', undefined, { q: a.join(' '), sources: v.sources, limit: v.limit }), ext: 'json' };
    case 'media':
      need(1, '<query>');
      if (!v.type) die('media: --type book|film|music is required');
      return { data: await call('GET', '/api/media', undefined, { q: a.join(' '), type: v.type, limit: v.limit }), ext: 'json' };
    case 'books':
      need(1, '<query>');
      return { data: await call('GET', '/api/books', undefined, { q: a.join(' '), limit: v.limit }), ext: 'json' };
    case 'transcript':
      need(1, '<url>');
      return { data: await call('POST', '/api/transcript', { url: a[0], lang: v.lang }), ext: 'json' };
    case 'agent': {
      need(2, '<url> "<goal>"');
      return { data: await call('POST', '/api/agent', { url: a[0], goal: a.slice(1).join(' '), schema: v.schema ? schemaArg(v.schema) : undefined }), ext: 'json' };
    }
    case 'feed': {
      if (a[0] !== 'instagram') die('feed: provider must be "instagram"\n\n' + USAGE);
      if (!v.account) die('feed: --account is required');
      loadConfig();
      const token = personalConfig().token;
      if (!token) die('feed: PHROG_PERSONAL_TOKEN is not set');
      return { data: await call('GET', '/api/personal/feed', undefined, { provider: 'instagram', account: v.account, limit: v.limit, cursor: v.cursor }, { authorization: `Bearer ${token}` }), ext: 'json' };
    }
    default:
      return die(USAGE);
  }
}

if (v.help || pos.length === 0) { console.log(USAGE); process.exit(pos.length === 0 && !v.help ? 1 : 0); }
const { data, ext } = await run();
const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
if (v.json) { console.log(JSON.stringify(data)); process.exit(0); }
if (pos[0] === 'feed') {
  console.log(`feed ${data.provider}/${data.account}: status ${data.status}${data.error ? ` (${data.error})` : ''}, ${data.items.length} posts`);
  for (const it of data.items) {
    const flags = [it.sponsored && 'sponsored', it.suggested && 'suggested', it.seen_before && 'seen-before'].filter(Boolean).join(',');
    const cap = (it.caption ?? '').replace(/\s+/g, ' ').slice(0, 80);
    console.log(`${it.position}. [${it.type ?? '?'}] @${it.author?.handle ?? '?'} "${cap}" ${it.url ?? ''}${flags ? ` (${flags})` : ''}`);
  }
  console.log(`next cursor: ${data.next_cursor ?? '(none)'}`);
  process.exit(0);
}
if (v.stdout) { console.log(text); process.exit(0); }
const file = resolve(v.out || join('phrog-web-out', `${pos[0]}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`));
mkdirSync(join(file, '..'), { recursive: true });
writeFileSync(file, text);
const list = items(data);
console.log(`${pos[0]}: ${typeof data === 'string' ? `${data.length} chars` : `${list.length} items`}, ${text.length} bytes`);
if (typeof data === 'string') console.log(data.slice(0, 200).replace(/\s+/g, ' '));
else for (const r of list.slice(0, 5)) console.log(`  - ${label(r)}`);
console.log(`full output: ${file}`);
