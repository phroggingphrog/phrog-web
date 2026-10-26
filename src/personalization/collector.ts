import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export const ACCOUNT_RE = /^[A-Za-z0-9._]{1,30}$/;
// Instagram next_max_id is base64-like and can contain + and /; the remote shell receives it single-quoted.
export const CURSOR_RE = /^[A-Za-z0-9_\-=:.|+/]{1,512}$/;

export const COLLECTOR_STATUSES = ['ok', 'end', 'auth_required', 'challenge', 'rate_limited', 'busy', 'unsupported', 'failed'] as const;
export type CollectorStatus = (typeof COLLECTOR_STATUSES)[number];

export interface CollectorResult {
  status: CollectorStatus;
  cursor: string | null;
  next_cursor: string | null;
  fetched_at: string | null;
  error: string | null;
  items: any[];
}

/** Split a command line into argv: whitespace separated, with '...' and "..." grouping. No shell is involved. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (quote) throw new Error('Unterminated quote in collector command');
  if (has || cur) out.push(cur);
  return out;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const fail = (error: string): CollectorResult => ({ status: 'failed', cursor: null, next_cursor: null, fetched_at: null, error, items: [] });

export function runCollector(cmd: string | null, timeoutMs: number, args: { account: string; limit: number; cursor?: string | null }): Promise<CollectorResult> {
  if (!cmd) return Promise.resolve(fail('PHROG_IG_COLLECTOR_CMD is not configured'));
  let argv: string[];
  try { argv = splitCommand(cmd); } catch (e) { return Promise.resolve(fail((e as Error).message)); }
  if (argv.length === 0) return Promise.resolve(fail('PHROG_IG_COLLECTOR_CMD is empty'));
  // ssh joins its arguments and re-parses them on the remote shell, so quote them there.
  const remote = basename(argv[0]) === 'ssh';
  const arg = (s: string) => (remote ? shQuote(s) : s);
  const extra = ['--account', arg(args.account), '--limit', String(args.limit)];
  if (args.cursor) extra.push('--cursor', arg(args.cursor));
  const [file, ...rest] = argv;

  return new Promise((resolve) => {
    execFile(file, [...rest, ...extra], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const e = err as any;
        if (e.killed || e.signal === 'SIGTERM') return resolve(fail(`collector timed out after ${Math.round(timeoutMs / 1000)}s`));
        // A collector may exit non-zero but still print its JSON status; prefer that.
        const parsed = parse(stdout);
        if (parsed) return resolve(parsed);
        return resolve(fail(`collector failed: ${(e.code ?? e.message ?? 'error').toString().slice(0, 100)}`));
      }
      resolve(parse(stdout) ?? fail('collector returned non-JSON output'));
    });
  });
}

function parse(stdout: string): CollectorResult | null {
  let o: any;
  try { o = JSON.parse(stdout); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (!COLLECTOR_STATUSES.includes(o.status)) return fail(`collector returned unknown status ${JSON.stringify(String(o.status)).slice(0, 40)}`);
  const items = Array.isArray(o.items) ? o.items : [];
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  if (o.status === 'ok' && items.length === 0) return fail('collector returned ok with no items');
  return {
    status: o.status,
    cursor: str(o.cursor),
    next_cursor: str(o.next_cursor),
    fetched_at: str(o.fetched_at),
    error: str(o.error)?.slice(0, 300) ?? null,
    items: o.status === 'ok' || o.status === 'end' ? items : [],
  };
}
