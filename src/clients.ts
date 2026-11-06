/**
 * Per-client identity for the MCP door and the metered REST routes.
 *
 * The problem this solves: /mcp accepted any request from anywhere that could reach the port, so Builder
 * credit could be spent by anything on the box (or the VM bridge) and the usage report could not say who
 * called. A token per client fixes both: it decides who may call, and it stamps every run with who did.
 *
 * Tokens are stored as SHA-256 hashes. The plaintext is shown once, at creation, and never returned again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ClientRecord {
  hash: string;
  created_at: string;
  last_seen?: string;
  calls?: number;
}

interface Registry {
  version: 1;
  clients: Record<string, ClientRecord>;
}

export function clientsPath(): string {
  return process.env.PHROG_WEB_CLIENTS_FILE || join(homedir(), '.config', 'phrog-web', 'clients.json');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// The registry is read on every request, so it is cached and only re-read when the file changes. Usage
// counters are then flushed at most once every few seconds instead of rewriting the file per call.
let cached: { mtimeMs: number; reg: Registry } | undefined;
let flushTimer: NodeJS.Timeout | undefined;
let dirty = false;

function load(): Registry {
  let mtimeMs = 0;
  try { mtimeMs = statSync(clientsPath()).mtimeMs; } catch { /* absent */ }
  if (cached && cached.mtimeMs === mtimeMs) return cached.reg;
  let reg: Registry = { version: 1, clients: {} };
  try {
    const raw = JSON.parse(readFileSync(clientsPath(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.clients) reg = { version: 1, clients: raw.clients };
  } catch { /* absent or unreadable reads as empty */ }
  cached = { mtimeMs, reg };
  return reg;
}

function flush(): void {
  if (!dirty || !cached) return;
  dirty = false;
  try {
    save(cached.reg);
    cached = { mtimeMs: statSync(clientsPath()).mtimeMs, reg: cached.reg };
  } catch { /* attribution must never break a call */ }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = undefined; flush(); }, 3000);
  // Never hold the process open just to write a counter.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function save(reg: Registry): void {
  const file = clientsPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Create (or rotate) a client. The token is returned once and never again. */
export function createClient(name: string): { name: string; token: string; created_at: string; rotated: boolean } {
  if (!NAME_PATTERN.test(name)) {
    throw new Error('Client name must be 1-32 chars of a-z, 0-9, dot, dash or underscore');
  }
  const reg = load();
  const rotated = Boolean(reg.clients[name]);
  const token = randomBytes(24).toString('base64url');
  const created_at = new Date().toISOString();
  reg.clients[name] = { hash: hashToken(token), created_at };
  save(reg);
  cached = { mtimeMs: statSync(clientsPath()).mtimeMs, reg };
  return { name, token, created_at, rotated };
}

export function listClients(): Array<{ name: string; created_at: string; last_seen?: string; calls: number }> {
  const reg = load();
  return Object.entries(reg.clients)
    .map(([name, rec]) => ({ name, created_at: rec.created_at, last_seen: rec.last_seen, calls: rec.calls ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function revokeClient(name: string): boolean {
  const reg = load();
  if (!reg.clients[name]) return false;
  delete reg.clients[name];
  save(reg);
  cached = { mtimeMs: statSync(clientsPath()).mtimeMs, reg };
  return true;
}

/** Which client owns this token, and record the use. */
export function resolveToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const reg = load();
  const wanted = hashToken(token.trim());
  for (const [name, rec] of Object.entries(reg.clients)) {
    if (rec.hash === wanted) {
      rec.last_seen = new Date().toISOString();
      rec.calls = (rec.calls ?? 0) + 1;
      reg.clients[name] = rec;
      dirty = true;
      scheduleFlush();
      return name;
    }
  }
  return undefined;
}

export type AuthMode = 'off' | 'warn' | 'enforce';

/**
 * off     — ignore tokens entirely (pre-identity behaviour)
 * warn    — accept anonymous calls but record them as such, so a report shows the gap (default)
 * enforce — missing or unknown token is 401
 */
export function authMode(): AuthMode {
  const raw = (process.env.PHROG_WEB_MCP_AUTH || 'warn').toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'warn';
}

export function tokenFromHeaders(headers: Record<string, unknown>): string | undefined {
  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    // A literal "${VAR}" from an unexpanded config is not a token; treat it as absent rather than unknown.
    const value = m ? m[1] : auth.trim();
    if (!value.startsWith('${')) return value;
  }
  const direct = headers['x-phrog-client'];
  if (typeof direct === 'string' && direct.trim() && !direct.trim().startsWith('${')) return direct.trim();
  return undefined;
}
