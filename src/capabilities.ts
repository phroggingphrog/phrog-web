/** The capability map: one place that says what this service can do, and what it costs. */
import { SCRAPE_FORMATS } from './providers/scrape.js';

export interface Capability {
  capability: string;
  path: string;
  method: string;
  params: string[];
  backed_by: string[];
  cost: string;
}

export const CAPABILITIES: Capability[] = [
    { capability: 'search', path: '/api/search', method: 'GET', params: ['q', 'limit', 'mode=quick|deep', 'categories'], backed_by: ['tinyfish', 'exa', 'searxng (fallback)', 'firecrawl (deep)'], cost: 'tinyfish free tier first' },
    { capability: 'scrape', path: '/api/fetch', method: 'POST', params: ['url', 'urls', 'mode=plain|browser|auto', 'cache'], backed_by: ['plain', 'crawl4ai', 'jina', 'tinyfish'], cost: 'free unless it escalates' },
    { capability: 'interact', path: '/api/browse', method: 'POST', params: ['url', 'goal'], backed_by: ['jev runner'], cost: 'local' },
    { capability: 'scrape_formats', path: '/api/scrape', method: 'POST', params: ['url', 'formats[]: ' + SCRAPE_FORMATS.join('|'), 'jsonSchema', 'fullPage', 'screenshotInline'], backed_by: ['plain + crawl4ai + CDP render'], cost: 'free' },
    { capability: 'cache', path: '/api/cache', method: 'GET|DELETE', params: ['ttl_s', 'max_entries'], backed_by: ['process memory (TTL + LRU)'], cost: 'free' },
    { capability: 'profiles', path: '/api/profiles', method: 'GET|POST|DELETE', params: ['site'], backed_by: ['per-site cookie jars', 'Chromium persistent profile'], cost: 'free' },
    { capability: 'fetch_with_login', path: '/api/fetch-profile', method: 'POST', params: ['url', 'profile', 'waitMs'], backed_by: ['CDP + jar'], cost: 'free' },
    { capability: 'parse', path: '/api/parse', method: 'POST', params: ['url | base64+filename', 'maxChars'], backed_by: ['pdftotext', 'markitdown'], cost: 'free' },
    { capability: 'agent', path: '/api/agent', method: 'POST', params: ['goal', 'url', 'async'], backed_by: ['tinyfish agent (Builder)'], cost: '$0.016/step' },
    { capability: 'crawl', path: '/api/crawl/start', method: 'POST', params: ['url', 'maxDepth', 'limit'], backed_by: ['crawl4ai'], cost: 'free' },
    { capability: 'crawl_status', path: '/api/batch/:id', method: 'GET', params: ['id', 'include_results'], backed_by: ['crawl4ai'], cost: 'free' },
    { capability: 'map', path: '/api/map', method: 'POST', params: ['url', 'limit'], backed_by: ['sitemap + page links'], cost: 'free' },
    { capability: 'batch_scrape', path: '/api/batch', method: 'POST', params: ['urls[] (max 50)'], backed_by: ['fetch chain'], cost: 'varies' },
    { capability: 'monitor', path: '/api/monitor', method: 'POST', params: ['url', 'selector'], backed_by: ['fetch chain + content hash'], cost: 'free' },
    { capability: 'monitor_check', path: '/api/monitor/:id/check', method: 'POST', params: ['id'], backed_by: ['content hash'], cost: 'free' },
    { capability: 'browser', path: '/api/browser', method: 'POST', params: ['url', 'profile=lite|stealth'], backed_by: ['tinyfish browser (Builder)'], cost: '$0.002/min' },
    { capability: 'browser_close', path: '/api/browser/:sessionId', method: 'DELETE', params: ['sessionId'], backed_by: ['tinyfish browser'], cost: 'closes the meter' },
    { capability: 'research_resume', path: '/api/research/:jobId/resume', method: 'POST', params: ['jobId'], backed_by: ['feynman research run resume'], cost: 'local + llm' },
    { capability: 'research_cancel', path: '/api/research/:jobId/cancel', method: 'POST', params: ['jobId'], backed_by: ['process tree by run id', 'feynman research run set-status aborted'], cost: 'free' },
    { capability: 'research', path: '/api/research', method: 'POST', params: ['question|topic', 'mode=quick|deep', 'domain'], backed_by: ['search + llm (quick)', 'feynman (deep, local engine)'], cost: 'local + llm' },
    { capability: 'keys', path: '/api/keys', method: 'GET|POST|DELETE', params: ['key', 'value'], backed_by: ['hub store'], cost: 'free' },
];
