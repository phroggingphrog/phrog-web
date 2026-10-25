import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, jevPaths } from '../config.js';

export interface BrowseArgs {
  url: string;
  goal: string;
  max_seconds?: number;
  max_chars?: number;
}

export function omnirouteKey(): string {
  loadConfig();
  if (process.env.OMNIROUTE_API_KEY) return process.env.OMNIROUTE_API_KEY;
  const f = join(homedir(), '.config/llm-gateway/keys.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.startsWith('OMNIROUTE_API_KEY=')) return line.slice(18).trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('OMNIROUTE_API_KEY not found');
}

/** Goal-driven browsing via the same Jev runner the Python web agent uses (separate throwaway headless Chromium). */
export async function browse(args: BrowseArgs): Promise<Record<string, any>> {
  loadConfig();
  const { url, goal } = args;
  const maxSeconds = args.max_seconds ?? 90;
  const maxChars = args.max_chars ?? 6000;
  if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://');
  if (!goal.trim() || goal.length > 2000) throw new Error('goal must be 1-2000 characters');
  const key = (process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  if (!key) throw new Error('browse needs a Jev decision key: set OPENROUTER_API_KEY or TYPESAFE_API_KEY in ~/.config/self-hosted-web-mcp.env');

  const { jevDir, runner } = jevPaths();
  const py = join(jevDir, '.venv/bin/python');
  if (!existsSync(runner) || !existsSync(py)) {
    throw new Error(`browse is unavailable: Jev runner not found (runner=${runner}, python=${py}). Set JEV_RUNNER and JEV_DIR.`);
  }
  const env = {
    ...process.env,
    BU_CDP_URL: process.env.BU_CDP_URL || 'http://127.0.0.1:9222',
    BH_TELEMETRY: '0', BROWSER_HARNESS_TELEMETRY: '0', ANONYMIZED_TELEMETRY: '0',
    TYPESAFE_API_KEY: key,
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL || 'https://openrouter.ai/api',
    TYPESAFE_MODEL: process.env.TYPESAFE_MODEL || 'jev-latest',
    TEXT_MODEL_BASE_URL: process.env.WEB_AGENT_LLM_BASE_URL || 'http://127.0.0.1:20128/v1',
    TEXT_MODEL: process.env.WEB_AGENT_LLM_MODEL || 'deepseek-flash',
    TEXT_MODEL_API_KEY: omnirouteKey(),
    TEXT_MODEL_REASONING: 'none',
  };
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const p = spawn(py, [runner], { cwd: jevDir, env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`browse did not finish within ${maxSeconds + 60}s`)); }, (maxSeconds + 60) * 1000);
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', c => { clearTimeout(timer); resolve({ stdout, stderr, code: c }); });
    p.stdin.end(JSON.stringify({ url, goal, max_seconds: maxSeconds, max_chars: maxChars }));
  });
  const line = stdout.split('\n').filter(l => l.startsWith('{')).pop();
  if (!line) throw new Error(`Jev runner produced no result (exit ${code}): ${stderr.slice(-300)}`);
  const result = JSON.parse(line);
  if (!result.ok) throw new Error(result.error || 'unknown Jev error');
  return result;
}
