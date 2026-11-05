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

const cases: Case[] = readdirSync(join(here, 'fixtures'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(here, 'fixtures', d.name))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(here, 'fixtures', d.name, f), 'utf8'))));

// A: what production did before this change — provider order, i.e. SearXNG's own order.
const rankA = (rows: Row[]) => rows;
// B: engine-level RRF + authority/freshness boosts (the deployed ranker).
const rankB = (rows: Row[], q: string) => fuseEngineRanks(rows, {}, undefined, q) as unknown as Row[];

const byCorpus = new Map<string, Case[]>();
for (const c of cases) {
  const k = (c as Case & { corpus?: string }).corpus || 'seed';
  byCorpus.set(k, [...(byCorpus.get(k) || []), c]);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const summaryOf = (xs: Metrics[]) => ({ p: mean(xs.map((x) => x.p)), r: mean(xs.map((x) => x.r)), mrr: mean(xs.map((x) => x.mrr)) });

function bootstrapCI(a: Metrics[], b: Metrics[], key: 'p' | 'r' | 'mrr'): readonly [number, number] {
  const N = 5000; let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ds: number[] = [];
  for (let i = 0; i < N; i++) {
    const idx = Array.from({ length: a.length }, () => Math.floor(rnd() * a.length));
    ds.push(mean(idx.map((j) => b[j][key])) - mean(idx.map((j) => a[j][key])));
  }
  const s2 = ds.sort((x, y) => x - y);
  return [s2[Math.floor(s2.length * 0.025)], s2[Math.floor(s2.length * 0.975)]] as const;
}

function report(label: string, group: Case[]) {
  const a: Metrics[] = [];
  const b: Metrics[] = [];
  for (const c of group) { a.push(score(rankA(c.rows), c.expect)); b.push(score(rankB(c.rows, c.query), c.expect)); }
  const A = summaryOf(a); const B = summaryOf(b);
  console.log('\n=== ' + label + ' (' + group.length + ' queries)');
  console.log('metric'.padEnd(8) + 'A (provider order)'.padEnd(20) + 'B (engine RRF)'.padEnd(18) + 'Δ'.padEnd(11) + '95% CI'.padEnd(22) + 'verdict');
  for (const k of ['p', 'r', 'mrr'] as const) {
    const d = B[k] - A[k]; const [lo, hi] = bootstrapCI(a, b, k);
    const verdict = lo > 0 ? 'better' : hi < 0 ? 'WORSE' : 'inconclusive';
    const name = k === 'p' ? 'P@8' : k === 'r' ? 'R@8' : 'MRR@8';
    console.log(name.padEnd(8) + A[k].toFixed(4).padEnd(20) + B[k].toFixed(4).padEnd(18) + ((d >= 0 ? '+' : '') + d.toFixed(4)).padEnd(11) + ('[' + lo.toFixed(4) + ', ' + hi.toFixed(4) + ']').padEnd(22) + verdict);
  }
  const wins = b.filter((x, i) => x.mrr > a[i].mrr).length;
  const losses = b.filter((x, i) => x.mrr < a[i].mrr).length;
  console.log('per-query MRR: ' + wins + ' better, ' + losses + ' worse, ' + (group.length - wins - losses) + ' tied');
  const missedBoth = a.filter((x) => x.mrr === 0).length;
  console.log('queries where the expected page was in NO top-8 list (engine recall problem, not ranking): ' + missedBoth + '/' + group.length);
}

for (const [name, group] of byCorpus) report(name, group);
if (byCorpus.size > 1) report('ALL', cases);
