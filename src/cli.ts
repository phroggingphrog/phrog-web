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
  feed instagram --account <name> [--limit N] [--cursor C] [--filter jev] [--include-filtered] [--order feed|predicted] [--exploration 0..1]
  feed rss --source </rsshub/route|https://feed.url> [--limit N] [--cursor C] [--filter jev] [--include-filtered] [--order feed|predicted] [--exploration 0..1]
  feed decide <item_id> --decision interesting|not_interesting|send_to_owner|save_event [--reason "..."] [--key K]
                                                         (feed commands need PHROG_PERSONAL_TOKEN)
  personal import [--source social|music|activity|media|all] [--dry-run]   (local; reads PHROG_IMPORT_*_DB read-only)
  personal preferences [--rebuild]                       (local; data-derived preference summary and rules)
  personal discover [--intent "..."] [--days N] [--near place] [--radius-km N] [--limit N]
  personal feedback <item_id|delivery_id> --type like|dislike|save|not_now|too_far|too_expensive|want_to_go|shown [--scope this_time|item|creator|topic|venue] [--reason "..."] [--key K]
Global: --url <base> (or PHROG_WEB_URL; default http://127.0.0.1:8890)
        --out <path>  write full result there (default ./phrog-web-out/<cmd>-<ts>.<ext>)
        --stdout      print full output     --json  print raw JSON`;

const { values: v, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' }, out: { type: 'string' }, stdout: { type: 'boolean' }, json: { type: 'boolean' },
    mode: { type: 'string' }, limit: { type: 'string' }, format: { type: 'string' },
    'max-pages': { type: 'string' }, depth: { type: 'string' }, schema: { type: 'string' },
    sources: { type: 'string' }, source: { type: 'string' }, 'dry-run': { type: 'boolean' }, account: { type: 'string' }, cursor: { type: 'string' }, filter: { type: 'string' }, 'include-filtered': { type: 'boolean' }, order: { type: 'string' }, exploration: { type: 'string' },
    intent: { type: 'string' }, days: { type: 'string' }, near: { type: 'string' }, 'radius-km': { type: 'string' }, rebuild: { type: 'boolean' }, scope: { type: 'string' },
    decision: { type: 'string' }, reason: { type: 'string' }, key: { type: 'string' }, type: { type: 'string' }, lang: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});

const base = (v.url || process.env.PHROG_WEB_URL || 'http://127.0.0.1:8890').replace(/\/$/, '');
const die = (msg: string): never => { console.error(msg); process.exit(1); };

if (pos[0] === 'personal' && pos[1] === 'preferences') {
  loadConfig();
  const { personalPreferences } = await import('./personalization/preferences.js');
  const r: any = personalPreferences({ action: v.rebuild ? 'rebuild' : 'get' });
  if (v.json) console.log(JSON.stringify(r));
  else if (r.rebuilt) console.log(`rebuilt: summary ${r.length} chars, version ${r.version}\n` + Object.entries(r.counts as Record<string, { long: number; recent: number }>).map(([k, c]) => `  ${k}: ${c.long} long, ${c.recent} recent`).join('\n'));
  else console.log(r.summary ? `${r.summary.text}\n\n(version ${r.summary.version}, ${r.summary.length} chars, computed ${r.summary.computed_at}; ${r.rules.length} active rules)` : 'no summary yet: run with --rebuild');
  process.exit(0);
}
if (pos[0] === 'personal' && (pos[1] === 'discover' || pos[1] === 'feedback')) {
  loadConfig();
  const token = personalConfig().token;
  if (!token) die('personal: PHROG_PERSONAL_TOKEN is not set');
  const headers = { authorization: `Bearer ${token}` };
  let data: any;
  if (pos[1] === 'discover') {
    data = await call('POST', '/api/personal/discover', {
      intent: v.intent, limit: v.limit ? Number(v.limit) : undefined, client: 'cli',
      constraints: { days: v.days ? Number(v.days) : undefined, near: v.near, radius_km: v['radius-km'] ? Number(v['radius-km']) : undefined },
    }, undefined, headers);
  } else {
    if (!pos[2] || !v.type) die('personal feedback: <item_id|delivery_id> and --type are required');
    const id = pos[2]!;
    data = await call('POST', '/api/personal/feedback', {
      type: v.type, scope: v.scope, reason: v.reason, idempotency_key: v.key,
      ...(id.startsWith('dlv_') ? { delivery_id: id } : { item_id: id }),
    }, undefined, headers);
  }
  if (v.json) console.log(JSON.stringify(data));
  else if (pos[1] === 'feedback') console.log(data.type === 'shown' ? `shown: ${data.updated} deliveries updated` : `${data.type} (${data.scope}, ${data.effect}) for ${data.item_id}${data.duplicate ? ' (already recorded)' : ''}`);
  else {
    console.log(`discover ${data.run_id}: ${data.status}, ${data.items.length} items, ${data.counts.with_exact_date} with a date, cost $${data.cost_usd}${data.failed_sources.length ? `, ${data.failed_sources.length} failed sources` : ''}`);
    for (const it of data.items) console.log(`${it.rank}. ${it.title} | ${it.starts_at ?? 'date unknown'} | ${it.venue ?? 'venue unknown'} | ${it.url}\n   ${it.reason} [${it.delivery_id}]`);
  }
  process.exit(0);
}
if (pos[0] === 'personal') {
  if (pos[1] !== 'import') die('personal: use import, preferences, discover or feedback\n\n' + USAGE);
  loadConfig();
  const { SOURCES, runImport, formatImport } = await import('./personalization/imports/index.js');
  const { importConfig } = await import('./config.js');
  const { openPersonalDb } = await import('./personalization/db/index.js');
  const want = v.source ?? 'all';
  if (want !== 'all' && !(SOURCES as readonly string[]).includes(want)) die(`personal import: --source must be one of ${SOURCES.join('|')}|all`);
  const cfg = importConfig();
  const db = openPersonalDb(personalConfig().dbPath);
  const results = await runImport(db, cfg.paths, want === 'all' ? [...SOURCES] : [want as (typeof SOURCES)[number]], { accountMap: cfg.accountMap, learnActions: cfg.learnActions }, !!v['dry-run']);
  db.close();
  console.log(v.json ? JSON.stringify(results) : formatImport(results));
  process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
}


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
      if (a[0] !== 'instagram' && a[0] !== 'rss' && a[0] !== 'decide') die('feed: provider must be "instagram" or "rss" (or use "feed decide")\n\n' + USAGE);
      loadConfig();
      const token = personalConfig().token;
      if (!token) die('feed: PHROG_PERSONAL_TOKEN is not set');
      const headers = { authorization: `Bearer ${token}` };
      if (a[0] === 'decide') {
        if (!a[1] || !v.decision) die('feed decide: <item_id> and --decision are required');
        return { data: await call('POST', '/api/personal/feed/decide', { item_id: a[1], decision: v.decision, reason: v.reason, idempotency_key: v.key, client: 'cli' }, undefined, headers), ext: 'json' };
      }
      if (a[0] === 'rss' ? !v.source : !v.account) die(a[0] === 'rss' ? 'feed rss: --source is required' : 'feed: --account is required');
      return { data: await call('GET', '/api/personal/feed', undefined, {
        provider: a[0], account: v.account, source: v.source, limit: v.limit, cursor: v.cursor, filter: v.filter,
        include_filtered: v['include-filtered'] ? 'true' : undefined, order: v.order, exploration: v.exploration,
      }, headers), ext: 'json' };
    }
    default:
      return die(USAGE);
  }
}

if (v.help || pos.length === 0) { console.log(USAGE); process.exit(pos.length === 0 && !v.help ? 1 : 0); }
const { data, ext } = await run();
const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
if (v.json) { console.log(JSON.stringify(data)); process.exit(0); }
if (pos[0] === 'feed' && pos[1] === 'decide') { console.log(`decision ${data.decision} for ${data.item_id}${data.duplicate ? ' (already recorded)' : ''}`); process.exit(0); }
if (pos[0] === 'feed') {
  console.log(`feed ${data.provider}/${data.account}: status ${data.status}${data.error ? ` (${data.error})` : ''}, ${data.items.length} posts${data.filtered_out ? `, ${data.filtered_out} filtered out` : ''}`);
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
