import { loadConfig } from '../config.js';

export interface FetchResult {
  url: string;
  title: string;
  markdown: string;
  length: number;
  provider_used: string;
  statusCode?: number;
}

export interface FetchOptions {
  provider?: string;
  mode?: 'plain' | 'browser' | 'auto';
  maxChars?: number;
}

function cleanHtmlToMarkdown(html: string): { title: string; markdown: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Strip script, style, svg, noscript
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // Convert basic headings and paragraphs
  text = text
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '') // remove remaining HTML tags
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
  const timeoutMs = providerCfg.timeoutMs || 5000;
  const maxChars = options.maxChars || providerCfg.maxChars || 50000;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    },
  });

  if (!res.ok) {
    throw new Error(`Plain fetch HTTP ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const { title, markdown } = cleanHtmlToMarkdown(html);

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

async function fetchCrawl4ai(url: string, options: FetchOptions): Promise<FetchResult> {
  const config = loadConfig();
  const providerCfg = config.fetch.providers.crawl4ai || {};
  const primaryUrl = providerCfg.primaryUrl || 'http://127.0.0.1:11235';
  const fallbackUrl = providerCfg.fallbackUrl || 'http://127.0.0.1:11236';
  const timeoutMs = providerCfg.timeoutMs || 20000;
  const maxChars = options.maxChars || 60000;
  const token = process.env.CRAWL4AI_API_TOKEN || '';

  const urlsToTry = [primaryUrl, fallbackUrl].filter(Boolean);
  let lastError: Error | null = null;

  for (const cUrl of urlsToTry) {
    try {
      const endpoint = new URL('/crawl', cUrl);
      const res = await fetch(endpoint.toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          urls: [url],
          priority: 10,
        }),
      });

      if (!res.ok) {
        throw new Error(`Crawl4AI HTTP ${res.status} from ${cUrl}`);
      }

      const data = await res.json() as any;
      const resultObj = Array.isArray(data.results) ? data.results[0] : (data.result || data);
      const markdown = resultObj?.markdown?.raw_markdown || resultObj?.markdown || resultObj?.text || '';
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
        statusCode: 200,
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
    throw new Error(`TinyFish Fetch HTTP ${res.status}: ${res.statusText}`);
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
  const errors: string[] = [];

  for (const provider of pipeline) {
    try {
      if (provider === 'plain') {
        return await fetchPlain(url, options);
      } else if (provider === 'crawl4ai') {
        return await fetchCrawl4ai(url, options);
      } else if (provider === 'tinyfish') {
        return await fetchTinyFish(url, options);
      } else {
        throw new Error(`Unknown fetch provider: ${provider}`);
      }
    } catch (err) {
      errors.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All fetch providers failed for ${url}. Errors: ${errors.join('; ')}`);
}
