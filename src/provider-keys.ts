/**
 * The hub's key registry.
 *
 * Purpose (owner, 2026-11-05): phrog-web is the one place API keys live. Callers — Hermes
 * profiles, dsh, the job crawler, ad-hoc curl — authenticate to phrog-web with its own token and
 * never hold upstream provider keys. Adding a provider key means one POST here, no restart, no
 * pasting the same secret into five configs.
 *
 * Rules:
 *  - The env file is the store: mode 0600, written atomically, previous copy backed up.
 *  - Values are never returned, logged or echoed. GET reports only whether a key is configured.
 *  - Hot reload: setKey() updates process.env so the running service uses the new value at once.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ProviderKeySpec {
  /** Environment variable name, which is also the store key. */
  key: string;
  /** Which provider/capability this unlocks, for the hub's own listing. */
  provider: string;
  secret: boolean;
  hint: string;
  /** Plan label where a provider bills differently (TinyFish free vs paid). */
  plan?: 'free' | 'paid';
}

export const PROVIDER_KEYS: ProviderKeySpec[] = [
  { key: 'TINYFISH_API_KEY', provider: 'tinyfish', secret: true, hint: 'TinyFish Builder key (paid: agent/browser work)', plan: 'paid' },
  { key: 'TINYFISH_API_KEY_2', provider: 'tinyfish', secret: true, hint: 'TinyFish Hobby key (free: search/fetch try this first)', plan: 'free' },
  { key: 'FIRECRAWL_API_KEY', provider: 'firecrawl', secret: true, hint: 'Firecrawl key (direct, before omniroute/tunnel)' },
  { key: 'OMNIROUTE_API_KEY', provider: 'omniroute', secret: true, hint: 'omniroute key (search fan-out + rerank models)' },
  { key: 'CONSENSUS_API_KEY', provider: 'consensus', secret: true, hint: 'Consensus key (academic search)' },
  { key: 'TMDB_API_KEY', provider: 'tmdb', secret: true, hint: 'TMDB API key (film ratings)' },
  { key: 'OMDB_API_KEY', provider: 'omdb', secret: true, hint: 'OMDb API key (film ratings)' },
  { key: 'HARDCOVER_API_KEY', provider: 'hardcover', secret: true, hint: 'Hardcover API key (book ratings)' },
  { key: 'DISCOGS_TOKEN', provider: 'discogs', secret: true, hint: 'Discogs token (music)' },
  { key: 'X_BEARER_TOKEN', provider: 'x', secret: true, hint: 'X (Twitter) bearer token' },
  { key: 'ZLIBRARY_EMAIL', provider: 'zlibrary', secret: false, hint: 'Z-Library account email' },
  { key: 'ZLIBRARY_PASSWORD', provider: 'zlibrary', secret: true, hint: 'Z-Library password' },
  { key: 'ANNAS_SECRET_KEY', provider: 'annas', secret: true, hint: "Anna's Archive membership key (downloads)" },
  { key: 'ANNAS_BASE_URL', provider: 'annas', secret: false, hint: "Anna's Archive mirror URL" },
  { key: 'PHROG_LOCATION', provider: 'local', secret: false, hint: 'Suburb/city for local results' },
  { key: 'REDLIB_URLS', provider: 'reddit', secret: false, hint: 'Redlib base URLs, comma separated' },
];

const SPECS = new Map(PROVIDER_KEYS.map((s) => [s.key, s]));

export function envFilePath(): string {
  return process.env.PHROG_WEB_ENV_FILE || resolve(homedir(), '.config/phrog-web.env');
}

/** Parse the env file into ordered [key, value] pairs, preserving comments and order. */
export function readEnvLines(file = envFilePath()): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n');
}

export interface KeyStatus {
  key: string;
  provider: string;
  secret: boolean;
  hint: string;
  plan?: 'free' | 'paid';
  configured: boolean;
  /** Length only — enough to spot a truncated paste without revealing the secret. */
  length: number;
  source: 'env-file' | 'process' | 'none';
}

/** Configured state for every known key. Values are never read out to the caller. */
export function keyStatus(file = envFilePath()): KeyStatus[] {
  const fromFile = new Map<string, string>();
  for (const line of readEnvLines(file)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    fromFile.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return PROVIDER_KEYS.map((spec) => {
    const fileVal = (fromFile.get(spec.key) ?? '').trim();
    const procVal = (process.env[spec.key] ?? '').trim();
    const value = fileVal || procVal;
    return {
      ...spec,
      configured: value.length > 0,
      length: value.length,
      source: fileVal ? 'env-file' : procVal ? 'process' : 'none',
    };
  });
}

function backupEnv(file: string): void {
  if (!existsSync(file)) return;
  const dir = resolve(homedir(), 'backups/phrog-web');
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, resolve(dir, `phrog-web.env.${Date.now()}`));
}

/** Write the env file atomically, preserving every other line exactly. */
function writeEnv(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  renameSync(tmp, file);
}

export function setKey(key: string, value: string, file = envFilePath()): KeyStatus {
  const spec = SPECS.get(key);
  if (!spec) throw new Error(`unknown key: ${key}. Known keys: ${[...SPECS.keys()].join(', ')}`);
  const clean = value.trim();
  if (!clean) throw new Error('value must not be empty');
  if (/\s/.test(clean)) throw new Error('value must not contain whitespace');
  backupEnv(file);
  const lines = readEnvLines(file);
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  const row = `${key}=${clean}`;
  if (idx >= 0) lines[idx] = row; else lines.push(row);
  writeEnv(file, lines);
  process.env[key] = clean; // hot reload: no restart needed
  return keyStatus(file).find((s) => s.key === key)!;
}

export function removeKey(key: string, file = envFilePath()): boolean {
  if (!SPECS.has(key)) throw new Error(`unknown key: ${key}`);
  const lines = readEnvLines(file);
  const kept = lines.filter((l) => !l.trim().startsWith(`${key}=`));
  if (kept.length === lines.length && !process.env[key]) return false;
  backupEnv(file);
  writeEnv(file, kept);
  delete process.env[key];
  return true;
}
