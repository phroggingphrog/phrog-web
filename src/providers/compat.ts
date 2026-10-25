// Drop-in compat for the old Python `web` MCP: web_search and deep_research_* (job shapes match sitecrawl.job_status).
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { executeSearch } from './search.js';
import { call } from './vault.js';

const TIME_RANGES = ['day', 'week', 'month', 'year'];

export async function webSearch(a: { query: string; limit?: number; time_range?: string | null; language?: string | null; categories?: string | null }) {
  const query = a.query.trim();
  if (!query) throw new Error('query must not be empty');
  const limit = Math.max(1, Math.min(Math.trunc(a.limit ?? 5), 20));
  if (a.time_range && !TIME_RANGES.includes(a.time_range)) throw new Error(`time_range must be one of ${JSON.stringify(TIME_RANGES)}`);
  const p = new URLSearchParams({ q: query, format: 'json' });
  if (a.time_range) p.set('time_range', a.time_range);
  if (a.language) p.set('language', a.language);
  if (a.categories) p.set('categories', a.categories);
  let err: unknown;
  try {
    const res = await fetch(`${(process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, '')}/search?${p}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const raw: any[] = ((await res.json()) as any).results ?? [];
    const results = raw.filter((r) => r?.url).slice(0, limit).map((r) => ({
      title: String(r.title || r.url), url: String(r.url), snippet: String(r.content || r.snippet || ''),
      published_date: String(r.publishedDate || r.published_at || '') || null, engines: (r.engines ?? []).map(String),
    }));
    if (results.length) return { query, results, count: results.length, provider: 'searxng' };
  } catch (e) { err = e; }
  try {
    const fb = await executeSearch(query, { mode: 'quick', limit });
    const results = fb.results.map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.snippet, published_date: null, engines: [r.engine ?? fb.provider_used] }));
    return { query, results, count: results.length, provider: fb.provider_used };
  } catch (e) { throw err ?? e; }
}

// Feynman MCP runs deep research jobs one at a time.
const WORKFLOWS = ['deepresearch', 'lit', 'compare', 'review', 'audit', 'summarize', 'recipe', 'draft'];
const MAX_TOTAL_MS = 12 * 3600 * 1000;
interface DeepJob { id: string; kind: 'deep'; status: string; completed: number; total: null; error: string | null; note?: string; feynman_job_id?: string; result?: any }
const jobs = new Map<string, DeepJob>();
let gate: Promise<unknown> = Promise.resolve();
const field = (t: string, n: string) => t.match(new RegExp(`^${n}: (.+)$`, 'm'))?.[1].trim();
const fcall = (tool: string, args: Record<string, any>) => call(tool, args, 320000).then((r) => (typeof r === 'string' ? r : JSON.stringify(r)));

async function runDeep(job: DeepJob, p: Record<string, any>) {
  const started = Date.now();
  const note = (m: string, fid?: string) => { job.note = m; if (fid) job.feynman_job_id = fid; };
  let t: string;
  if (p.resume_run_id) { note('resuming the Feynman run from its saved checkpoint', p.resume_run_id); t = await fcall('feynman_resume', { runId: p.resume_run_id }); }
  else {
    const args: Record<string, any> = { workflow: p.workflow, topic: p.topic };
    if (p.profile) args.profile = p.profile;
    if (p.tier && p.tier !== 'pending') args.tier = p.tier;
    if (p.budget_usd != null) args.budgetUsd = p.budget_usd;
    if (p.register) args.register = p.register;
    if (p.inference_depth) args.inferenceDepth = p.inference_depth;
    if (p.domain_notes) args.domainNotes = p.domain_notes;
    t = await fcall('feynman_research', args);
    while (field(t, 'STATUS') === 'busy' && Date.now() - started < MAX_TOTAL_MS) {
      note('Feynman is busy with another run; retrying in 30 s');
      await new Promise((r) => setTimeout(r, 30000));
      t = await fcall('feynman_research', args);
    }
  }
  while (field(t, 'STATUS') === 'running' && Date.now() - started < MAX_TOTAL_MS) {
    const fid = field(t, 'JOB_ID');
    note(`running ${Math.round((Date.now() - started) / 1000)}s, latest file ${field(t, 'LATEST_FILE')}`, fid);
    t = await fcall('feynman_result', { job_id: fid ?? job.feynman_job_id ?? '' });
  }
  const status = field(t, 'STATUS');
  if (status !== 'done' && status !== 'blocked') throw new Error(`Feynman ended with status ${status}: ${field(t, 'ERROR') ?? t.slice(0, 300)}`);
  const path = field(t, 'PATH');
  const body = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!body) throw new Error('Feynman finished but no deliverable file was found');
  job.result = { status, workflow: p.workflow, run_id: field(t, 'RUN_ID'), path, seconds: Math.round((Date.now() - started) / 1000), chars: body.length, deliverable: body };
}

function startDeep(p: Record<string, any>) {
  const job: DeepJob = { id: randomUUID(), kind: 'deep', status: 'queued', completed: 0, total: null, error: null, note: 'waiting for the Feynman slot' };
  jobs.set(job.id, job);
  gate = gate.then(async () => {
    job.status = 'running'; job.note = undefined;
    try { await runDeep(job, p); job.status = 'completed'; }
    catch (e: any) { job.status = 'failed'; job.error = `${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}`; }
  });
  return { job_id: job.id, status: 'running', runs_in: 'this process (ends with the session)' };
}

export function deepResearchStart(a: { topic: string; workflow?: string; profile?: string; tier?: string; budget_usd?: number | null; register?: string | null; inference_depth?: string | null; domain_notes?: string | null }) {
  const workflow = a.workflow ?? 'deepresearch', profile = a.profile ?? 'full', tier = a.tier ?? 'pending';
  if (!WORKFLOWS.includes(workflow)) throw new Error(`workflow must be one of ${WORKFLOWS.join(', ')}`);
  if (!a.topic.trim() || a.topic.length > 4000) throw new Error('topic must be 1-4000 characters');
  if (!['full', 'premier'].includes(profile)) throw new Error('profile must be full or premier');
  if (!['pending', 'light', 'full', 'dissertation'].includes(tier)) throw new Error('tier must be pending, light, full, or dissertation');
  if (a.budget_usd != null && a.budget_usd <= 0) throw new Error('budget_usd must be greater than zero');
  if (a.register != null && !['teach', 'survey', 'analyze', 'advocate'].includes(a.register)) throw new Error('register must be teach, survey, analyze, or advocate');
  if (a.inference_depth != null && !['surface', 'standard', 'deep'].includes(a.inference_depth)) throw new Error('inference_depth must be surface, standard, or deep');
  if (a.domain_notes != null && a.domain_notes.length > 2000) throw new Error('domain_notes must be at most 2000 characters');
  return startDeep({ topic: a.topic.trim(), workflow, profile, tier, budget_usd: a.budget_usd, register: a.register, inference_depth: a.inference_depth, domain_notes: a.domain_notes });
}

export async function deepResearchResume(a: { run_id: string }) {
  const id = a.run_id.trim();
  if (!id || a.run_id.length > 120) throw new Error('run_id must be 1-120 characters');
  const m: any = await call('feynman_research_status', { runId: id });
  const topic = m && typeof m === 'object' ? m.query ?? '' : '';
  if (!topic) throw new Error(`Feynman run '${a.run_id}' did not return its original query`);
  return startDeep({ topic, workflow: 'deepresearch', resume_run_id: id });
}

export function deepResearchStatus(a: { job_id: string; include_result?: boolean }) {
  const job = jobs.get(a.job_id);
  if (!job) return { job_id: a.job_id, status: 'unknown', error: 'no such job' };
  const out: Record<string, any> = { job_id: job.id, kind: 'deep', status: job.status, completed: job.completed, total: job.total, error: job.error };
  if (job.feynman_job_id) out.run_id = job.feynman_job_id;
  if (job.note) out.note = job.note;
  if (job.result) {
    const { deliverable, status, ...rest } = job.result;
    out.research_status = status;
    Object.assign(out, rest);
    if (a.include_result) { out.deliverable = deliverable.slice(0, 20000); out.deliverable_truncated = deliverable.length > 20000; }
  }
  return out;
}
