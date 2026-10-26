import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** Personal discovery settings, read from the environment at call time. No defaults for secrets. */
export function personalConfig(): { dbPath: string; token: string | null; collectorCmd: string | null; collectorTimeoutMs: number } {
  const t = Number(process.env.PHROG_IG_COLLECTOR_TIMEOUT_S);
  return {
    dbPath: process.env.PHROG_PERSONAL_DB || fileURLToPath(new URL('../data/personal.db', import.meta.url)),
    token: process.env.PHROG_PERSONAL_TOKEN || null,
    collectorCmd: process.env.PHROG_IG_COLLECTOR_CMD || null,
    collectorTimeoutMs: (Number.isFinite(t) && t > 0 ? t : 240) * 1000,
  };
}
