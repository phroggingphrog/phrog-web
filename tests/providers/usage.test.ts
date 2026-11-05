import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunLog, summarizeRuns } from '../../src/usage.js';

const now = Date.parse('2026-11-06T00:00:00Z');
const day = 86_400_000;
const rec = (over: any = {}) => ({ ts: new Date(now - 1000).toISOString(), tool: 'fetch', ok: true, duration_ms: 10, ...over });

const dir = mkdtempSync(join(tmpdir(), 'phrog-usage-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('records outside the window are excluded', () => {
  const s = summarizeRuns([rec(), rec({ ts: new Date(now - 9 * day).toISOString() })], { days: 7, now });
  assert.equal(s.total, 1);
  assert.equal(s.window_days, 7);
});

test('failures are counted per tool and in the error rate', () => {
  const s = summarizeRuns([rec(), rec({ ok: false }), rec({ tool: 'search' })], { now });
  assert.equal(s.failed, 1);
  assert.equal(s.ok, 2);
  assert.equal(s.error_rate, 0.333);
  assert.equal(s.top_tools.find(t => t.tool === 'fetch')?.errors, 1);
});

test('the busiest endpoint leads the list', () => {
  const s = summarizeRuns([rec({ tool: 'search' }), rec({ tool: 'search' }), rec({ tool: 'fetch' })], { now });
  assert.equal(s.top_tools[0].tool, 'search');
  assert.equal(s.top_tools[0].calls, 2);
});

test('latency percentiles come from the observed durations', () => {
  const s = summarizeRuns(Array.from({ length: 10 }, (_, i) => rec({ duration_ms: i * 10 })), { now });
  assert.equal(s.latency_ms.max, 90);
  assert.ok(s.latency_ms.p50 <= s.latency_ms.p95);
});

test('a rejected /mcp handshake is transport noise, not a capability failure', () => {
  const s = summarizeRuns([
    rec({ tool: 'fetch' }),
    rec({ tool: 'POST /mcp', ok: false, status: 400 }),
    rec({ tool: 'GET /mcp', ok: false, status: 406 }),
  ], { now });
  assert.equal(s.failures.total, 2);
  assert.equal(s.failures.transport, 2);
  assert.equal(s.failures.capability, 0);
  assert.equal(s.error_rate, 0);
  assert.equal(s.failures_by_status['400'], 1);
});

test('a real tool failure still shows up in the capability rate', () => {
  const s = summarizeRuns([rec(), rec({ ok: false, status: 502 })], { now });
  assert.equal(s.failures.capability, 1);
  assert.equal(s.error_rate, 0.5);
});

test('opened browser sessions are counted, since they are the thing that bills', () => {
  const s = summarizeRuns([rec({ kind: 'browser.session.open', tool: undefined })], { now });
  assert.equal(s.metered.browser_sessions_opened, 1);
});

test('a damaged log line is skipped instead of breaking the read', () => {
  const file = join(dir, 'runs.jsonl');
  writeFileSync(file, `${JSON.stringify(rec())}\n{"truncated": \n${JSON.stringify(rec({ tool: 'search' }))}\n`);
  const rows = readRunLog(100, file);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].tool, 'search');
});

test('a missing log file is an empty read, not an exception', () => {
  assert.deepEqual(readRunLog(10, join(dir, 'nope.jsonl')), []);
});
