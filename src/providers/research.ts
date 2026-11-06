import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/**
 * The workflows Feynman actually implements. Anything else is refused at dispatch: an unknown name used
 * to be spawned anyway, and the CLI exited 0 having done nothing, so the job reported success.
 */
// Read from the engine so the allow-list cannot drift from what Feynman can actually run: the old
// hand-written list refused real workflows (draft, recipe, replicate, autoresearch) and accepted `help`,
// which is not a workflow — `feynman help <topic>` exits 0 and would have reported a finished "research".
const FALLBACK_WORKFLOWS = ['deepresearch', 'lit', 'compare', 'review', 'audit', 'summarize'];

function feynmanPromptsDir(): string {
  // <engine>/bin/feynman.js -> <engine>/prompts, the same engine the runtime launches.
  try { return resolve(feynmanRuntime().engine, '..', '..', 'prompts'); } catch { return resolve(process.cwd(), 'engines/feynman/prompts'); }
}
export function researchWorkflows(): readonly string[] {
  try {
    const dir = join(feynmanPromptsDir());
    const names = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
    return names.length ? names.sort() : FALLBACK_WORKFLOWS;
  } catch {
    return FALLBACK_WORKFLOWS;
  }
}

export interface ResearchJob {
  jobId: string;
  workflow: string;
  topic: string;
  domain?: string;
  pid?: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  deliverable?: string;
  provenance?: string;
  error?: string;
  callbackUrl?: string;
  /** Feynman's own durable run id (feynman research run init). Absent when bookkeeping failed. */
  feynmanRunId?: string;
  /** Live manifest status read back from Feynman, not from our record. */
  runStatus?: string;
  /** First unfinished stage, as Feynman reports it. */
  resumeFrom?: string;
  resumable?: boolean;
  resumedAt?: string;
  /** 'checkpoint' continues Feynman's manifest; 'restart' re-runs a named workflow from the start. */
  resumed_mode?: 'checkpoint' | 'restart';
}

// In-memory registry, backed by one JSON file per job so /api/research/:jobId survives a restart.
const jobs = new Map<string, ResearchJob>();
const JOB_ID = /^fey_\d+_[a-z0-9]{5}$/;

function jobsDir(): string {
  return process.env.PHROG_WEB_RESEARCH_JOBS_DIR || join(homedir(), '.local', 'state', 'phrog-web', 'research-jobs');
}

/** Atomic write: a half-written job file must never be readable. */
function persistJob(job: ResearchJob): void {
  try {
    mkdirSync(jobsDir(), { recursive: true });
    const target = join(jobsDir(), `${job.jobId}.json`);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    console.error(`Failed to persist research job ${job.jobId}:`, err);
  }
}

function readJobFile(jobId: string): ResearchJob | undefined {
  if (!JOB_ID.test(jobId)) return undefined;   // no path traversal, ever
  try {
    return JSON.parse(readFileSync(join(jobsDir(), `${jobId}.json`), 'utf8')) as ResearchJob;
  } catch {
    return undefined;
  }
}

/** The engine prints an ASCII banner before JSON and may trail text after it. */
export function parseFeynmanJson(output: string): any {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('no JSON object in Feynman output');
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(output.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in Feynman output');
}

/** One engine invocation, stdout+stderr collected, killed if it overruns. */
function runFeynman(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const rt = feynmanRuntime();
  return new Promise((resolvePromise) => {
    const child = spawn(rt.node, [rt.engine, ...args], { cwd: rt.root, env: rt.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ stdout, stderr: stderr + String(err), code: null }); });
  });
}

/** Create the durable manifest in Feynman's own store. Returns undefined if the engine refuses. */
async function initFeynmanRun(topic: string, profile = 'full', tier = 'pending'): Promise<string | undefined> {
  try {
    const out = await runFeynman(['research', 'run', 'init', topic, '--profile', profile, '--tier', tier, '--json'], 90000);
    const manifest = parseFeynmanJson(out.stdout);
    return typeof manifest?.id === 'string' ? manifest.id : undefined;
  } catch {
    return undefined;
  }
}

/** Read the authoritative run state back from Feynman rather than trusting our own record. */
export async function feynmanRunStatus(runId: string): Promise<{ runStatus?: string; resumeFrom?: string; steps?: unknown; query?: string }> {
  const out = await runFeynman(['research', 'run', 'status', runId, '--json'], 30000);
  if (out.code !== 0) throw new Error(`feynman research run status exited ${out.code}: ${out.stderr.trim().slice(0, 200)}`);
  const manifest = parseFeynmanJson(out.stdout);
  return { runStatus: manifest?.status, steps: manifest?.steps, resumeFrom: resumeStepOf(manifest), query: typeof manifest?.query === 'string' ? manifest.query : undefined };
}

/** Feynman stores steps as {id: status}; the first one not done is where a resume starts. */
export function resumeStepOf(manifest: any): string | undefined {
  const steps = manifest?.steps;
  if (!steps || typeof steps !== 'object') return undefined;
  const order: string[] = Array.isArray(manifest.stepOrder) ? manifest.stepOrder : Object.keys(steps);
  for (const id of order) {
    const step = steps[id];
    // Feynman writes {status, startedAt, message} per step; older manifests wrote a bare string.
    const status = typeof step === 'string' ? step : step?.status;
    if (status !== 'done' && status !== 'completed' && status !== 'skipped') return id;
  }
  return undefined;
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * A Feynman child is spawned by this process, so a service restart kills the work while the job file
 * still says 'running'. Mark those honestly instead of reporting a run that no longer exists; Feynman's
 * own `feynman research run` subcommands are the durable path for anything that must outlive us.
 */
let reconciled = false;
export function reconcileResearchJobs(): number {
  reconciled = true;
  let changed = 0;
  try {
    for (const name of readdirSync(jobsDir())) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -5);
      const job = readJobFile(jobId);
      if (!job) continue;
      // `waiting[]` lives only in memory, so a job that was queued at exit would stay queued forever.
      if (job.status === 'queued') {
        job.status = 'interrupted';
        job.error = job.error || 'The service restarted while this job was waiting in the queue. Resume it to run it again.';
        job.resumable = true;
        jobs.set(jobId, job);
        persistJob(job);
        changed++;
        continue;
      }
      if (job.status !== 'running') continue;
      if (alive(job.pid)) continue;
      job.status = 'interrupted';
      job.finishedAt = job.finishedAt || new Date().toISOString();
      job.error = job.error || 'The service restarted while this run was in progress; the Feynman child did not survive. Re-run, or use `feynman research run` for a durable run.';
      jobs.set(jobId, job);
      persistJob(job);
      changed++;
    }
  } catch { /* no jobs dir yet */ }
  return changed;
}

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

// Feynman runs one research job at a time against a single vault, so the slot is reserved synchronously
// at dispatch: waiting for the manifest to be created first let two dispatches start together.
let activeJob: string | undefined;
type Waiting = { job: ResearchJob; start: () => Promise<string[]> };
const waiting: Waiting[] = [];

function failJob(job: ResearchJob, err: unknown): void {
  job.status = 'failed';
  job.error = err instanceof Error ? err.message : String(err);
  job.finishedAt = new Date().toISOString();
  persistJob(job);
  if (activeJob === job.jobId) { activeJob = undefined; drainQueue(); }
}

/** Start a job now, or queue it behind the one that is running. */
function enqueue(job: ResearchJob, start: () => Promise<string[]>): void {
  if (activeJob) {
    job.status = 'queued';
    waiting.push({ job, start });
    persistJob(job);
    return;
  }
  activeJob = job.jobId;
  void start()
    .then((args) => {
      // Cancelling during manifest creation finds no process to kill, so the job would otherwise start
      // anyway and flip back to running after the user cancelled it.
      if (job.status === 'cancelled' || job.status === 'failed') { activeJob = undefined; drainQueue(); return; }
      startFeynman(job, args);
    })
    .catch((err) => failJob(job, err));
}

function drainQueue(): void {
  // A job cancelled while it was waiting must never be started by the drain.
  while (waiting.length) {
    const next = waiting.shift()!;
    if (next.job.status !== 'queued') continue;
    activeJob = next.job.jobId;
    void next.start()
      .then((args) => {
        if (next.job.status === 'cancelled' || next.job.status === 'failed') { activeJob = undefined; drainQueue(); return; }
        startFeynman(next.job, args);
      })
      .catch((err) => failJob(next.job, err));
    return;
  }
}

/** Spawn the engine for a job and keep the record in step with the process. */
function startFeynman(job: ResearchJob, args: string[]): void {
  const runtime = feynmanRuntime();
  mkdirSync(resolve(runtime.root, 'outputs'), { recursive: true });

  try {
    const child = spawn(runtime.node, [runtime.engine, ...args], {
      cwd: runtime.root,
      env: { ...runtime.env, CI: 'true', NONINTERACTIVE: 'true' },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    job.pid = child.pid;
    job.status = 'running';
    delete job.error;
    delete job.finishedAt;
    delete job.exitCode;
    persistJob(job);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.on('close', async (exitCode) => {
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();

      // A cancelled job was SIGKILLed by us: its exit code says nothing, and reporting `failed` made the
      // job resumable again, so a cancelled run could be restarted by accident.
      if (job.status === 'cancelled') {
        persistJob(job);
        if (activeJob === job.jobId) { activeJob = undefined; drainQueue(); }
        return;
      }

      if (exitCode === 0 && !spawnError) {
        job.status = 'completed';
        job.deliverable = stdout;
        job.resumable = false;
      } else {
        job.status = 'failed';
        job.error = spawnError?.message || stderr || `Process exited with code ${exitCode}`;
        job.resumable = Boolean(job.feynmanRunId);
      }

      persistJob(job);
      if (activeJob === job.jobId) { activeJob = undefined; drainQueue(); }

      if (job.callbackUrl) {
        try {
          await fetch(job.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'research_completed',
              jobId: job.jobId,
              status: job.status,
              deliverable: job.deliverable,
              error: job.error,
              feynman_run_id: job.feynmanRunId,
            }),
          });
        } catch (cbErr) {
          console.error(`Failed to deliver webhook for job ${job.jobId}:`, cbErr);
        }
      }
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
    persistJob(job);
    if (activeJob === job.jobId) { activeJob = undefined; drainQueue(); }
  }
}

export function dispatchDeepResearch(
  topic: string,
  options: { workflow?: string; domain?: string; callbackUrl?: string; profile?: string; tier?: string } = {}
): ResearchJob {
  const jobId = `fey_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workflow = options.workflow || 'deepresearch';
  const allowed = researchWorkflows();
  if (!allowed.includes(workflow)) {
    throw new Error(`Unknown workflow "${workflow}"; expected one of: ${allowed.join(', ')}`);
  }

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
  persistJob(job);

  // The durable manifest is created first so the run id exists from the start: that is what makes
  // `POST /api/research/:jobId/resume` possible after a restart. Only the default workflow has a
  // manifest; named workflows (lit, compare, audit...) are spawned directly.
  enqueue(job, async () => {
    if (workflow === 'deepresearch') {
      const runId = await initFeynmanRun(topic, options.profile, options.tier);
      if (runId) {
        job.feynmanRunId = runId;
        job.resumable = true;
        persistJob(job);
        return ['research', 'run', 'resume', runId];
      }
    }
    return [workflow, topic];
  });

  return job;
}

/**
 * A deepresearch job resumes from its manifest. Named workflows (lit, compare, audit...) have no
 * manifest — Feynman's durable run store only describes deepresearch — so they restart instead. Saying
 * "cannot be resumed" for those was true but useless: the honest answer is "it will start over".
 */
export function canResume(job: ResearchJob | undefined): boolean {
  if (!job) return false;
  if (job.status !== 'interrupted' && job.status !== 'failed') return false;
  return true;
}

export function resumeMode(job: ResearchJob): 'checkpoint' | 'restart' {
  return job.feynmanRunId ? 'checkpoint' : 'restart';
}

/** Re-enter Feynman's durable run from its first unfinished stage. */
export async function resumeDeepResearchJob(jobId: string): Promise<ResearchJob> {
  const job = getResearchJob(jobId);
  if (!job) {
    const err = new Error(`Research job "${jobId}" not found`) as Error & { code?: string };
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!canResume(job)) {
    throw new Error(`Job "${jobId}" is ${job.status} and cannot be resumed; only interrupted or failed runs can`);
  }

  job.resumedAt = new Date().toISOString();
  job.resumable = true;
  job.resumed_mode = resumeMode(job);
  delete job.error;
  delete job.finishedAt;
  delete job.exitCode;
  jobs.set(jobId, job);
  if (job.feynmanRunId) {
    enqueue(job, async () => ['research', 'run', 'resume', job.feynmanRunId!]);
  } else {
    // No manifest: re-run the same workflow from the start, and say so.
    enqueue(job, async () => [job.workflow, job.topic]);
  }
  return job;
}

/** A 'running' record whose process is gone is lying, whether or not the service restarted. */
export function isOrphaned(job: ResearchJob | undefined): boolean {
  return Boolean(job && job.status === 'running' && !alive(job.pid));
}

/**
 * Stop a run. Killing the recorded pid is not enough: `research run resume` starts a supervisor that
 * spawns the actual deepresearch worker, so the tree is matched by the run id in its command line.
 */
export async function cancelDeepResearchJob(jobId: string): Promise<ResearchJob> {
  const job = getResearchJob(jobId);
  if (!job) {
    const err = new Error(`Research job "${jobId}" not found`) as Error & { code?: string };
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (job.status === 'completed' || job.status === 'cancelled') {
    throw new Error(`Job "${jobId}" is already ${job.status}`);
  }

  // Drop it from the queue first, so a cancelled job is never picked up by the drain.
  const queuedAt = waiting.findIndex((w) => w.job.jobId === job.jobId);
  if (queuedAt >= 0) waiting.splice(queuedAt, 1);

  const markers = [job.feynmanRunId, job.jobId].filter(Boolean) as string[];
  let killed = 0;
  const listing = spawnSync('pgrep', ['-af', 'feynman'], { encoding: 'utf8', timeout: 5000 });
  for (const line of (listing.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    if (markers.some(marker => line.includes(marker))) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isFinite(pid) && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
      }
    }
  }
  // Only a pid from a live run may be killed: a resumed or queued job can still carry the pid of a
  // process that exited long ago, and that number may by now belong to something unrelated.
  if (job.status === 'running' && activeJob === job.jobId && alive(job.pid)) {
    try { process.kill(job.pid!, 'SIGKILL'); killed++; } catch { /* gone */ }
  }

  if (job.feynmanRunId) {
    await runFeynman(['research', 'run', 'set-status', job.feynmanRunId, '--status', 'aborted', '--json'], 30000).catch(() => undefined);
    job.runStatus = 'aborted';
  }
  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  job.resumable = false;
  job.error = `Cancelled on request (${killed} process${killed === 1 ? '' : 'es'} stopped)`;
  persistJob(job);
  return job;
}

/** Take ownership of a Feynman run id created elsewhere (e.g. the CLI) so this service can track it. */
export async function adoptFeynmanRun(runId: string): Promise<ResearchJob> {
  const live = await feynmanRunStatus(runId);
  if (live.runStatus === 'done' || live.runStatus === 'aborted') {
    throw new Error(`Feynman run '${runId}' is ${live.runStatus} and cannot be resumed`);
  }
  const job: ResearchJob = {
    jobId: `fey_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    workflow: 'deepresearch',
    topic: live.query || `resumed Feynman run ${runId}`,
    status: 'queued',
    startedAt: new Date().toISOString(),
    resumedAt: new Date().toISOString(),
    feynmanRunId: runId,
    resumable: true,
  };
  jobs.set(job.jobId, job);
  persistJob(job);
  enqueue(job, async () => ['research', 'run', 'resume', runId]);
  return job;
}

/** Report the run's real state from Feynman instead of trusting our own record. */
export async function enrichResearchJob(job: ResearchJob): Promise<ResearchJob> {
  if (isOrphaned(job)) {
    job.status = 'interrupted';
    job.finishedAt = job.finishedAt || new Date().toISOString();
    job.error = job.error || 'No process is running this job any more. It was interrupted; resume it to continue from its first unfinished stage.';
    job.resumable = Boolean(job.feynmanRunId);
    persistJob(job);
  }
  if (!job.feynmanRunId) return job;
  try {
    const live = await feynmanRunStatus(job.feynmanRunId);
    if (live.runStatus && live.runStatus !== job.runStatus) {
      job.runStatus = live.runStatus;
      persistJob(job);
    }
    job.resumeFrom = live.resumeFrom;
    job.resumable = canResume(job) && !['done', 'aborted'].includes(live.runStatus || '');
  } catch {
    // A status probe is best-effort: never fail a job lookup because Feynman would not answer.
  }
  return job;
}

export function getResearchJob(jobId: string): ResearchJob | undefined {
  if (!reconciled) reconcileResearchJobs();
  const inMemory = jobs.get(jobId);
  if (inMemory) return inMemory;
  const onDisk = readJobFile(jobId);
  if (onDisk) jobs.set(jobId, onDisk);
  return onDisk;
}
