import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface ProviderConfig {
  url?: string;
  primaryUrl?: string;
  fallbackUrl?: string;
  timeoutMs?: number;
  maxChars?: number;
  defaultCategories?: string[];
  binPath?: string;
  outputsDir?: string;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  search: {
    pipeline: string[];
    providers: Record<string, ProviderConfig>;
  };
  fetch: {
    pipeline: string[];
    providers: Record<string, ProviderConfig>;
  };
  research: {
    vane: ProviderConfig;
    feynman: ProviderConfig;
  };
}

let cachedConfig: AppConfig | null = null;

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
  }
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  loadEnvFile(resolve(homedir(), '.config/phrog-web.env'));
  loadEnvFile(resolve(homedir(), '.config/self-hosted-web-mcp.env'));
  loadEnvFile(resolve(process.cwd(), '.env'));

  const configPath = resolve(process.cwd(), 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      cachedConfig = JSON.parse(raw);
      return cachedConfig!;
    } catch (err) {
      console.error('Failed to parse config.json, using defaults', err);
    }
  }

  cachedConfig = {
    server: { host: '127.0.0.1', port: 8890 },
    search: {
      pipeline: ['searxng', 'tinyfish'],
      providers: {
        searxng: { url: 'http://127.0.0.1:8888', timeoutMs: 4500, defaultCategories: ['general'] },
        tinyfish: { url: 'https://api.search.tinyfish.ai', timeoutMs: 5000 },
      },
    },
    fetch: {
      pipeline: ['plain', 'crawl4ai', 'tinyfish'],
      providers: {
        plain: { timeoutMs: 4000, maxChars: 60000 },
        crawl4ai: { primaryUrl: 'http://127.0.0.1:11235', fallbackUrl: 'http://127.0.0.1:11236', timeoutMs: 20000 },
        tinyfish: { url: 'https://api.fetch.tinyfish.ai', timeoutMs: 15000 },
      },
    },
    research: {
      vane: { url: 'http://127.0.0.1:3000', timeoutMs: 120000 },
      feynman: { binPath: 'engines/feynman/bin/feynman.js', outputsDir: 'outputs' },
    },
  };

  return cachedConfig!;
}

/** External Jev runner locations (single place for defaults). Override with JEV_DIR / JEV_RUNNER. */
export function jevPaths(): { jevDir: string; runner: string } {
  const jevDir = process.env.JEV_DIR || resolve(homedir(), 'apps/jev-ultrafast');
  const runner = process.env.JEV_RUNNER || fileURLToPath(new URL('../engines/jev_run.py', import.meta.url));
  return { jevDir, runner };
}

export function personalArtifactsDir(): string {
  return process.env.PHROG_PERSONAL_ARTIFACTS_DIR || resolve(dirname(personalConfig().dbPath), 'artifacts');
}

/** Personal discovery settings, read from the environment at call time. No defaults for secrets. */
export function personalConfig(): { dbPath: string } {
  return {
    dbPath: process.env.PHROG_PERSONAL_DB || fileURLToPath(new URL('../data/personal.db', import.meta.url)),
  };
}

/** RSS/RSSHub feed settings. PHROG_RSSHUB_URL is the local RSSHub base (the only private address feeds may reach). */
export function rssConfig(): { rsshubUrl: string | null; timeoutMs: number } {
  const t = Number(process.env.PHROG_RSS_TIMEOUT_S);
  const u = (process.env.PHROG_RSSHUB_URL || '').trim();
  return { rsshubUrl: /^https?:\/\//i.test(u) ? u : null, timeoutMs: (Number.isFinite(t) && t > 0 ? t : 25) * 1000 };
}

/** Central-import settings: read-only source DB paths (no defaults), account label map, actions that train preferences. */
export function importConfig(): { paths: Record<'social' | 'music' | 'activity' | 'media', string | null>; accountMap: Map<string, string>; learnActions: Set<string> } {
  const e = process.env;
  const map = new Map<string, string>();
  // "instagram:ig-account1=ykswrdn,instagram:ig-account2=phroggingphrog"
  for (const part of (e.PHROG_IMPORT_ACCOUNT_MAP || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const learn = (e.PHROG_IMPORT_LEARN_ACTIONS || 'like,save,comment,share,play,skip,not_interested,dislike').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    paths: {
      social: e.PHROG_IMPORT_SOCIAL_DB || null,
      music: e.PHROG_IMPORT_MUSIC_DB || null,
      activity: e.PHROG_IMPORT_ACTIVITY_DB || null,
      media: e.PHROG_IMPORT_MEDIA_DB || null,
    },
    accountMap: map,
    learnActions: new Set(learn),
  };
}
