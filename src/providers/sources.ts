// Key-less research sources (port of engines/web_acquisition/sources.py).
const UA = 'phrog-research/0.1 (self-hosted research MCP; personal, low volume)';
const SNIPPET = 600;
const MAX_PER_SOURCE = 10;
const SE_SITES = ['stackoverflow', 'stats', 'math', 'datascience', 'dba', 'softwareengineering', 'superuser', 'unix', 'serverfault'];

type Item = Record<string, any>;
type Get = (url: string, raw?: boolean) => Promise<any>;

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
function txt(v: any, limit = SNIPPET): string {
  const s = decode(String(v ?? '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : s.slice(0, limit).trimEnd() + ' …';
}
function item(source: string, title: any, url: any, fields: Item = {}): Item {
  const out: Item = { source, title: txt(title, 300), url };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}
const qs = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

function oaAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const w: [number, string][] = [];
  for (const [word, pos] of Object.entries(index)) for (const p of pos) w.push([p, word]);
  return w.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ');
}

const SOURCES: Record<string, (get: Get, q: string, limit: number, site: string) => Promise<Item[]>> = {
  async openalex(get, q, limit) {
    const d = await get('https://api.openalex.org/works?' + qs({ search: q, 'per-page': limit }));
    return (d.results ?? []).map((w: any) => item('openalex', w.display_name, w.primary_location?.landing_page_url || w.doi || w.id, {
      snippet: txt(oaAbstract(w.abstract_inverted_index)),
      authors: (w.authorships ?? []).slice(0, 5).filter((a: any) => a.author).map((a: any) => a.author.display_name),
      year: w.publication_year, citations: w.cited_by_count, doi: w.doi, pdf_url: w.open_access?.oa_url,
    }));
  },
  async arxiv(get, q, limit) {
    const terms = (q.match(/[\w-]+/g) ?? []).slice(0, 12);
    const search = terms.map((t) => `all:${t}`).join(' AND ') || `all:"${q}"`;
    const xml: string = (await get('https://export.arxiv.org/api/query?' + qs({ search_query: search, max_results: limit, sortBy: 'relevance' }), true)).toString('utf8');
    const tag = (s: string, t: string) => s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1];
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const e = m[1];
      return item('arxiv', tag(e, 'title'), tag(e, 'id')?.trim(), {
        snippet: txt(tag(e, 'summary')),
        authors: [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((a) => a[1].trim()).slice(0, 5),
        year: (tag(e, 'published') ?? '').slice(0, 4) || null,
        pdf_url: e.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/)?.[1] ?? e.match(/<link[^>]*href="([^"]+)"[^>]*title="pdf"/)?.[1],
      });
    });
  },
  async semantic_scholar(get, q, limit) {
    const d = await get('https://api.semanticscholar.org/graph/v1/paper/search?' + qs({ query: q, limit, fields: 'title,url,year,abstract,citationCount,authors,openAccessPdf,externalIds' }));
    return (d.data ?? []).map((p: any) => item('semantic_scholar', p.title, p.url, {
      snippet: txt(p.abstract), authors: (p.authors ?? []).slice(0, 5).map((a: any) => a.name),
      year: p.year, citations: p.citationCount, doi: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null, pdf_url: p.openAccessPdf?.url,
    }));
  },
  async crossref(get, q, limit) {
    const types = ['journal-article', 'proceedings-article', 'book-chapter', 'book', 'posted-content'].map((t) => `type:${t}`).join(',');
    const d = await get('https://api.crossref.org/works?' + qs({ query: q, rows: limit, select: 'DOI,title,author,issued,is-referenced-by-count,URL,abstract,container-title', filter: types }));
    return (d.message?.items ?? []).map((w: any) => item('crossref', (w.title ?? [''])[0], w.URL, {
      snippet: txt(w.abstract), venue: (w['container-title'] ?? [null])[0],
      authors: (w.author ?? []).slice(0, 5).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')),
      year: w.issued?.['date-parts']?.[0]?.[0], citations: w['is-referenced-by-count'], doi: w.DOI ? `https://doi.org/${w.DOI}` : null,
    }));
  },
  async wikipedia(get, q, limit) {
    const d = await get('https://en.wikipedia.org/w/rest.php/v1/search/page?' + qs({ q, limit }));
    return (d.pages ?? []).map((p: any) => item('wikipedia', p.title, 'https://en.wikipedia.org/wiki/' + encodeURIComponent(p.key ?? ''), { snippet: txt(p.excerpt) || txt(p.description) }));
  },
  async hackernews(get, q, limit) {
    const d = await get('https://hn.algolia.com/api/v1/search?' + qs({ query: q, tags: 'story', hitsPerPage: limit }));
    return (d.hits ?? []).map((h: any) => item('hackernews', h.title, h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, {
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points, comments: h.num_comments, year: (h.created_at ?? '').slice(0, 4) || null,
    }));
  },
  async stackexchange(get, q, limit, site) {
    if (!SE_SITES.includes(site)) throw new Error(`stackexchange_site must be one of ${JSON.stringify([...SE_SITES].sort())}`);
    const d = await get('https://api.stackexchange.com/2.3/search/advanced?' + qs({ order: 'desc', sort: 'relevance', q, site, pagesize: limit, filter: 'withbody' }));
    return (d.items ?? []).map((x: any) => item('stackexchange', x.title, x.link, { snippet: txt(x.body), score: x.score, answers: x.answer_count, answered: x.is_answered, site }));
  },
};
const PRESETS: Record<string, string[]> = {
  academic: ['openalex', 'arxiv', 'semantic_scholar', 'crossref', 'wikipedia'],
  tech: ['stackexchange', 'hackernews', 'wikipedia'],
  all: Object.keys(SOURCES),
};

export async function researchSearch(a: { query: string; preset?: string; sources?: string[] | null; limit?: number; stackexchange_site?: string }) {
  const query = a.query.trim();
  if (!query) throw new Error('query must not be empty');
  let chosen: string[];
  if (a.sources?.length) {
    const unknown = a.sources.filter((s) => !(s in SOURCES)).sort();
    if (unknown.length) throw new Error(`unknown sources ${JSON.stringify(unknown)}; choose from ${JSON.stringify(Object.keys(SOURCES).sort())}`);
    chosen = [...new Set(a.sources)];
  } else {
    const preset = a.preset ?? 'academic';
    if (!(preset in PRESETS)) throw new Error(`preset must be one of ${JSON.stringify(Object.keys(PRESETS).sort())}`);
    chosen = PRESETS[preset];
  }
  const limit = Math.max(1, Math.min(Math.trunc(a.limit ?? 3), MAX_PER_SOURCE));
  const site = a.stackexchange_site ?? 'stackoverflow';
  const get: Get = async (url, raw = false) => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, application/atom+xml;q=0.9' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  const settled = await Promise.all(chosen.map(async (name) => {
    try { return { name, items: await SOURCES[name](get, query, limit, site), error: null as string | null }; }
    catch (e: any) { return { name, items: [] as Item[], error: `${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 200)}` }; }
  }));
  const results: Item[] = [];
  const errors: Record<string, string> = {};
  for (const s of settled) { if (s.error) errors[s.name] = s.error; else results.push(...s.items); }
  return { query, sources: chosen, count: results.length, results, errors };
}
