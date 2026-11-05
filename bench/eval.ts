// Score the ranker, not the engines. Fixtures hold the candidate rows captured once;
// each ranker re-orders the SAME rows, so any metric delta is attributable to ranking.
//
//   P@8    precision — hits / 8
//   R@8    recall    — hits / expected (the metric that matters for an agent opening a page)
//   MRR@8  1 / rank of the first expected result, 0 when absent from the top 8
//
// Significance is a PAIRED bootstrap over queries (5000 resamples of the query set, both
// rankers re-measured on the same resample), reporting the mean delta and its 95% CI.
// A CI that straddles 0 means "we cannot tell these apart on this corpus".
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuseEngineRanks } from '../src/providers/rank.js';

const here = dirname(fileURLToPath(import.meta.url));
const K = 8;

type Row = { url: string; title?: string; content?: string; engines?: string[]; positions?: number[]; publishedDate?: string | null };
type Case = { query: string; expect: string[]; rows: Row[] };
type Metrics = { p: number; r: number; mrr: number };

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (u: string, expect: string[]) => {
  const h = host(u);
  return expect.some((d) => h === d || h.endsWith('.' + d));
};

function score(ordered: Row[], expect: string[]): Metrics {
  const top = ordered.slice(0, K);
  // Count each EXPECTED entry at most once. Without this, "podman.io" and "docs.podman.io"
  // both match a docs.podman.io row and recall exceeds 1 — a metric bug, not a good result.
  const covered = expect.filter((d) => top.some((r) => matches(r.url, [d]))).length;
  const first = top.findIndex((r) => matches(r.url, expect));
  return { p: covered / K, r: expect.length ? covered / expect.length : 0, mrr: first >= 0 ? 1 / (first + 1) : 0 };
}

const cases: Case[] = readdirSync(join(here, 'fixtures'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8')));

// A: what production did before this change — provider order, i.e. SearXNG's own order.
const rankA = (rows: Row[]) => rows;
// B: engine-level RRF + authority/freshness boosts (the deployed ranker).
const rankB = (rows: Row[], q: string) => fuseEngineRanks(rows, {}, undefined, q) as unknown as Row[];

const rowsA: Metrics[] = [];
const rowsB: Metrics[] = [];
const perQuery: string[] = [];

for (const c of cases) {
  const a = score(rankA(c.rows), c.expect);
  const b = score(rankB(c.rows, c.query), c.expect);
  rowsA.push(a); rowsB.push(b);
  const flag = b.mrr > a.mrr ? '↑' : b.mrr < a.mrr ? '↓' : '=';
  perQuery.push(`  ${c.query.slice(0, 44).padEnd(44)} MRR ${a.mrr.toFixed(3)} → ${b.mrr.toFixed(3)} ${flag}   R@8 ${a.r.toFixed(2)} → ${b.r.toFixed(2)}`);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const summary = (xs: Metrics[]) => ({ p: mean(xs.map((x) => x.p)), r: mean(xs.map((x) => x.r)), mrr: mean(xs.map((x) => x.mrr)) });
const A = summary(rowsA); const B = summary(rowsB);

// Paired bootstrap over queries.
const N = 5000;
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const deltas: Record<'p' | 'r' | 'mrr', number[]> = { p: [], r: [], mrr: [] };
for (let i = 0; i < N; i++) {
  const idx = Array.from({ length: cases.length }, () => Math.floor(rnd() * cases.length));
  for (const k of ['p', 'r', 'mrr'] as const) {
    const a = mean(idx.map((j) => rowsA[j][k]));
    const b = mean(idx.map((j) => rowsB[j][k]));
    deltas[k].push(b - a);
  }
}
const ci = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return [s[Math.floor(s.length * 0.025)], s[Math.floor(s.length * 0.975)]] as const;
};

console.log('corpus: ' + cases.length + ' queries, top-' + K + ', fixtures replayed (deterministic)\n');
console.log(perQuery.join('\n'));
console.log('\n' + 'metric'.padEnd(8) + 'A (provider order)'.padEnd(20) + 'B (engine RRF)'.padEnd(18) + 'Δ' + ' '.repeat(9) + '95% CI');
for (const k of ['p', 'r', 'mrr'] as const) {
  const d = B[k] - A[k];
  const [lo, hi] = ci(deltas[k]);
  const verdict = lo > 0 ? 'better' : hi < 0 ? 'WORSE' : 'inconclusive';
  const name = k === 'p' ? 'P@8' : k === 'r' ? 'R@8' : 'MRR@8';
  console.log(name.padEnd(8) + A[k].toFixed(4).padEnd(20) + B[k].toFixed(4).padEnd(18) + (d >= 0 ? '+' : '') + d.toFixed(4) + '   [' + lo.toFixed(4) + ', ' + hi.toFixed(4) + ']  ' + verdict);
}
const wins = rowsB.filter((b, i) => b.mrr > rowsA[i].mrr).length;
const losses = rowsB.filter((b, i) => b.mrr < rowsA[i].mrr).length;
console.log('\nper-query MRR: ' + wins + ' better, ' + losses + ' worse, ' + (cases.length - wins - losses) + ' tied');
