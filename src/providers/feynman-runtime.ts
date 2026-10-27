import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate Feynman port');
  const port = address.port;
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return port;
}

export function embeddedFeynmanUrl(): Promise<string> {
  if (starting) return starting;
  starting = (async () => {
    const { root, engine, env } = feynmanRuntime();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const proc = spawn(process.execPath, [engine, 'mcp', '--mcp-host', '127.0.0.1', '--mcp-port', String(port)], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    proc.stderr?.resume();
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => { proc.kill(); fail(new Error('Embedded Feynman startup timed out')); }, 30000);
      const failed = (error: Error) => { clearTimeout(timer); fail(error); };
      proc.once('error', failed);
      proc.once('exit', code => failed(new Error(`Embedded Feynman exited during startup (${code}); check the embedded engine setup`)));
      proc.stdout?.on('data', chunk => {
        if (String(chunk).includes('Feynman MCP listening at')) { clearTimeout(timer); done(); }
      });
    });
    proc.unref();
    (proc.stdout as Socket | null)?.unref();
    (proc.stderr as Socket | null)?.unref();
    proc.once('exit', () => { if (child === proc) { child = undefined; starting = undefined; } });
    return `http://127.0.0.1:${port}/mcp`;
  })().catch(error => { starting = undefined; throw error; });
  return starting;
}

process.once('exit', () => { child?.kill(); });
