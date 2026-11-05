import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phrog-jobs-'));
process.env.PHROG_WEB_RESEARCH_JOBS_DIR = dir;
const { getResearchJob, reconcileResearchJobs } = await import('../../src/providers/research.js');

after(() => rmSync(dir, { recursive: true, force: true }));

const jobId = 'fey_1700000000000_abcde';
const write = (job: any) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${job.jobId}.json`), JSON.stringify(job)); };

test('a job written by a previous process is readable from disk', () => {
  write({ jobId, workflow: 'deepresearch', topic: 'x', status: 'completed', startedAt: '2026-01-01T00:00:00Z', deliverable: 'report' });
  const job = getResearchJob(jobId);
  assert.equal(job?.status, 'completed');
  assert.equal(job?.deliverable, 'report');
});

test('a running job whose process is gone is reported interrupted, not running', () => {
  const dead = 'fey_1700000000001_dead0';
  write({ jobId: dead, workflow: 'deepresearch', topic: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z', pid: 999999 });
  reconcileResearchJobs();
  const job = getResearchJob(dead);
  assert.equal(job?.status, 'interrupted');
  assert.match(job?.error ?? '', /service restarted/);
});

test('a running job whose process is alive is left alone', () => {
  const live = 'fey_1700000000002_live0';
  write({ jobId: live, workflow: 'deepresearch', topic: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z', pid: process.pid });
  reconcileResearchJobs();
  assert.equal(getResearchJob(live)?.status, 'running');
});

test('an unknown id is undefined, and a traversal attempt is refused', () => {
  assert.equal(getResearchJob('fey_1700000000003_nope0'), undefined);
  assert.equal(getResearchJob('../../etc/passwd'), undefined);
  assert.equal(getResearchJob('fey_1_x/../../etc/passwd'), undefined);
});
