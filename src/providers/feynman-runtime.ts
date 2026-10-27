import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';

const engine = fileURLToPath(new URL('../../engines/feynman/bin/feynman.js', import.meta.url));
let starting: Promise<string> | undefined;
let child: ChildProcess | undefined;

export function feynmanRuntime() {
  loadConfig();
  const root = resolve(process.env.PHROG_FEYNMAN_DATA_DIR || resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local/share'), 'phrog-web/feynman'));
  return { root, engine, env: { ...process.env, FEYNMAN_HOME: root, FEYNMAN_CLI: engine } };
}

export function embeddedFeynmanUrl(): Promise<string> {
  if (starting) return starting;
  starting = (async () => {
    const { root, engine, env } = feynmanRuntime();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const proc = spawn(process.execPath, [engine, 'mcp', '--mcp-host', '127.0.0.1', '--mcp-port', '0'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    proc.once('exit', () => { if (child === proc) { child = undefined; starting = undefined; } });
    proc.stderr?.resume();
    const url = await new Promise<string>((done, fail) => {
      let output = '';
      let settled = false;
      const timer = setTimeout(() => { proc.kill(); failed(new Error('Embedded Feynman startup timed out')); }, 30000);
      const failed = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fail(error);
      };
      proc.once('error', failed);
      proc.once('exit', code => failed(new Error(`Embedded Feynman exited during startup (${code}); check the embedded engine setup`)));
      proc.stdout?.on('data', chunk => {
        output = (output + String(chunk)).slice(-8192);
        const match = output.match(/Feynman MCP listening at (http:\/\/127\.0\.0\.1:\d+\/mcp) for /);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          done(match[1]);
        }
      });
    });
    proc.unref();
    (proc.stdout as Socket | null)?.unref();
    (proc.stderr as Socket | null)?.unref();
    return url;
  })().catch(error => { starting = undefined; throw error; });
  return starting;
}

process.once('exit', () => { child?.kill(); });
