// save_to_wiki: same behaviour as the old Python tool (engines/web_acquisition/wiki.py), run through the engines venv.
// Reads sources, has the OmniRoute model format a page, writes ONE file into $WEB_AGENT_WIKI_INBOX (default ~/brain/wiki/inbox).
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PY = process.env.PHROG_WEB_PYTHON || fileURLToPath(new URL('../../engines/.venv/bin/python', import.meta.url));
const CLI = fileURLToPath(new URL('../../engines/save_to_wiki_cli.py', import.meta.url));

export function saveToBrainWiki(args: Record<string, unknown>): Promise<unknown> {
  const env = { ...process.env, WEB_AGENT_WIKI_INBOX: process.env.WEB_AGENT_WIKI_INBOX || join(homedir(), 'brain/wiki/inbox') };
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-I', CLI], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('save_to_wiki timed out after 300s')); }, 300_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `save_to_wiki exited ${code}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { reject(new Error('save_to_wiki returned unparseable output')); }
    });
    p.stdin.end(JSON.stringify(args));
  });
}
