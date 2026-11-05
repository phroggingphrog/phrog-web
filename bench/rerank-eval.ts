// Does the cross-encoder earn its ~1s?
//
// A: the deployed pipeline without reranking (engine-level RRF order from fixtures).
// B: the same candidates, top-20 sent to the reranker and reordered by relevance score.
// The reranker cannot invent documents, so R@8 can only improve when the right page was
// already in the candidate set but ranked below 8.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuseEngineRanks } from '../src/providers/rank.js';
import { rerank, rerankMaxCandidates } from '../src/providers/rerank.js';

const here = dirname(fileURLToPath(import.meta.url));
const K = 8;
const dir = join(here, 'fixtures', process.argv.find((a) => a.startsWith('--corpus='))?.split('=')[1] || 'queries.history');

type Row = { url: string; title?: string; content?: string; engines?: string[]; positions?: number[]; publishedDate?: string | null };
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (u: string, d: string) => { const h = host(u); return h === d || h.endsWith('.' + d); };
const score = (rows: any[], expect: string[]) => {
  const top = rows.slice(0, K);
  const covered = expect.filter((d) => top.some((r) => matches(r.url, d))).length;
  const first = top.findIndex((r) => expect.some((d) => matches(r.url, d)));
  return { p: covered / K, r: expect.length ? covered / expect.length : 0, mrr: first >= 0 ? 1 / (first + 1) : 0 };
};

const cases = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const A: any[] = []; const B: any[] = [];
let applied = 0; let improved = 0; let worsened = 0; let totalMs = 0;

for (const c of cases) {
  const ranked = fuseEngineRanks(c.rows, {}, undefined, c.query) as unknown as Row[];
  const a = score(ranked, c.expect);
  const gated = ranked.length <= rerankMaxCandidates();
  const head = ranked.slice(0, Math.max(K, 20));
  const out = gated
    ? await rerank(c.query, head.map((r) => ({ title: r.title, snippet: r.content, url: r.url })))
    : { order: [] as number[], ms: 0 };
  totalMs += out.ms;
  let b = a;
  if (out.order.length === head.length) {
    applied++;
    b = score(out.order.map((i) => head[i]), c.expect);
    if (b.mrr > a.mrr) improved++; else if (b.mrr < a.mrr) worsened++;
  }
  A.push(a); B.push(b);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sA = { p: mean(A.map((x) => x.p)), r: mean(A.map((x) => x.r)), mrr: mean(A.map((x) => x.mrr)) };
const sB = { p: mean(B.map((x) => x.p)), r: mean(B.map((x) => x.r)), mrr: mean(B.map((x) => x.mrr)) };
const ci = (k: 'p' | 'r' | 'mrr') => {
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ds: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const idx = Array.from({ length: A.length }, () => Math.floor(rnd() * A.length));
    ds.push(mean(idx.map((j) => B[j][k])) - mean(idx.map((j) => A[j][k])));
  }
  const s = ds.sort((x, y) => x - y);
  return [s[Math.floor(s.length * 0.025)], s[Math.floor(s.length * 0.975)]] as const;
};

console.log(`corpus ${dir.split('/').pop()} — ${cases.length} queries, reranker applied to ${applied}\n`);
console.log('metric'.padEnd(8) + 'A rrf'.padEnd(10) + 'B rrf+rerank'.padEnd(16) + 'Δ'.padEnd(11) + '95% CI');
for (const k of ['p', 'r', 'mrr'] as const) {
  const d = sB[k] - sA[k]; const [lo, hi] = ci(k);
  const v = lo > 0 ? 'better' : hi < 0 ? 'WORSE' : 'inconclusive';
  console.log((k === 'p' ? 'P@8' : k === 'r' ? 'R@8' : 'MRR@8').padEnd(8) + sA[k].toFixed(4).padEnd(10) + sB[k].toFixed(4).padEnd(16) + ((d >= 0 ? '+' : '') + d.toFixed(4)).padEnd(11) + `[${lo.toFixed(4)}, ${hi.toFixed(4)}]  ${v}`);
}
console.log(`\nper-query MRR: ${improved} better, ${worsened} worse`);
console.log(`average rerank latency: ${(totalMs / cases.length).toFixed(0)} ms/query`);
