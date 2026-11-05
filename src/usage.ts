import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One line of the run log. Only the fields the summary reads are typed; the rest is preserved. */
export interface RunRecord {
  ts?: string;
  kind?: string;
  tool?: string;
  ok?: boolean;
  status?: number;
  duration_ms?: number;
  result_bytes?: number;
  cost_per_min?: number;
  [key: string]: unknown;
}

export function runLogPath(): string {
  return process.env.PHROG_WEB_RUNLOG || join(homedir(), '.local', 'state', 'phrog-web', 'runs.jsonl');
}

/** Tolerate a truncated final line: a half-written record must not break the summary. */
export function readRunLog(limit = 50000, path = runLogPath()): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const out: RunRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec as RunRecord);
    } catch { /* skip the damaged line, keep the rest */ }
  }
  return out;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

/**
 * Usage is reported per endpoint, not per client: loopback /mcp carries no identity, so claiming
 * per-client numbers would be invention. This is what the service can actually account for.
 */
export function summarizeRuns(records: RunRecord[], opts: { days?: number; now?: number } = {}) {
  const days = opts.days && opts.days > 0 ? opts.days : 7;
  const now = opts.now ?? Date.now();
  const since = now - days * 86_400_000;

  const byTool: Record<string, { calls: number; errors: number }> = {};
  const failuresByStatus: Record<string, number> = {};
  let transportFailures = 0;
  const byDay: Record<string, number> = {};
  const durations: number[] = [];
  let ok = 0;
  let failed = 0;
  let browserSessions = 0;

  for (const rec of records) {
    const ts = rec.ts ? Date.parse(rec.ts) : NaN;
    if (!Number.isFinite(ts) || ts < since) continue;

    const tool = rec.tool || rec.kind || 'unknown';
    (byTool[tool] ??= { calls: 0, errors: 0 }).calls += 1;
    if (rec.ok === false) {
      byTool[tool].errors += 1;
      failed += 1;
      failuresByStatus[String(rec.status ?? 'none')] = (failuresByStatus[String(rec.status ?? 'none')] ?? 0) + 1;
      // A rejected /mcp handshake is protocol noise, not a failed capability. Counting it as an error
      // made the headline rate look like half the work was failing when almost none of it was.
      if (tool.includes('/mcp')) transportFailures += 1;
    } else ok += 1;

    const day = rec.ts!.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;

    if (typeof rec.duration_ms === 'number') durations.push(rec.duration_ms);
    if (rec.kind === 'browser.session.open') browserSessions += 1;
  }

  durations.sort((a, b) => a - b);
  const total = ok + failed;

  return {
    window_days: days,
    since: new Date(since).toISOString(),
    total,
    ok,
    failed,
    // Share of *capability* failures: transport rejects on /mcp are reported separately.
    error_rate: total ? Number(((failed - transportFailures) / total).toFixed(3)) : 0,
    failures: { total: failed, transport: transportFailures, capability: failed - transportFailures },
    failures_by_status: failuresByStatus,
    latency_ms: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: durations.at(-1) ?? 0 },
    // The only metered thing the log can count on its own; spend on search/fetch lives in the provider.
    metered: { browser_sessions_opened: browserSessions },
    by_day: byDay,
    top_tools: Object.entries(byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 15)
      .map(([tool, v]) => ({ tool, ...v })),
  };
}
