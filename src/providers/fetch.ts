import { loadConfig } from '../config.js';
import { documentKind, convertDocument, extractMain } from './document.js';

export interface FetchResult {
  url: string;
  title: string;
  markdown: string;
  length: number;
  provider_used: string;
  statusCode?: number;
  attempts?: FetchAttempt[];
}

export interface FetchAttempt {
  provider: string;
  status?: number;
  outcome: 'ok' | 'blocked' | 'error';
  detail?: string;
}

class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly blocked = false) {
    super(message);
  }
}

// Bot-wall / interstitial phrases. Only trusted on short bodies so articles that quote them still pass.
const BLOCK_MARKERS = [
  'blocked by network security',
  'whoa there, pardner',
  'enable javascript and cookies to continue',
  'verify you are human',
  'verify you are a human',
  'just a moment...',
  'checking your browser before accessing',
  'attention required! | cloudflare',
  'complete the security check',
  'unusual traffic from your computer',
];
const BLOCK_MAX_CHARS = 2000;
const BLOCK_STATUSES = [403, 429];

export function detectBlocked(markdown: string, title = '', status?: number): string | null {
  if (status !== undefined && BLOCK_STATUSES.includes(status)) return `HTTP ${status}`;
  const body = `${title}\n${markdown}`.toLowerCase();
  if (body.length > BLOCK_MAX_CHARS) return null;
  const hit = BLOCK_MARKERS.find((m) => body.includes(m));
  return hit ? `bot-wall text: "${hit}"` : null;
}

export interface FetchOptions {
  provider?: string;
  mode?: 'plain' | 'browser' | 'auto';
  maxChars?: number;
  actions?: Array<Record<string, any>>;
  stealth?: boolean;
}

function cleanHtmlToMarkdown(html: string): { title: string; markdown: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  text = text
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, markdown: text };
}

async function fetchPlain(url: string, options: FetchOptions): Promise<FetchResult> {
  const config = loadConfig();
  const providerCfg = config.fetch.providers.plain || {};
  const timeoutMs = Math.max(providerCfg.timeoutMs || 5000, 20000);
  const maxChars = options.maxChars || providerCfg.maxChars || 50000;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    },
  });

  if (!res.ok) {
    throw new ProviderError(`Plain fetch HTTP ${res.status}: ${res.statusText}`, res.status, BLOCK_STATUSES.includes(res.status));
  }

  const ctype = res.headers.get('content-type') || '';
  const docExt = documentKind(res.url || url, ctype);
  if (docExt) {
    const doc = await convertDocument(docExt, Buffer.from(await res.arrayBuffer()));
    const cut = doc.markdown.slice(0, maxChars);
    return { url, title: doc.title, markdown: cut, length: cut.length, provider_used: `plain:${docExt.slice(1)}`, statusCode: res.status };
  }
  const html = await res.text();
  const cleaned = cleanHtmlToMarkdown(html);
  const main = await extractMain(html, res.url || url);
  const title = main?.title || cleaned.title;
  const markdown = main ? main.markdown : cleaned.markdown;

  const wall = detectBlocked(markdown, title);
  if (wall) throw new ProviderError(`Plain fetch got a block page (${wall})`, res.status, true);

  // If text is suspiciously small, it might be a JS-only SPA
  if (markdown.length < 150 && html.includes('<script')) {
    throw new Error('Page appears to be JavaScript-rendered; plain fetch returned minimal content.');
  }

  const truncated = markdown.slice(0, maxChars);
  return {
    url,
    title,
    markdown: truncated,
    length: truncated.length,
    provider_used: 'plain',
    statusCode: res.status,
  };
}


const MAX_ACTIONS = 20;
const ACTION_TYPES = ['click', 'type', 'press', 'scroll', 'wait', 'wait_for'];
const STEALTH_BROWSER = { type: 'BrowserConfig', params: { enable_stealth: true, user_agent_mode: 'random' } };
const CRAWLER_CONFIG = {
  type: 'CrawlerRunConfig',
  params: {
    markdown_generator: {
      type: 'DefaultMarkdownGenerator',
      params: {
        content_filter: { type: 'PruningContentFilter', params: { threshold: 0.48, threshold_type: 'dynamic' } },
        options: { ignore_images: true },
      },
    },
    excluded_tags: ['nav', 'header', 'footer', 'aside', 'form'],
    remove_overlay_elements: true,
  },
};

// Port of compile_actions (service.py): page actions to /execute_js scripts, or run-config options for scroll/wait.
function compileActions(actions: Array<Record<string, any>>): { scripts: string[] | null; extra: Record<string, any> } {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw new Error(`actions must be a list of at most ${MAX_ACTIONS} steps`);
  const q = JSON.stringify;
  const scripts: string[] = [];
  const extra: Record<string, any> = {};
  let interactive = false;
  for (const step of actions) {
    const kind = step?.type;
    if (!ACTION_TYPES.includes(kind)) throw new Error(`action type must be one of ${ACTION_TYPES.join(', ')}`);
    const sel = step.selector;
    if (['click', 'type', 'wait_for'].includes(kind) && (typeof sel !== 'string' || !sel || sel.length > 200)) throw new Error(`${kind} needs a CSS selector (max 200 chars)`);
    let body: string;
    if (kind === 'click') { interactive = true; body = `const e=document.querySelector(${q(sel)});if(!e)return 'no match: '+${q(sel)};const a=e.closest('a[href]');const h=a&&a.getAttribute('href');if(h&&!${step.noNav}&&!/^(javascript:|#)/i.test(h)&&(!a.target||a.target==='_self')){document.body.setAttribute('data-pw-nav',a.href);return 'nav';}e.click();return 'clicked';`; }
    else if (kind === 'type') {
      interactive = true;
      body = `const e=document.querySelector(${q(sel)});if(!e)return 'no match: '+${q(sel)};e.focus();e.value=${q(String(step.text ?? '').slice(0, 2000))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'typed';`;
    } else if (kind === 'press') {
      interactive = true;
      const key = String(step.key ?? 'Enter').slice(0, 20);
      body = `const e=document.querySelector(${q(sel || 'body')})||document.body;e.dispatchEvent(new KeyboardEvent('keydown',{key:${q(key)},bubbles:true}));if(${q(key)}==='Enter'&&e.form){e.form.requestSubmit?e.form.requestSubmit():e.form.submit();}return 'pressed';`;
    } else if (kind === 'scroll') {
      const to = step.to ?? 'bottom';
      if (to === 'bottom') { extra.scan_full_page = true; body = "let last=-1;for(let i=0;i<30&&document.body.scrollHeight!==last;i++){last=document.body.scrollHeight;window.scrollTo(0,last);await new Promise(r=>setTimeout(r,700));}return 'scrolled';"; }
      else if (to === 'top') body = "window.scrollTo(0,0);return 'top';";
      else body = `window.scrollTo(0,${Math.trunc(Number(to)) || 0});return 'scrolled';`;
    } else if (kind === 'wait') {
      const ms = Math.max(0, Math.min(Math.trunc(Number(step.ms ?? 500)), 10000));
      extra.delay_before_return_html = Math.max(extra.delay_before_return_html ?? 0, ms / 1000);
      body = `await new Promise(r=>setTimeout(r,${ms}));return 'waited';`;
    } else {
      extra.wait_for = `css:${sel}`;
      body = `for(let i=0;i<40;i++){if(document.querySelector(${q(sel)}))return 'found';await new Promise(r=>setTimeout(r,250));}return 'timeout';`;
    }
    scripts.push(`(async()=>{${body}})()`);
  }
  const settle = "(async()=>{for(let i=0;i<20&&document.readyState!=='complete';i++)await new Promise(r=>setTimeout(r,250));await new Promise(r=>setTimeout(r,1200));return 'settled';})()";
  return { scripts: interactive ? [settle, ...scripts] : null, extra };
}

function crawl4aiRequest(url: string, options: FetchOptions): { path: string; body: any } {
  const { scripts, extra } = options.actions?.length ? compileActions(options.actions) : { scripts: null, extra: {} as Record<string, any> };
  if (options.stealth) Object.assign(extra, { delay_before_return_html: Math.max(extra.delay_before_return_html ?? 0, 1.5), scan_full_page: true });
  if (scripts) return { path: '/execute_js', body: { url, scripts } };
  const cfg = Object.keys(extra).length ? { ...CRAWLER_CONFIG, params: { ...CRAWLER_CONFIG.params, ...extra } } : CRAWLER_CONFIG;
  const body: any = { urls: [url], priority: 10, crawler_config: cfg };
  if (options.stealth) body.browser_config = STEALTH_BROWSER;
  return { path: '/crawl', body };
}

async function fetchCrawl4ai(url: string, options: FetchOptions, hops = 0): Promise<FetchResult> {
  // A click that navigates hangs Crawl4AI /execute_js, so a link click only marks the target; we then crawl the target with the remaining actions.
  let rest: Array<Record<string, any>> | undefined;
  const full = options;
  const ci = options.actions?.findIndex((a) => a?.type === 'click') ?? -1;
  if (hops !== 99 && options.actions && ci >= 0 && ci < options.actions.length - 1) {
    rest = options.actions.slice(ci + 1);
    options = { ...options, actions: options.actions.slice(0, ci + 1) };
  }
  const config = loadConfig();
  const providerCfg = config.fetch.providers.crawl4ai || {};
  const primaryUrl = providerCfg.primaryUrl || 'http://127.0.0.1:11235';
  const fallbackUrl = providerCfg.fallbackUrl || 'http://127.0.0.1:11236';
  const timeoutMs = options.actions?.length || options.stealth ? 60000 : (providerCfg.timeoutMs || 20000);
  const maxChars = options.maxChars || 60000;
  const token = process.env.CRAWL4AI_API_TOKEN || '';

  const urlsToTry = [primaryUrl, fallbackUrl].filter(Boolean);
  let lastError: Error | null = null;

  for (const cUrl of urlsToTry) {
    try {
      const req = crawl4aiRequest(url, options);
      const endpoint = new URL(req.path, cUrl);
      const res = await fetch(endpoint.toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(req.body),
      });

      if (!res.ok) {
        throw new Error(`Crawl4AI HTTP ${res.status} from ${cUrl}`);
      }

      const data = await res.json() as any;
      const nav = typeof data.html === 'string' && data.html.match(/data-pw-nav="([^"]+)"/);
      if (nav && hops < 5) {
        const target = nav[1].replace(/&amp;/g, '&');
        return await fetchCrawl4ai(target, { ...options, actions: rest }, hops + 1);
      }
      if (rest) return await fetchCrawl4ai(url, { ...full, actions: full.actions!.map((a, i) => (a?.type === 'click' && i === ci ? { ...a, noNav: true } : a)) }, 99);
      const resultObj = Array.isArray(data.results) ? data.results[0] : (data.result || data);
      const md = resultObj?.markdown;
      const markdown = (typeof md === 'string' ? md : (md?.fit_markdown || md?.raw_markdown)) || resultObj?.text || '';
      const title = resultObj?.metadata?.title || resultObj?.title || '';

      if (!markdown || markdown.trim().length === 0) {
        throw new Error('Crawl4AI returned empty markdown content');
      }

      const truncated = markdown.slice(0, maxChars);
      return {
        url,
        title,
        markdown: truncated,
        length: truncated.length,
        provider_used: 'crawl4ai',
        // Upstream page status as seen by the crawler; 200 only when it reports none.
        statusCode: typeof resultObj?.status_code === 'number' ? resultObj.status_code : 200,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error('Crawl4AI failed on all endpoints');
}

async function fetchTinyFish(url: string, options: FetchOptions): Promise<FetchResult> {
  const apiKey = process.env['TINY' + 'FISH_API_KEY'];
  if (!apiKey) {
    throw new Error('TINYFISH_API_KEY is not configured in environment');
  }

  const config = loadConfig();
  const providerCfg = config.fetch.providers.tinyfish || {};
  const baseUrl = providerCfg.url || 'https://api.fetch.tinyfish.ai';
  const timeoutMs = providerCfg.timeoutMs || 15000;
  const maxChars = options.maxChars || 60000;

  const res = await fetch(baseUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      urls: [url],
    }),
  });

  if (!res.ok) {
    throw new ProviderError(`TinyFish Fetch HTTP ${res.status}: ${res.statusText}`, res.status);
  }

  const data = await res.json() as any;
  const resultObj = Array.isArray(data.results) ? data.results[0] : (data.result || data);
  const markdown = resultObj?.content || resultObj?.markdown || resultObj?.text || '';
  const title = resultObj?.title || '';

  const truncated = markdown.slice(0, maxChars);
  return {
    url,
    title,
    markdown: truncated,
    length: truncated.length,
    provider_used: 'tinyfish',
    statusCode: res.status,
  };
}

export async function executeFetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const config = loadConfig();
  const pipeline = options.provider ? [options.provider] : config.fetch.pipeline;
  const attempts: FetchAttempt[] = [];

  for (const provider of pipeline) {
    try {
      let result: FetchResult;
      if (provider === 'plain') {
        result = await fetchPlain(url, options);
      } else if (provider === 'crawl4ai') {
        result = await fetchCrawl4ai(url, options);
      } else if (provider === 'tinyfish') {
        result = await fetchTinyFish(url, options);
      } else {
        throw new Error(`Unknown fetch provider: ${provider}`);
      }
      // A bot-wall page is not content: treat it as a failed attempt so the pipeline escalates.
      const reason = detectBlocked(result.markdown, result.title, result.statusCode);
      if (reason) {
        attempts.push({ provider, status: result.statusCode, outcome: 'blocked', detail: reason });
        continue;
      }
      attempts.push({ provider, status: result.statusCode, outcome: 'ok' });
      return { ...result, attempts };
    } catch (err) {
      const e = err instanceof ProviderError ? err : null;
      const detail = err instanceof Error ? err.message : String(err);
      attempts.push({ provider, status: e?.status, outcome: e?.blocked ? 'blocked' : 'error', detail });
    }
  }

  const history = attempts.map((a) => `${a.provider}: ${a.status ?? 'no status'} ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`).join('; ');
  const blocked = attempts.some((a) => a.outcome === 'blocked');
  const msg = blocked
    ? `Blocked: ${url} is behind bot protection and no provider got the real page; do not retry the same URL, use the site's API/OAuth or another source. Attempts: ${history}`
    : `All fetch providers failed for ${url}. Attempts: ${history}`;
  throw Object.assign(new Error(msg), { blocked, attempts });
}

// Links from the rendered DOM (Crawl4AI /crawl `links.internal`), for JS-built sites where plain HTML has few anchors.
export async function renderedLinks(url: string): Promise<string[]> {
  const providerCfg = loadConfig().fetch.providers.crawl4ai || {};
  const token = process.env.CRAWL4AI_API_TOKEN || '';
  for (const base of [providerCfg.primaryUrl || 'http://127.0.0.1:11235', providerCfg.fallbackUrl || 'http://127.0.0.1:11236']) {
    try {
      const res = await fetch(new URL('/crawl', base).toString(), {
        method: 'POST', signal: AbortSignal.timeout(40000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ urls: [url], priority: 10, crawler_config: { type: 'CrawlerRunConfig', params: { delay_before_return_html: 1.5 } } }),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      const links = data.results?.[0]?.links;
      return [...(links?.internal ?? []), ...(links?.external ?? [])].map((l: any) => String(l.href || '').split('#')[0]).filter(Boolean);
    } catch { /* try next */ }
  }
  return [];
}
