import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canResume, resumeMode, type ResearchJob } from '../../src/providers/research.js';

function job(over: Partial<ResearchJob>): ResearchJob {
  return {
    jobId: 'fey_1_abcde', topic: 't', mode: 'deep', workflow: 'deepresearch',
    status: 'interrupted', startedAt: new Date().toISOString(), steps: [], sources: [],
    ...over,
  } as ResearchJob;
}

test('only interrupted and failed jobs can be resumed', () => {
  assert.equal(canResume(undefined), false);
  assert.equal(canResume(job({ status: 'completed' })), false);
  assert.equal(canResume(job({ status: 'running' })), false);
  assert.equal(canResume(job({ status: 'cancelled' })), false);
  assert.equal(canResume(job({ status: 'interrupted' })), true);
  assert.equal(canResume(job({ status: 'failed' })), true);
});

test('a job with a Feynman run continues from its checkpoint', () => {
  assert.equal(resumeMode(job({ feynmanRunId: 'r1' })), 'checkpoint');
});

test('a named workflow without a manifest restarts rather than pretending to resume', () => {
  assert.equal(resumeMode(job({ workflow: 'lit' })), 'restart');
});

test('a deepresearch job whose manifest never got created restarts too', () => {
  assert.equal(resumeMode(job({ workflow: 'deepresearch' })), 'restart');
});
