// First-run setup: `pnpm setup` or `node dist/setup.js [--check]`.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';
import { searchBooks, closeBooks } from './providers/books.js';

const ENV_FILE = resolve(homedir(), '.config/phrog-web.env');
const MARKER = resolve(homedir(), '.config/phrog-web.setup-done');
const BACKUP_DIR = resolve(homedir(), 'backups/phrog-web');

const KEYS: { key: string; secret: boolean; hint: string }[] = [
  { key: 'ZLIBRARY_EMAIL', secret: false, hint: 'Z-Library account email' },
  { key: 'ZLIBRARY_PASSWORD', secret: true, hint: 'Z-Library password' },
  { key: 'ANNAS_SECRET_KEY', secret: true, hint: "Anna's Archive membership key (downloads)" },
  { key: 'ANNAS_BASE_URL', secret: false, hint: "Anna's Archive mirror URL (optional)" },
  { key: 'TMDB_API_KEY', secret: true, hint: 'TMDB API key (film ratings)' },
  { key: 'OMDB_API_KEY', secret: true, hint: 'OMDb API key (film ratings)' },
  { key: 'HARDCOVER_API_KEY', secret: true, hint: 'Hardcover API key (book ratings)' },
  { key: 'DISCOGS_TOKEN', secret: true, hint: 'Discogs token (music)' },
  { key: 'X_BEARER_TOKEN', secret: true, hint: 'X (Twitter) bearer token' },
  { key: 'REDLIB_URLS', secret: false, hint: 'Redlib base URLs, comma separated' },
];

function readEnvFile(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return m;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    const i = t.indexOf('=');
    if (!t || t.startsWith('#') || i < 1) continue;
    m.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return m;
}

export function setupDone(): boolean {
  loadConfig();
  return existsSync(MARKER) || KEYS.some((k) => !!process.env[k.key]);
}

function backupOnce() {
  if (!existsSync(ENV_FILE)) return;
  mkdirSync(BACKUP_DIR, { recursive: true });
  copyFileSync(ENV_FILE, resolve(BACKUP_DIR, `phrog-web.env.${Date.now()}`));
  const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('phrog-web.env.')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 3))) unlinkSync(resolve(BACKUP_DIR, f));
}

function ask(rl: ReturnType<typeof createInterface>, q: string, hidden: boolean): Promise<string> {
  return new Promise((res) => {
    const anyRl = rl as any;
    const orig = anyRl._writeToOutput;
    if (hidden) anyRl._writeToOutput = (s: string) => { if (s.includes(q)) orig.call(rl, s); };
    rl.question(q, (a) => {
      anyRl._writeToOutput = orig;
      if (hidden) process.stdout.write('\n');
      res(a.trim());
    });
  });
}

async function prompt() {
  const existing = readEnvFile();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  console.log('phrog-web setup. Press Enter to skip/keep a value. Nothing is required.\n');
  const updates = new Map<string, string>();
  for (const k of KEYS) {
    const has = existing.has(k.key) || !!process.env[k.key];
    const a = await ask(rl, `${k.key} - ${k.hint}${has ? ' [already set]' : ''}: `, k.secret);
    if (a) updates.set(k.key, a);
  }
  rl.close();
  if (updates.size) {
    mkdirSync(resolve(homedir(), '.config'), { recursive: true });
    backupOnce();
    for (const [k, v] of updates) existing.set(k, v);
    writeFileSync(ENV_FILE, [...existing].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    chmodSync(ENV_FILE, 0o600);
    for (const [k, v] of updates) process.env[k] = v;
    console.log(`\nSaved ${updates.size} key(s) to ${ENV_FILE} (mode 600).`);
  }
  writeFileSync(MARKER, new Date().toISOString() + '\n');
}

type Check = [string, () => Promise<string>]; // resolves with detail, throws on failure
const need = (k: string) => { if (!process.env[k]) throw new Error(`${k} not set`); return process.env[k]!; };
const get = async (url: string, init: RequestInit = {}) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
};

async function bookCheck(source: 'zlibrary' | 'annas', keys: string[]): Promise<string> {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`${missing.join(', ')} not set`);
  const r = await searchBooks('test', { limit: 1, sources: [source] });
  if (r.sources_failed.length) throw new Error(r.sources_failed[0].error.slice(0, 160));
  return 'search ok';
}

export async function runChecks(): Promise<boolean> {
  loadConfig();
  const checks: Check[] = [
    ['z-library', () => bookCheck('zlibrary', ['ZLIBRARY_EMAIL', 'ZLIBRARY_PASSWORD'])],
    // Anna search needs no key, but download does; both are reported.
    ['annas', async () => { if (!process.env.ANNAS_SECRET_KEY) throw new Error('ANNAS_SECRET_KEY not set (search may still work, downloads will not)'); return bookCheck('annas', []); }],
    ['tmdb', async () => { await get(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(need('TMDB_API_KEY'))}`); return 'ok'; }],
    ['omdb', async () => { const j: any = await (await get(`https://www.omdbapi.com/?apikey=${encodeURIComponent(need('OMDB_API_KEY'))}&t=heat`)).json(); if (j.Response === 'False') throw new Error(j.Error); return 'ok'; }],
    ['hardcover', async () => { const k = need('HARDCOVER_API_KEY'); await get('https://api.hardcover.app/v1/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: k.startsWith('Bearer ') ? k : `Bearer ${k}` }, body: JSON.stringify({ query: '{ me { id } }' }) }); return 'ok'; }],
    ['discogs', async () => { await get('https://api.discogs.com/database/search?q=nirvana&per_page=1', { headers: { Authorization: `Discogs token=${need('DISCOGS_TOKEN')}`, 'User-Agent': 'phrog-web/0.1' } }); return 'ok'; }],
    ['redlib', async () => {
      const bases = (process.env.REDLIB_URLS || 'http://127.0.0.1:18095').split(',').map((s) => s.trim()).filter(Boolean);
      const errs: string[] = [];
      for (const b of bases) { try { await get(`${b.replace(/\/$/, '')}/r/all.json?limit=1`); return b; } catch (e) { errs.push(`${b}: ${(e as Error).message}`); } }
      throw new Error(errs.join('; '));
    }],
    ['x', async () => { await get('https://api.x.com/2/tweets/search/recent?query=test&max_results=10', { headers: { Authorization: `Bearer ${need('X_BEARER_TOKEN')}` } }); return 'ok'; }],
    ['yt-dlp', () => new Promise((res, rej) => execFile(process.env.YT_DLP_PATH || 'yt-dlp', ['--version'], { timeout: 8000 }, (e, so) => (e ? rej(new Error('yt-dlp not found')) : res(so.trim())))) as Promise<string>],
  ];
  let allOk = true;
  const rows = await Promise.all(checks.map(async ([name, fn]) => {
    try { return [name, true, await fn()] as const; } catch (e) { allOk = false; return [name, false, e instanceof Error ? e.message : String(e)] as const; }
  }));
  console.log('\nSource check');
  for (const [name, ok, detail] of rows) console.log(`${ok ? '✅' : '❌'} ${name.padEnd(10)} ${detail}`);
  await closeBooks();
  return allOk;
}

async function main() {
  loadConfig();
  if (!process.argv.includes('--check')) {
    if (!process.stdin.isTTY) { console.error('Setup needs an interactive terminal. Use --check for check-only.'); process.exit(1); }
    await prompt();
  }
  await runChecks();
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
