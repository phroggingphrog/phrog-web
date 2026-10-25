import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { executeSearch, type SearchOptions, type SearchResult } from './providers/search.js';

type Params = Record<string, string | undefined>;

function mapTinyFish(r: SearchResult, position: number) {
  let parsed: string[] = ['', '', '', '', '', ''];
  let category = 'general';
  try {
    const u = new URL(r.url);
    parsed = [u.protocol.replace(':', ''), u.host, u.pathname, '', u.search.replace(/^\?/, ''), u.hash.replace(/^#/, '')];
  } catch { /* keep blanks */ }
  const engine = r.engine || 'tinyfish';
  return {
    template: 'default.html',
    title: r.title,
    content: r.snippet,
    img_src: '',
    iframe_src: '',
    audio_src: '',
    thumbnail: '',
    publishedDate: null,
    pubdate: '',
    length: null,
    views: '',
    author: '',
    metadata: '',
    priority: '',
    engines: [engine],
    open_group: false,
    close_group: false,
    positions: [position],
    score: r.score ?? 1 / position,
    category,
    url: r.url,
    engine,
    parsed_url: parsed,
  };
}

async function handle(req: FastifyRequest, reply: FastifyReply, p: Params) {
  const q = p.q;
  if (!q) return reply.status(400).type('text/plain').send('Bad Request: missing q');
  const format = p.format || 'html';
  if (format !== 'json') return reply.status(403).type('text/plain').send('Forbidden: only format=json is supported');

  const split = (v?: string) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined);
  const range = p.time_range as SearchOptions['timeRange'];
  const options: SearchOptions = {
    categories: split(p.categories),
    engines: split(p.engines),
    timeRange: range && ['day', 'week', 'month', 'year'].includes(range) ? range : undefined,
    language: p.language,
    safesearch: p.safesearch,
    pageno: p.pageno ? parseInt(p.pageno, 10) || 1 : undefined,
    limit: 1000,
  };

  try {
    const res = await executeSearch(q, options);
    const results = res.results.map((r, i) => r.raw ?? mapTinyFish(r, i + 1));
    const env = res.envelope || {};
    return {
      query: q,
      ...(env.number_of_results !== undefined ? { number_of_results: env.number_of_results } : {}),
      results,
      answers: env.answers ?? [],
      corrections: env.corrections ?? [],
      infoboxes: env.infoboxes ?? [],
      suggestions: env.suggestions ?? [],
      unresponsive_engines: env.unresponsive_engines ?? [],
    };
  } catch (err) {
    req.log.error(err);
    return reply.status(500).type('text/plain').send('Internal Server Error');
  }
}

export function registerSearxngCompat(app: FastifyInstance) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.get('/search', (req, reply) => handle(req, reply, req.query as Params));
  app.post('/search', (req, reply) => {
    const merged = { ...(req.query as Params), ...((req.body as Params) || {}) };
    return handle(req, reply, merged);
  });
}
