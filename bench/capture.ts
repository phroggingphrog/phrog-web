// Snapshot the candidate rows for each benchmark query, once.
// Replaying a fixture lets the benchmark score the RANKER alone: engine availability,
// network latency and day-to-day result churn are held constant, so a delta can only
// come from ranking. Re-capture deliberately (--refresh), never per run.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpusArg = process.argv.find((a) => a.startsWith('--corpus='));
const corpusPath = corpusArg ? corpusArg.split('=')[1] : join(here, 'queries.json');
const corpusName = basename(corpusPath, '.json');
const fixtures = join(here, 'fixtures', corpusName);
mkdirSync(fixtures, { recursive: true });
const refresh = process.argv.includes('--refresh');
const { queries } = JSON.parse(readFileSync(corpusPath, 'utf8'));
console.log('corpus: ' + corpusPath + ' (' + queries.length + ' queries)');

for (const entry of queries) {
  const slug = entry.q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const out = join(fixtures, slug + '.json');
  if (existsSync(out) && !refresh) { console.log('cached  ' + slug); continue; }
  const url = 'http://127.0.0.1:8888/search?q=' + encodeURIComponent(entry.q) + '&format=json';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data: any = await res.json();
    const rows = (data.results || []).map((r: any) => ({
      url: r.url, title: r.title, content: r.content,
      engines: r.engines || (r.engine ? [r.engine] : []),
      positions: r.positions || [],
      publishedDate: r.publishedDate ?? null,
    }));
    writeFileSync(out, JSON.stringify({ corpus: corpusName, query: entry.q, expect: entry.expect, rows }, null, 1));
    console.log('captured ' + slug + ' (' + rows.length + ' rows)');
  } catch (err: any) {
    console.error('FAILED ' + slug + ': ' + err.message);
  }
}
