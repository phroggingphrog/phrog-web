/**
 * Firecrawl-style scrape formats: markdown, html, rawHtml, links, screenshot, json.
 *
 * The point of doing this in one place is that a scrape should cost one page visit, not one per
 * format. The HTML is fetched once, and every format is derived from it — except `json`, which
 * needs the extractor, and `screenshot`, which needs the renderer.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { cleanHtmlToMarkdown, executeFetch, type FetchResult } from './fetch.js';
import { fetchPage, screenshotPage } from './cdp.js';
import type { CdpCookie } from './cdp.js';

export type ScrapeFormat = 'markdown' | 'html' | 'rawHtml' | 'links' | 'screenshot' | 'json';

export const SCRAPE_FORMATS: ScrapeFormat[] = ['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'json'];

export interface ScrapedLink {
  text: string;
  href: string;
}

export interface ScrapeInput {
  url?: string;
  formats?: ScrapeFormat[];
  mode?: 'plain' | 'browser' | 'auto';
  maxChars?: number;
  /** json: a JSON Schema to extract against. Without one, `json` is skipped, not guessed. */
  jsonSchema?: Record<string, unknown>;
  jsonInstructions?: string;
  /** screenshot: return base64 in the response instead of only a file. */
  screenshotInline?: boolean;
  fullPage?: boolean;
  waitMs?: number;
  /** Use a saved login jar for this site (see profiles.ts). */
  profile?: boolean | string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  provider_used: string;
  requested: ScrapeFormat[];
  skipped: Array<{ format: ScrapeFormat; reason: string }>;
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: ScrapedLink[];
  screenshot?: { file: string; url: string; bytes: number; width: number; height: number; base64?: string };
  json?: unknown;
  attempts?: FetchResult['attempts'];
}

export function shotsDir(): string {
  return process.env.PHROG_WEB_SHOTS_DIR || resolve(homedir(), '.local/state/phrog-web/shots');
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** One plain HTTP fetch of the raw document. Throws so the caller can fall back to the browser. */
async function fetchHtmlPlain(url: string): Promise<{ html: string; finalUrl: string; status: number }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html, finalUrl: res.url || url, status: res.status };
}

/** Pull every absolute http(s) anchor out of a document, deduped, with visible text. */
export function extractLinks(html: string, baseUrl: string): ScrapedLink[] {
  const seen = new Set<string>();
  const out: ScrapedLink[] = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 500) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    let abs: string;
    try { abs = new URL(raw, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    const clean = abs.split('#')[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const text = (m[5] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    out.push({ text, href: clean });
  }
  return out;
}

function stripToMain(html: string): string {
  // Deliberately conservative: drop scripts/styles/comments, keep the rest. `onlyMainContent`
  // belongs to the markdown format, where the existing extractor already does it properly.
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

export async function scrape(input: ScrapeInput): Promise<ScrapeResult> {
  const url = input.url;
  if (!url) throw new Error('url is required');
  const requested: ScrapeFormat[] = (input.formats?.length ? input.formats : ['markdown' as ScrapeFormat])
    .filter((f) => SCRAPE_FORMATS.includes(f as ScrapeFormat));
  if (!requested.length) throw new Error(`formats must be non-empty and drawn from ${SCRAPE_FORMATS.join(', ')}`);
  const skipped: ScrapeResult['skipped'] = [];
  const maxChars = Math.max(1000, Math.min(500000, input.maxChars ?? 100000));

  // A screenshot needs the renderer, but that must not drag the text formats through the browser
  // too: html/links/markdown come from one plain HTTP fetch, and only the screenshot renders.
  const wantsRender = input.mode === 'browser';

  let html = '';
  let finalUrl = url;
  let title = '';
  let providerUsed = '';
  let markdown = '';
  let attempts: FetchResult['attempts'] = [];

  // One page visit: plain first, browser only when asked for or when plain fails.
  if (!wantsRender) {
    try {
      const plain = await fetchHtmlPlain(url);
      html = plain.html;
      finalUrl = plain.finalUrl;
      const cleaned = cleanHtmlToMarkdown(html);
      title = cleaned.title;
      markdown = cleaned.markdown;
      providerUsed = 'plain';
    } catch {
      providerUsed = '';
    }
  }

  if (!html) {
    const jarCookies: CdpCookie[] = [];
    const page = await fetchPage(url, jarCookies, { waitMs: input.waitMs ?? 2500 });
    html = page.html;
    title = page.title;
    markdown = page.text;
    providerUsed = 'cdp';
  }

  // Thin plain extraction: let the normal fetch chain escalate (crawl4ai, jina, tinyfish).
  if (requested.includes('markdown') && markdown.trim().length < 400) {
    try {
      const better = await executeFetch(url, { maxChars });
      if (better.markdown.length > markdown.length) {
        markdown = better.markdown;
        title = title || better.title;
        providerUsed = better.provider_used;
        attempts = better.attempts ?? [];
      }
    } catch { /* keep what we have */ }
  }

  const result: ScrapeResult = {
    url: finalUrl,
    title,
    provider_used: providerUsed,
    requested,
    skipped,
    ...(attempts.length ? { attempts } : {}),
  };

  for (const format of requested) {
    switch (format) {
      case 'markdown':
        result.markdown = markdown.slice(0, maxChars);
        break;
      case 'html':
        result.html = stripToMain(html).slice(0, maxChars);
        break;
      case 'rawHtml':
        result.rawHtml = html.slice(0, maxChars);
        break;
      case 'links':
        result.links = extractLinks(html, finalUrl);
        break;
      case 'screenshot': {
        const shot = await screenshotPage(url, [], { waitMs: input.waitMs ?? 2500, fullPage: input.fullPage });
        mkdirSync(shotsDir(), { recursive: true });
        const name = `${createHash('sha256').update(`${url}|${Date.now()}`).digest('hex').slice(0, 20)}.png`;
        const file = resolve(shotsDir(), name);
        writeFileSync(file, shot.png, { mode: 0o644 });
        result.screenshot = {
          file,
          url: `/shots/${name}`,
          bytes: shot.png.length,
          width: shot.width,
          height: shot.height,
          ...(input.screenshotInline ? { base64: shot.png.toString('base64') } : {}),
        };
        break;
      }
      case 'json': {
        if (!input.jsonSchema) {
          skipped.push({ format: 'json', reason: 'no jsonSchema supplied; refusing to invent a shape' });
          break;
        }
        const { extract } = await import('./extract.js');
        const ex = await extract({ urls: [url], schema: input.jsonSchema, instructions: input.jsonInstructions ?? '' } as never);
        result.json = { data: ex.data, valid: ex.valid, errors: ex.errors };
        break;
      }
    }
  }
  return result;
}
