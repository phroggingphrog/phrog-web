// Books: thin MCP client bridge to engines/zlibrary-mcp (Z-Library, Anna's Archive, LibGen).
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../config.js';

export interface BookHit {
  title: string;
  authors?: string;
  year?: string;
  language?: string;
  format?: string;
  size?: string;
  ref?: string;
  url?: string;
  source: string;
}

export interface BooksResult {
  query: string;
  results: BookHit[];
  sources_used: string[];
  sources_failed: { source: string; error: string }[];
}

export type BookSource = 'zlibrary' | 'annas' | 'libgen';
const ALL_SOURCES: BookSource[] = ['zlibrary', 'annas'];
const CALL_TIMEOUT_MS = 12000;
const DOWNLOAD_TIMEOUT_MS = 180000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE_DIR = resolve(REPO_ROOT, 'engines/zlibrary-mcp');

export function downloadsDir(): string {
  loadConfig();
  const dir = process.env.PHROG_WEB_DOWNLOADS || resolve(REPO_ROOT, 'downloads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!existsSync(resolve(ENGINE_DIR, 'dist/index.js'))) {
      throw new Error('engines/zlibrary-mcp is not built (run `npm install && npm run build` and `uv sync --no-dev` inside it)');
    }
    loadConfig();
    const env: Record<string, string> = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' };
    for (const k of ['ZLIBRARY_EMAIL', 'ZLIBRARY_PASSWORD', 'ZLIBRARY_EAPI_DOMAIN', 'ANNAS_SECRET_KEY', 'ANNAS_BASE_URL']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    env.ZLIBRARY_OUTPUT_ROOT = downloadsDir();
    const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], cwd: ENGINE_DIR, env, stderr: 'ignore' });
    const c = new Client({ name: 'phrog-web', version: '0.1.0' });
    transport.onclose = () => { client = null; };
    await c.connect(transport);
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function errText(sc: any, fallback: string): string {
  const e = sc?.error;
  if (!e) return fallback;
  const att = (e.attempts || []).map((a: any) => `${a.source}:${a.code || a.outcome}${a.reason ? `(${a.reason})` : ''}`).join(', ');
  return `${e.code}: ${e.message}${att ? ` [${att}]` : ''}`;
}

async function call(name: string, args: Record<string, unknown>, timeout = CALL_TIMEOUT_MS): Promise<any> {
  const c = await getClient();
  const res: any = await c.callTool({ name, arguments: args }, undefined, { timeout });
  const sc = res.structuredContent ?? (() => { try { return JSON.parse(res.content?.[0]?.text || ''); } catch { return null; } })();
  if (res.isError) throw new Error(errText(sc, String(res.content?.[0]?.text || 'MCP error')));
  return sc;
}

const toHit = (r: any, source: string): BookHit => ({
  title: r.title,
  authors: r.author,
  year: r.year != null ? String(r.year) : undefined,
  language: r.language,
  format: r.format,
  size: r.size_mb != null ? `${r.size_mb}MB` : undefined,
  ref: r.ref,
  source,
});

export async function searchBooks(query: string, opts: { limit?: number; sources?: BookSource[] } = {}): Promise<BooksResult> {
  const limit = opts.limit ?? 20;
  const out: BooksResult = { query, results: [], sources_used: [], sources_failed: [] };
  await Promise.all(
    (opts.sources?.length ? opts.sources : ALL_SOURCES).map(async (source) => {
      try {
        const sc = await call('search', { query, sources: [source], limit: Math.min(limit, 50) });
        out.sources_used.push(source);
        out.results.push(...(sc?.rows || []).map((r: any) => toHit(r, source)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.sources_failed.push({
          source,
          error: /credentials_missing/.test(msg) ? `not configured: set credentials via \`pnpm setup\` (${msg})` : msg,
        });
      }
    }),
  );
  out.results = out.results.slice(0, limit);
  return out;
}

const MD5 = /^[0-9a-f]{32}$/i;

// ref = opaque ref from a current searchBooks row; an md5/id is resolved by searching the source first.
export async function downloadBook(ref: string, opts: { source?: BookSource } = {}): Promise<{ path: string; bytes?: number; source?: string }> {
  let useRef = ref;
  if (MD5.test(ref) || /^\d+$/.test(ref)) {
    const source = opts.source || 'annas';
    const sc = await call('search', { query: ref, sources: [source], limit: 1 });
    useRef = sc?.rows?.[0]?.ref;
    if (!useRef) throw new Error(`no ${source} result for id ${ref}`);
  }
  const sc = await call('download', { ref: useRef, output_dir: downloadsDir() }, DOWNLOAD_TIMEOUT_MS);
  return { path: sc.path, bytes: sc.bytes, source: opts.source };
}

// Local capability report (no network); used by setup --check.
export async function bookLimits(): Promise<any> {
  return call('get_limits', {});
}

export async function closeBooks(): Promise<void> {
  await client?.close().catch(() => {});
  client = null;
}
