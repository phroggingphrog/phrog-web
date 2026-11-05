import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { feynmanRuntime } from './feynman-runtime.js';
import { executeSearch } from './search.js';
import { omnirouteKey } from './browse.js';
import { llmBase } from './agent.js';

export interface ResearchCitation {
  n: number;
  title: string;
  url: string;
}

export interface QuickResearchResponse {
  mode: 'quick';
  domain: string;
  question: string;
  answer: string;
  citations: ResearchCitation[];
  provider_used: string;
}

export interface QuickResearchOptions {
  domain?: 'web' | 'academic' | 'discussions' | 'all';
  instructions?: string;
}

export interface ResearchJob {
  jobId: string;
  workflow: string;
  topic: string;
  domain?: string;
  pid?: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  deliverable?: string;
  provenance?: string;
  error?: string;
  callbackUrl?: string;
}

// In-memory registry of active and completed jobs
const jobs = new Map<string, ResearchJob>();

/** Citations are the search hits themselves, so an answer can only cite what was actually retrieved. */
export function buildCitations(results: { title?: string; url?: string }[], max = 8): ResearchCitation[] {
  const seen = new Set<string>();
  const out: ResearchCitation[] = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ n: out.length + 1, title: r.title || r.url, url: r.url });
    if (out.length >= max) break;
  }
  return out;
}

/** One LLM pass over the retrieved snippets: it may only use what search returned, and it must cite. */
async function answerFromMaterial(question: string, material: string, instructions: string, signal: AbortSignal): Promise<string> {
  const { base, model } = llmBase();
  const prompt =
    `Question: ${question}\n` +
    (instructions ? `Extra instructions: ${instructions}\n` : '') +
    'Answer using ONLY the numbered sources below. Cite each claim with its bracket number, like [2]. ' +
    'If they do not answer the question, say so plainly instead of guessing. Keep it to 2-6 sentences.\n\n' +
    `SOURCES:\n${material}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${omnirouteKey()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`answer LLM HTTP ${res.status}`);
  const reply: string = ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
  if (!reply.trim()) throw new Error('answer LLM returned an empty answer');
  return reply.trim();
}

/**
 * Quick research = our own search + one LLM pass. It used to be the Vane container, which took 44-59 s
 * and cited worse than our own ranking: asked about Podman's pasta backend it returned an IPv6 article.
 * Now the citations ARE the ranked search hits, so answer quality is bounded by the pipeline we measure.
 */
export async function executeQuickResearch(
  question: string,
  options: QuickResearchOptions = {}
): Promise<QuickResearchResponse> {
  const config = loadConfig();
  const timeoutMs = config.research?.quick?.timeoutMs || 60000;
  const limit = config.research?.quick?.limit || 10;
  const mode = options.domain === 'academic' ? 'academic' : 'quick';

  const search = await executeSearch(question, { mode, limit });
  const citations = buildCitations(search.results, 8);
  if (!citations.length) throw new Error('search returned no results to answer from');

  const hits = new Map(search.results.filter(r => r.url).map(r => [r.url, r]));
  const material = citations
    .map(c => {
      const hit = hits.get(c.url);
      const snippet = (hit?.snippet || '').replace(/\s+/g, ' ').slice(0, 700);
      return `[${c.n}] ${c.title}\n${c.url}\n${snippet || '(no snippet)'}`;
    })
    .join('\n\n');

  const answer = await answerFromMaterial(question, material, options.instructions || '', AbortSignal.timeout(timeoutMs));

  return { mode: 'quick', domain: options.domain || 'web', question, answer, citations, provider_used: 'phrog-web-search' };
}

export function dispatchDeepResearch(
  topic: string,
  options: { workflow?: string; domain?: string; callbackUrl?: string } = {}
): ResearchJob {
  const jobId = `fey_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workflow = options.workflow || 'deepresearch';
  const runtime = feynmanRuntime();
  const feynmanBin = runtime.engine;

  const job: ResearchJob = {
    jobId,
    workflow,
    topic,
    domain: options.domain,
    status: 'running',
    startedAt: new Date().toISOString(),
    callbackUrl: options.callbackUrl,
  };

  jobs.set(jobId, job);

  const outputsDir = resolve(runtime.root, 'outputs');
  mkdirSync(outputsDir, { recursive: true });

  try {
    const child = spawn(runtime.node, [feynmanBin, workflow, topic], {
      cwd: runtime.root,
      env: { ...runtime.env, CI: 'true', NONINTERACTIVE: 'true' },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    job.pid = child.pid;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.on('close', async (exitCode) => {
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();

      if (exitCode === 0 && !spawnError) {
        job.status = 'completed';
        job.deliverable = stdout;
      } else {
        job.status = 'failed';
        job.error = spawnError?.message || stderr || `Process exited with code ${exitCode}`;
      }

      if (job.callbackUrl) {
        try {
          await fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'research_completed',
              jobId,
              status: job.status,
              deliverable: job.deliverable,
              error: job.error,
            }),
          });
        } catch (cbErr) {
          console.error(`Failed to deliver webhook for job ${jobId}:`, cbErr);
        }
      }
    });

  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
  }

  return job;
}

export function getResearchJob(jobId: string): ResearchJob | undefined {
  return jobs.get(jobId);
}
