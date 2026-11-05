import type { Capability } from './capabilities.js';

export interface RegisteredRoute { method: string; url: string }

const SERVICE_DESCRIPTION =
  'Self-hosted search, fetch, scrape, browser, agent and research API. Three doors into one service: ' +
  'REST here, MCP at /mcp, and a Hermes-native web_search/web_extract backend.';

function tagFor(url: string): string {
  const parts = url.split('/').filter(Boolean);
  if (parts[0] === 'api') return parts[1] || 'api';
  return parts[0] || 'root';
}

/** Fastify spells parameters `:jobId`; OpenAPI spells them `{jobId}`. Clients need the latter. */
export function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)\??/g, '{$1}');
}

/** Path parameters, read from the normalised path so a generated client can fill them. */
function pathParams(openapiUrl: string): string[] {
  return [...openapiUrl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

function capabilityFor(capabilities: Capability[], url: string, method: string): Capability | undefined {
  return capabilities.find((c) => c.path === url && c.method.toUpperCase().split('|').includes(method.toUpperCase()));
}

export function buildOpenApi(routes: RegisteredRoute[], capabilities: Capability[], baseUrl = 'http://127.0.0.1:8890') {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const method = route.method.toLowerCase();
    if (method === 'head' || method === 'options') continue;
    if (route.url === '/*' || route.url.startsWith('/_')) continue;

    const openapiUrl = toOpenApiPath(route.url);
    const cap = capabilityFor(capabilities, route.url, method);
    const inPath = pathParams(openapiUrl);
    const parameters = [
      ...inPath.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...(cap?.params ?? [])
        .filter((p) => !p.includes('=') && !inPath.includes(p) && !p.includes(' ') && !p.includes('|'))
        .map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
    ];

    paths[openapiUrl] ??= {};
    paths[openapiUrl][method] = {
      summary: cap ? cap.capability : `${method.toUpperCase()} ${route.url}`,
      description: cap ? `Backed by ${cap.backed_by.join(', ')}. Cost: ${cap.cost}.` : undefined,
      tags: [tagFor(route.url)],
      parameters,
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Invalid request' },
        '502': { description: 'Upstream or provider failure' },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: { title: 'phrog-web', version: '0.1.0', description: SERVICE_DESCRIPTION },
    servers: [{ url: baseUrl }],
    tags: [...new Set(Object.keys(paths).map(tagFor))].sort().map((name) => ({ name })),
    paths,
  };
}

/** A dependency-free page: it fetches the spec and renders what the router actually registered. */
export function renderDocsHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>phrog-web API</title>
<style>
 :root { color-scheme: dark light; }
 body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; background: #0e1116; color: #e6edf3; }
 h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
 p.sub { color: #8b949e; margin: 0 0 1.5rem; }
 input { width: 100%; max-width: 32rem; padding: .6rem .8rem; border-radius: .5rem; border: 1px solid #30363d; background: #161b22; color: inherit; margin-bottom: 1.5rem; }
 h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin: 1.75rem 0 .5rem; }
 .ep { display: flex; gap: .75rem; align-items: baseline; padding: .45rem .6rem; border-radius: .4rem; }
 .ep:hover { background: #161b22; }
 .m { font: 700 .7rem/1 ui-monospace, monospace; padding: .3rem .45rem; border-radius: .3rem; min-width: 3.6rem; text-align: center; }
 .get { background: #0b3d2c; color: #3fb950; } .post { background: #1f3a5f; color: #79c0ff; }
 .delete { background: #4a1d24; color: #ff7b72; } .put { background: #3d3117; color: #d29922; }
 code { font-family: ui-monospace, monospace; font-size: .85rem; }
 .meta { color: #8b949e; font-size: .8rem; margin-left: auto; }
</style></head><body>
<h1>phrog-web</h1>
<p class="sub">Generated from the running router, so it cannot drift from what is actually served. Raw spec: <a href="/openapi.json" style="color:#79c0ff">/openapi.json</a></p>
<input id="q" placeholder="filter by path, method or name…" autofocus>
<div id="out"></div>
<script>
fetch('/openapi.json').then(r => r.json()).then(spec => {
  const groups = {};
  for (const [url, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = (op.tags && op.tags[0]) || 'other';
      (groups[tag] = groups[tag] || []).push({ url, method, op });
    }
  }
  const out = document.getElementById('out');
  const render = (filter) => {
    out.innerHTML = '';
    for (const tag of Object.keys(groups).sort()) {
      const rows = groups[tag].filter(e =>
        !filter || (e.url + ' ' + e.method + ' ' + e.op.summary).toLowerCase().includes(filter));
      if (!rows.length) continue;
      const h = document.createElement('h2'); h.textContent = tag + ' — ' + rows.length;
      out.appendChild(h);
      for (const e of rows) {
        const d = document.createElement('div'); d.className = 'ep';
        d.innerHTML = '<span class="m ' + e.method + '">' + e.method.toUpperCase() + '</span>' +
          '<code>' + e.url + '</code><span class="meta">' + (e.op.description || e.op.summary || '') + '</span>';
        out.appendChild(d);
      }
    }
  };
  render('');
  document.getElementById('q').addEventListener('input', (ev) => render(ev.target.value.toLowerCase()));
});
</script></body></html>`;
}
