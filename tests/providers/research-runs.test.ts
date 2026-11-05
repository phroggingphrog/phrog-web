import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeynmanJson, resumeStepOf, canResume, isOrphaned } from '../../src/providers/research.js';
import type { ResearchJob } from '../../src/providers/research.js';

const banner = '     ██████\n  Research-first agent shell built on Pi.\n';

test('JSON is extracted past the banner and before trailing log lines', () => {
  const out = `${banner}{"id":"abc-123","status":"queued"}\n[next] doing something\n`;
  assert.deepEqual(parseFeynmanJson(out), { id: 'abc-123', status: 'queued' });
});

test('nested objects and braces inside strings are handled', () => {
  const out = `${banner}{"a":{"b":{"c":1}},"note":"contains } and { braces"}\n`;
  assert.deepEqual(parseFeynmanJson(out), { a: { b: { c: 1 } }, note: 'contains } and { braces' });
});

test('output with no JSON is an explicit error, not a silent undefined', () => {
  assert.throws(() => parseFeynmanJson('nothing here'), /no JSON object/);
  assert.throws(() => parseFeynmanJson('{"open": 1'), /unterminated/);
});

test('the resume point is the first stage that is not finished', () => {
  const manifest = { stepOrder: ['plan', 'search', 'draft', 'critique'], steps: { plan: 'done', search: 'done', draft: 'running', critique: 'queued' } };
  assert.equal(resumeStepOf(manifest), 'draft');
});

test('a finished or unknown stage map yields no resume point', () => {
  assert.equal(resumeStepOf({ stepOrder: ['a'], steps: { a: 'done' } }), undefined);
  assert.equal(resumeStepOf({}), undefined);
  assert.equal(resumeStepOf(null), undefined);
});

test('only interrupted or failed jobs with a run id are resumable', () => {
  const base = { jobId: 'fey_1_abcde', workflow: 'deepresearch', topic: 't', startedAt: 'now' } as ResearchJob;
  assert.equal(canResume({ ...base, status: 'interrupted', feynmanRunId: 'run-1' }), true);
  assert.equal(canResume({ ...base, status: 'failed', feynmanRunId: 'run-1' }), true);
  assert.equal(canResume({ ...base, status: 'completed', feynmanRunId: 'run-1' }), false);
  assert.equal(canResume({ ...base, status: 'interrupted' }), false);
  assert.equal(canResume(undefined), false);
});

test('real Feynman steps are objects with a status field', () => {
  const manifest = {
    stepOrder: ['1', '2', '3'],
    steps: { '1': { status: 'done', message: 'classified' }, '2': { status: 'running' }, '3': { status: 'queued' } },
  };
  assert.equal(resumeStepOf(manifest), '2');
  assert.equal(resumeStepOf({ stepOrder: ['1'], steps: { '1': { status: 'done' } } }), undefined);
});

test('a running record with no live process is an orphan', () => {
  const base = { jobId: 'fey_1_abcde', workflow: 'deepresearch', topic: 't', startedAt: 'now' } as ResearchJob;
  assert.equal(isOrphaned({ ...base, status: 'running', pid: 999999 }), true);
  assert.equal(isOrphaned({ ...base, status: 'running', pid: process.pid }), false);
  assert.equal(isOrphaned({ ...base, status: 'completed', pid: 999999 }), false);
  assert.equal(isOrphaned(undefined), false);
});
