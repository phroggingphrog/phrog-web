// Does query shaping actually fix the recall hole?
//
// A: the rows SearXNG returned for the raw query (captured fixtures — what production did).
// B: the raw rows PLUS the shaped variants, all fused with engine-level RRF.
// Same judgments, same corpus, so the delta is attributable to shaping alone.
//
// The variants are fetched live here (capture-time shaping would freeze a network result);
// run it a few times and treat the spread as noise, not as tuning signal.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuseEngineRanks, canonicalKey } from '../src/providers/rank.js';
import { shapeQuery } from '../src/providers/query-shape.js';

const here = dirname(fileURLToPath(import.meta.url));
const K = 8;
const SEARX = process.env.SEARXNG_URL || 'http://127.0.0.1:8888';
const dir = join(here, 'fixtures', process.argv.find((a) => a.startsWith('--corpus='))?.split('=')[1] || 'queries.history');

type Row = { url: string; title?: string; content?: string; engines?: string[]; positions?: number[]; publishedDate?: string | null };
type Case = { query: string; expect: string[]; rows: Row[] };

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (u: string, d: string) => { const h = host(u); return h === d || h.endsWith('.' + d); };
const score = (ordered: Row[], expect: string[]) => {
  const top = ordered.slice(0, K);
  const covered = expect.filter((d) => top.some((r) => matches(r.url, d))).length;
  const first = top.findIndex((r) => expect.some((d) => matches(r.url, d)));
  return { p: covered / K, r: expect.length ? covered / expect.length : 0, mrr: first >= 0 ? 1 / (first + 1) : 0 };
};

async function fetchRows(q: string): Promise<Row[]> {
  const res = await fetch(`${SEARX}/search?q=${encodeURIComponent(q)}&format=json`, { signal: AbortSignal.timeout(20000) });
  const data: any = await res.json();
  return (data.results || []).map((r: any) => ({
    url: r.url, title: r.title, content: r.content,
    engines: r.engines || (r.engine ? [r.engine] : []), positions: r.positions || [],
    publishedDate: r.publishedDate ?? null,
  }));
}

const cases: Case[] = readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

const A: any[] = []; const B: any[] = [];
let shapedCount = 0; let recovered = 0;

for (const c of cases) {
  const shape = shapeQuery(c.query);
  let bRows: Row[] = c.rows;
  if (shape.shaped) {
    shapedCount++;
    const variants = shape.variants.slice(0, 2);
    const lists = await Promise.all(variants.map(async (v) => { try { return await fetchRows(v); } catch { return [] as Row[]; } }));
    const tagged: Row[] = [];
    c.rows.forEach((r, i) => tagged.push({ ...r, engines: ['q0'], positions: [i + 1] }));
    lists.forEach((rows, vi) => rows.forEach((r, i) => tagged.push({ ...r, engines: [`q${vi + 1}`], positions: [i + 1] })));
    const seen = new Map<string, Row>();
    for (const r of tagged) { const k = canonicalKey(r.url); if (!seen.has(k)) seen.set(k, r); }
    bRows = fuseEngineRanks(tagged, {}, { q0: 1.5 }, c.query);
  }
  const a = score(c.rows, c.expect); const b = score(bRows, c.expect);
  if (a.mrr === 0 && b.mrr > 0) recovered++;
  A.push(a); B.push(b);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sA = { p: mean(A.map((x) => x.p)), r: mean(A.map((x) => x.r)), mrr: mean(A.map((x) => x.mrr)) };
const sB = { p: mean(B.map((x) => x.p)), r: mean(B.map((x) => x.r)), mrr: mean(B.map((x) => x.mrr)) };
const ci = (key: 'p' | 'r' | 'mrr') => {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ds: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const idx = Array.from({ length: A.length }, () => Math.floor(rnd() * A.length));
    ds.push(mean(idx.map((j) => B[j][key])) - mean(idx.map((j) => A[j][key])));
  }
  const s = ds.sort((x, y) => x - y);
  return [s[Math.floor(s.length * 0.025)], s[Math.floor(s.length * 0.975)]] as const;
};

console.log(`corpus ${dir.split('/').pop()} — ${cases.length} queries, ${shapedCount} reshaped\n`);
console.log('metric'.padEnd(8) + 'A raw'.padEnd(10) + 'B raw+variants'.padEnd(18) + 'Δ'.padEnd(11) + '95% CI');
for (const k of ['p', 'r', 'mrr'] as const) {
  const d = sB[k] - sA[k]; const [lo, hi] = ci(k);
  const v = lo > 0 ? 'better' : hi < 0 ? 'WORSE' : 'inconclusive';
  console.log((k === 'p' ? 'P@8' : k === 'r' ? 'R@8' : 'MRR@8').padEnd(8) + sA[k].toFixed(4).padEnd(10) + sB[k].toFixed(4).padEnd(18) + ((d >= 0 ? '+' : '') + d.toFixed(4)).padEnd(11) + `[${lo.toFixed(4)}, ${hi.toFixed(4)}]  ${v}`);
}
console.log(`\nqueries where shaping recovered a page that raw ordering missed: ${recovered}/${cases.length}`);
