// Drop-in compat for the old Python `web` MCP: web_search and deep_research_* (job shapes match sitecrawl.job_status).
import { executeSearch } from './search.js';
import {
  dispatchDeepResearch,
  getResearchJob,
  enrichResearchJob,
  resumeDeepResearchJob,
  adoptFeynmanRun,
} from './research.js';
import type { ResearchJob } from './research.js';

const TIME_RANGES = ['day', 'week', 'month', 'year'] as const;
/** Image engines that return icons or museum art, which drown out product photos. */
export const NOISY_IMAGE_ENGINES = new Set(['lucide', 'artic', 'iconify', 'svgrepo', 'openclipart']);

export async function webSearch(a: { query: string; limit?: number; time_range?: string | null; language?: string | null; categories?: string | null }) {
  const query = a.query.trim();
  if (!query) throw new Error('query must not be empty');
  const limit = Math.max(1, Math.min(Math.trunc(a.limit ?? 5), 20));
  if (a.time_range && !(TIME_RANGES as readonly string[]).includes(a.time_range)) throw new Error(`time_range must be one of ${JSON.stringify(TIME_RANGES)}`);
  const timeRange = a.time_range && TIME_RANGES.includes(a.time_range as (typeof TIME_RANGES)[number]) ? a.time_range as (typeof TIME_RANGES)[number] : undefined;
  const response = await executeSearch(query, { mode: 'quick', limit, timeRange, categories: a.categories ? a.categories.split(',').map((category) => category.trim()).filter(Boolean) : undefined, language: a.language ?? undefined });
  const images = /\bimages\b/.test(a.categories ?? '');
  const results = response.results.filter((r) => r.url && !(images && (r.engine ?? '').split(',').some((engine) => NOISY_IMAGE_ENGINES.has(engine)))).map((r) => ({
    title: r.title || r.url, url: r.url, snippet: r.snippet, published_date: null, engines: r.engine ? r.engine.split(',') : [response.provider_used],
    ...(r.image ? { image: r.image, thumbnail: r.thumbnail } : {}),
  }));
  return { query, results, count: results.length, provider: response.provider_used, contributingEngines: response.contributingEngines, failures: response.failures };
}

// Deep research has exactly one implementation: providers/research.ts. These compat entry points keep
// the old job shapes for existing clients but no longer own a second, in-memory job registry — that
// registry could not be polled by research_status, cancelled, or resumed after a restart.
const WORKFLOWS = ['deepresearch', 'lit', 'compare', 'review', 'audit', 'summarize', 'recipe', 'draft'];

/** Old clients read `status`; ours is the same vocabulary plus queued/interrupted/cancelled. */
function compatStatus(job: ResearchJob): string {
  if (job.status === 'queued') return 'queued';
  if (job.status === 'running') return 'running';
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'cancelled';
  return 'failed';
}

function statusView(job: ResearchJob, includeResult: boolean) {
  const elapsed = Math.round((Date.now() - Date.parse(job.startedAt)) / 1000);
  const out: Record<string, any> = {
    job_id: job.jobId,
    kind: 'deep',
    status: compatStatus(job),
    job_status: job.status,
    workflow: job.workflow,
    topic: job.topic,
    completed: 0,
    total: null,
    error: job.error ?? null,
    elapsed_s: elapsed,
    feynman_run_id: job.feynmanRunId,
    run_status: job.runStatus,
    resume_from: job.resumeFrom,
    resumable: job.resumable ?? false,
  };
  if (job.status === 'queued' || job.status === 'running') {
    // Feynman runs take 5-60+ min and only one runs at a time; do not poll in a tight loop.
    out.poll_after_s = elapsed < 120 ? 60 : elapsed < 900 ? 180 : 300;
    out.hint = `Deep research usually takes 5-60 minutes and runs one at a time. Do not poll again for ${out.poll_after_s}s; continue other work and check back later.`;
  }
  if (includeResult && job.deliverable) {
    out.deliverable = job.deliverable.slice(0, 20000);
    out.deliverable_truncated = job.deliverable.length > 20000;
  }
  return out;
}

export function deepResearchStart(a: { topic: string; workflow?: string; profile?: string; tier?: string; budget_usd?: number | null; register?: string | null; inference_depth?: string | null; domain_notes?: string | null }) {
  const workflow = a.workflow ?? 'deepresearch';
  const profile = a.profile ?? 'full';
  const tier = a.tier ?? 'pending';
  if (!WORKFLOWS.includes(workflow)) throw new Error(`workflow must be one of ${WORKFLOWS.join(', ')}`);
  if (!a.topic.trim() || a.topic.length > 4000) throw new Error('topic must be 1-4000 characters');
  if (!['full', 'premier'].includes(profile)) throw new Error('profile must be full or premier');
  if (!['pending', 'light', 'full', 'dissertation'].includes(tier)) throw new Error('tier must be pending, light, full, or dissertation');
  if (a.budget_usd != null && a.budget_usd <= 0) throw new Error('budget_usd must be greater than zero');
  if (a.register != null && !['teach', 'survey', 'analyze', 'advocate'].includes(a.register)) throw new Error('register must be teach, survey, analyze, or advocate');
  if (a.inference_depth != null && !['surface', 'standard', 'deep'].includes(a.inference_depth)) throw new Error('inference_depth must be surface, standard, or deep');
  if (a.domain_notes != null && a.domain_notes.length > 2000) throw new Error('domain_notes must be at most 2000 characters');

  const job = dispatchDeepResearch(a.topic.trim(), { workflow });
  return {
    job_id: job.jobId,
    status: 'running',
    kind: 'deep',
    workflow: job.workflow,
    runs_in: 'the phrog-web service: survives a client disconnect, and resumable with research_resume after a restart',
    note: `Dispatched to the Feynman engine. Poll deep_research_status or research_status with job_id "${job.jobId}".`,
  };
}

export async function deepResearchResume(a: { run_id: string }) {
  const id = a.run_id.trim();
  if (!id || a.run_id.length > 120) throw new Error('run_id must be 1-120 characters');
  // Accepts either one of our job ids or a raw Feynman run id, so older callers keep working.
  if (/^fey_\d+_[a-z0-9]{5}$/.test(id)) {
    const job = await resumeDeepResearchJob(id);
    return { job_id: job.jobId, status: 'running', note: 'resumed from the first unfinished stage' };
  }
  const job = await adoptFeynmanRun(id);
  return { job_id: job.jobId, status: 'queued', note: `adopted Feynman run ${id}; resumes from its first unfinished stage` };
}

export async function deepResearchStatus(a: { job_id: string; include_result?: boolean }) {
  const job = getResearchJob(a.job_id);
  if (!job) throw new Error(`Research job "${a.job_id}" not found`);
  await enrichResearchJob(job);
  return statusView(job, Boolean(a.include_result));
}
