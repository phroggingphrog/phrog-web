import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../config.js';

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
  sources?: string[];
  instructions?: string;
  optimizationMode?: 'speed' | 'balanced' | 'quality';
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

// 1. Quick Research (Vane Engine with Academic / Multi-Domain support)
export async function executeQuickResearch(
  question: string,
  options: QuickResearchOptions = {}
): Promise<QuickResearchResponse> {
  const config = loadConfig();
  const vaneUrl = config.research?.vane?.url || 'http://127.0.0.1:3000';
  const timeoutMs = config.research?.vane?.timeoutMs || 120000;

  // Resolve sources
  let sources = ['web'];
  if (options.sources?.length) {
    sources = options.sources;
  } else if (options.domain === 'academic') {
    sources = ['academic'];
  } else if (options.domain === 'discussions') {
    sources = ['discussions'];
  } else if (options.domain === 'all') {
    sources = ['web', 'academic', 'discussions'];
  }

  const res = await fetch(`${vaneUrl}/api/search`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatModel: { providerId: 'omniroute', key: 'deepseek-flash' },
      embeddingModel: { providerId: '15a56ef4-b6da-49c0-b2e4-8f865dac9d39', key: 'Xenova/all-MiniLM-L6-v2' },
      optimizationMode: options.optimizationMode || 'balanced',
      sources,
      query: question,
      history: [],
      stream: false,
      systemInstructions: options.instructions || '',
    }),
  });

  if (!res.ok) {
    throw new Error(`Vane HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  if (!data.message) {
    throw new Error('Vane returned an empty answer');
  }

  const citations: ResearchCitation[] = (data.sources || []).map((s: any, i: number) => ({
    n: i + 1,
    title: s.metadata?.title || s.title || '',
    url: s.metadata?.url || s.url || '',
  }));

  return {
    mode: 'quick',
    domain: options.domain || 'web',
    question,
    answer: data.message,
    citations,
    provider_used: 'vane',
  };
}

// 2. Deep Research (Headless Feynman Autonomous Agent)
export function dispatchDeepResearch(
  topic: string,
  options: { workflow?: string; domain?: string; callbackUrl?: string } = {}
): ResearchJob {
  const jobId = `fey_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workflow = options.workflow || 'deepresearch';
  const feynmanBin = resolve(process.cwd(), 'engines/feynman/bin/feynman.js');

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

  // Ensure outputs directory exists
  const outputsDir = resolve(process.cwd(), 'outputs');
  if (!existsSync(outputsDir)) {
    mkdirSync(outputsDir, { recursive: true });
  }

  // Spawn headless Feynman process
  try {
    const child = spawn(process.execPath, [feynmanBin, workflow, topic], {
      cwd: resolve(process.cwd(), 'engines/feynman'),
      env: { ...process.env, CI: 'true', NONINTERACTIVE: 'true' },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    job.pid = child.pid;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', async (exitCode) => {
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();

      if (exitCode === 0) {
        job.status = 'completed';
        job.deliverable = findLatestDeliverable(resolve(process.cwd(), 'engines/feynman/outputs')) || stdout;
      } else {
        job.status = 'failed';
        job.error = stderr || `Process exited with code ${exitCode}`;
      }

      // If callbackUrl was supplied, wake up the caller
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

function findLatestDeliverable(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.endsWith('.provenance.md'));
  if (files.length === 0) return undefined;
  const newest = files[files.length - 1];
  return readFileSync(join(dir, newest), 'utf8');
}
