// Build a benchmark corpus from REAL usage: ~/.local/state/phrog-web/runs.jsonl.
//
// A "domain" here is the host of the page you actually opened after a search. That is
// implicit relevance — cheap, honest and yours — rather than my opinion of which site
// ought to answer. Anything else (a fetched URL) is a hypothesis the ranker should have
// surfaced inside the top K.
//
// Limits to keep in mind when reading the numbers:
//   - it only credits pages that appeared in *some* candidate list, so a page the engines
//     never returned cannot be counted as found;
//   - a fetch can follow a different route (a link you pasted), not only the search;
//   - queries you searched once and abandoned carry no signal and are dropped.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG = process.env.PHROG_WEB_RUNLOG || join(homedir(), '.local/state/phrog-web/runs.jsonl');
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS || 600_000);
const MAX = Number(process.env.BENCH_MAX_QUERIES || 40);

const SEARCH = new Set(['quick_search', 'web_search', 'live_search', 'deep_search', 'GET /api/search', '/api/search']);
const FETCH = new Set(['fetch', 'POST /api/fetch', '/api/fetch', 'web_crawl', 'browse', 'extract']);

type Rec = { ts: string; tool?: string; args?: Record<string, unknown> };
const host = (u: string) => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

if (!existsSync(LOG)) { console.error('no run log at ' + LOG); process.exit(1); }
const recs: Rec[] = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Rec]; } catch { return []; } });

const millis = (r: Rec) => Date.parse(r.ts);
const corpus = new Map<string, Set<string>>();

recs.forEach((r, i) => {
  if (!SEARCH.has(r.tool || '')) return;
  const query = String(r.args?.query || '').trim();
  if (query.length < 4) return;
  const t0 = millis(r);
  if (Number.isNaN(t0)) return;
  const domains = new Set<string>();
  for (let j = i + 1; j < Math.min(i + 40, recs.length); j++) {
    const r2 = recs[j];
    const t2 = millis(r2);
    if (Number.isNaN(t2) || t2 - t0 > WINDOW_MS) break;
    if (!FETCH.has(r2.tool || '')) continue;
    const u = r2.args?.url;
    if (typeof u === 'string') { const h = host(u); if (h) domains.add(h); }
  }
  if (!domains.size) return;
  const key = query.toLowerCase();
  const prev = corpus.get(key) || new Set<string>();
  domains.forEach((d) => prev.add(d));
  corpus.set(key, prev);
});

const entries = [...corpus.entries()]
  .map(([q, d]) => ({ q, expect: [...d].slice(0, 4), kind: 'history' }))
  .filter((e) => e.expect.length > 0)
  .sort((a, b) => a.expect.length - b.expect.length || a.q.localeCompare(b.q))
  .slice(0, MAX);

const out = join(process.cwd(), 'bench/queries.history.json');
writeFileSync(out, JSON.stringify({ generated_from: LOG, window_ms: WINDOW_MS, queries: entries }, null, 1));
console.log('wrote ' + out + ' — ' + entries.length + ' queries derived from ' + recs.length + ' logged calls');
console.log('avg accepted domains/query: ' + (entries.reduce((s, e) => s + e.expect.length, 0) / entries.length).toFixed(2));
