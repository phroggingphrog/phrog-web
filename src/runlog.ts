// JSON-lines run log for MCP tool calls and REST /api/* calls. Secrets are redacted; file rotates at ~10MB (keep 3).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;
const SECRET = /key|token|secret|password|auth|cookie/i;

export const runLogPath = () => process.env.PHROG_WEB_RUNLOG || join(homedir(), '.local/state/phrog-web/runs.jsonl');

export function summarize(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}...(${v.length} chars)` : v;
  if (v == null || typeof v !== 'object') return v;
  if (depth > 3) return '[nested]';
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => summarize(x, depth + 1)).concat(v.length > 10 ? [`...+${v.length - 10} more`] : []);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.test(k) ? '[redacted]' : summarize(val, depth + 1);
  return out;
}

const rotate = (file: string) => {
  try {
    if (statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    renameSync(file, `${file}.1`);
  } catch { /* no file yet */ }
};

export function writeRun(rec: Record<string, unknown>): void {
  try {
    const file = runLogPath();
    mkdirSync(dirname(file), { recursive: true });
    rotate(file);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch { /* logging must never break a call */ }
}

// Pull provider info out of a result object (or its JSON string).
export function resultInfo(result: unknown): Record<string, unknown> {
  let obj: any = result;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return {}; } }
  if (!obj || typeof obj !== 'object') return {};
  const o = Array.isArray(obj) ? obj[0] ?? {} : obj;
  const info: Record<string, unknown> = {};
  for (const k of ['provider_used', 'fetcher', 'sources_used', 'escalated_to']) if (o[k] != null) info[k] = o[k];
  if (info.provider_used == null && o.provider != null) info.provider_used = o.provider;
  return info;
}

export function shortError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

// Wrap an MCP tool handler (args) => MCP result; logs one record per call.
export function logged<A, R>(tool: string, fn: (a: A) => Promise<R>): (a: A) => Promise<R> {
  return async (a: A) => {
    const t0 = Date.now();
    try {
      const r: any = await fn(a);
      const t = r?.content?.[0]?.text;
      const isErr = !!r?.isError;
      writeRun({
        kind: 'mcp', tool, args: summarize(a), duration_ms: Date.now() - t0, ok: !isErr,
        ...(isErr ? { error: shortError(t) } : resultInfo(t)), result_bytes: typeof t === 'string' ? Buffer.byteLength(t) : 0,
      });
      return r;
    } catch (e) {
      writeRun({ kind: 'mcp', tool, args: summarize(a), duration_ms: Date.now() - t0, ok: false, error: shortError(e) });
      throw e;
    }
  };
}

export function recentRuns(limit = 50, tool?: string): unknown[] {
  const file = runLogPath();
  const lines: string[] = [];
  for (const f of [`${file}.1`, file]) { try { lines.push(...readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch { /* absent */ } }
  const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sel = tool ? recs.filter((r: any) => r.tool === tool) : recs;
  return sel.slice(-Math.max(1, Math.min(limit, 500))).reverse();
}
