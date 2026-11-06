/**
 * The cookbook gaps: Parse, Monitor, Browser.
 *
 * The rest of the surface the Firecrawl and TinyFish cookbooks advertise already exists as routes
 * (search, scrape, interact, agent, crawl, map, batch). These three did not:
 *
 *  - parse:   a document (PDF/DOCX/… or a URL that serves one) -> clean Markdown.
 *  - monitor: remember a page (optionally a selector) and report whether its content changed.
 *  - browser: a TinyFish remote browser session you can drive over CDP.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { convertDocument } from './document.js';
import { executeFetch } from './fetch.js';
import { writeRun } from '../runlog.js';

const MONITOR_FILE = () =>
  process.env.PHROG_WEB_MONITOR_FILE || resolve(homedir(), '.local/state/phrog-web/monitors.json');

export interface ParseResult {
  url?: string;
  kind: string;
  title: string;
  markdown: string;
  length: number;
  fetchedWith?: string;
}

/** Firecrawl "Parse": documents in, Markdown out. Accepts a URL or base64 bytes. */
export async function parseDocument(input: {
  url?: string;
  base64?: string;
  filename?: string;
  maxChars?: number;
}): Promise<ParseResult> {
  const maxChars = Math.max(1000, Math.min(200000, input.maxChars ?? 60000));
  const KNOWN = ['.pdf', '.docx', '.xlsx', '.pptx'] as const;

  if (input.base64 !== undefined) {
    const ext = KNOWN.find((e) => (input.filename || '').toLowerCase().endsWith(e));
    if (!ext) throw new Error(`filename must end with one of ${KNOWN.join(', ')}`);
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length) throw new Error('base64 payload decoded to zero bytes');
    const out = await convertDocument(ext, bytes);
    const markdown = out.markdown.slice(0, maxChars);
    return { kind: ext, title: out.title, markdown, length: markdown.length };
  }

  if (!input.url) throw new Error('url or base64 is required');

  // The fetch chain already converts documents it recognises and reports the extension it used;
  // reuse that rather than re-implementing egress, redirects and proxy handling here.
  const fetched = await executeFetch(input.url);
  const docExt = fetched.provider_used.includes(':') ? fetched.provider_used.split(':')[1] : '';
  const markdown = fetched.markdown.slice(0, maxChars);
  if (!markdown.trim()) throw new Error('could not extract any text from that document');
  return {
    url: input.url,
    kind: docExt ? `.${docExt}` : 'html',
    title: fetched.title || '',
    markdown,
    length: markdown.length,
    fetchedWith: fetched.provider_used,
  };
}

interface Monitor {
  id: string;
  url: string;
  selector?: string;
  hash: string;
  created: string;
  lastChecked?: string;
  lastChanged?: string;
  changes: number;
}

function readMonitors(): Record<string, Monitor> {
  const file = MONITOR_FILE();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Monitor>; } catch { return {}; }
}

function writeMonitors(all: Record<string, Monitor>): void {
  const file = MONITOR_FILE();
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
}

function fingerprint(selector: string | undefined, body: string): string {
  const text = selector ? body.slice(0, 200000) : body;
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Firecrawl "Monitor": register a page; check later and get told whether it moved. */
export async function createMonitor(input: { url?: string; selector?: string }): Promise<Monitor> {
  if (!input.url) throw new Error('url is required');
  const page = await executeFetch(input.url, { cache: false });
  const hash = fingerprint(input.selector, page.markdown);
  const all = readMonitors();
  const id = createHash('sha256').update(`${input.url}|${input.selector ?? ''}`).digest('hex').slice(0, 16);
  const monitor: Monitor = {
    id, url: input.url, selector: input.selector, hash,
    created: new Date().toISOString(), lastChecked: new Date().toISOString(), changes: 0,
  };
  all[id] = monitor;
  writeMonitors(all);
  return monitor;
}

export async function checkMonitor(id: string): Promise<{ monitor: Monitor; changed: boolean; previousHash: string }> {
  const all = readMonitors();
  const monitor = all[id];
  if (!monitor) throw new Error(`unknown monitor: ${id}`);
  const page = await executeFetch(monitor.url, { cache: false });
  const hash = fingerprint(monitor.selector, page.markdown);
  const changed = hash !== monitor.hash;
  const previousHash = monitor.hash;
  monitor.lastChecked = new Date().toISOString();
  if (changed) { monitor.hash = hash; monitor.changes += 1; monitor.lastChanged = monitor.lastChecked; }
  all[id] = monitor;
  writeMonitors(all);
  return { monitor, changed, previousHash };
}

export function listMonitors(): Monitor[] {
  return Object.values(readMonitors());
}

/** TinyFish Browser: a remote session you drive over CDP (Builder key — this is paid per minute). */
export async function createBrowserSession(input: {
  url?: string;
  profile?: 'lite' | 'stealth';
  timeoutMs?: number;
}): Promise<{ session_id: string; cdp_url: string; base_url: string; plan: 'paid' }> {
  const key = process.env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY (Builder) is required for remote browser sessions');
  // A session bills $0.002/min the moment it exists and TinyFish exposes no way to list sessions,
  // so an accidental empty-body call would create an untraceable orphan. url is mandatory.
  if (!input.url) throw new Error('url is required: a browser session opens a page and bills per minute');
  const endpoint = process.env.PHROG_WEB_BROWSER_URL || 'https://agent.tinyfish.ai/v1/browser';
  const body: Record<string, unknown> = {};
  if (input.url) body.url = input.url;
  if (input.profile) body.profile = input.profile;
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(input.timeoutMs ?? 60000), // session creation takes 10-30 s
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TinyFish browser HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { session_id: string; cdp_url: string; base_url: string };
  // Log the id: there is no inventory endpoint, so this log line is the only way to find a
  // session that the caller forgot to close.
  writeRun({ kind: 'browser.session.open', session_id: data.session_id, url: input.url, cost_per_min: 0.002 });
  return { ...data, plan: 'paid' };
}

/**
 * Close a remote browser session. Sessions bill per minute until closed, so this is not optional
 * plumbing: DELETE /v1/browser/{id} returns 204 and the session's /pages endpoint then 404s
 * (verified live).
 */
export async function closeBrowserSession(sessionId: string): Promise<{ closed: boolean; status: number }> {
  const key = process.env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY (Builder) is required');
  const base = process.env.PHROG_WEB_BROWSER_URL || 'https://agent.tinyfish.ai/v1/browser';
  const res = await fetch(`${base.replace(/\/$/, '')}/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(30000),
    headers: { 'X-API-Key': key },
  });
  const closed = res.status === 204 || res.ok;
  writeRun({ kind: 'browser.session.close', session_id: sessionId, closed, status: res.status });
  return { closed, status: res.status };
}
