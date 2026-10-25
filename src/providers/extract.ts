import { loadConfig } from '../config.js';
import { webCrawl } from './crawl.js';
import { omnirouteKey } from './browse.js';

export interface ExtractArgs {
  urls: string[];
  schema: Record<string, any>;
  instructions?: string;
}

const MAX_INPUT_CHARS = 60000;
const RETRIES = 2;

/** Minimal JSON Schema check (type, required, properties, items, enum, nullable via type arrays). */
function validate(v: any, s: any, path = ''): string[] {
  const errs: string[] = [];
  if (!s || typeof s !== 'object') return errs;
  const at = path || '(root)';
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    const ok = types.some(x => x === t || (x === 'number' && t === 'integer'));
    if (!ok) return [`${at}: ${JSON.stringify(v)} is not of type ${types.map(x => `'${x}'`).join(', ')}`];
  }
  if (s.enum && !s.enum.some((e: any) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${at}: '${r}' is a required property`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) errs.push(...validate(v[k], sub, path ? `${path}/${k}` : k));
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(x, s.items, path ? `${path}/${i}` : String(i))));
  return errs.sort();
}

function jsonFrom(text: string): any {
  text = text.trim();
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(m ? m[1] : text);
}

export async function extract(args: ExtractArgs): Promise<{ data: any; valid: boolean; errors: string[]; sources: string[] }> {
  loadConfig();
  const { urls, schema, instructions = '' } = args;
  if (!schema || typeof schema !== 'object') throw new Error('schema is not valid JSON Schema');
  const crawled = await webCrawl({ urls, max_chars: 20000 });
  const pages = (crawled.results as any[]).filter(r => r.success && r.markdown);
  if (!pages.length) throw new Error('none of the URLs could be read');
  const per = Math.floor(MAX_INPUT_CHARS / pages.length);
  const material = pages.map(r => `## SOURCE ${r.url}\nPage title: ${r.title || ''}\n${r.markdown.slice(0, per)}`).join('\n\n');
  const prompt =
    'Extract data from the sources below. Reply with ONLY one JSON value that validates against this JSON Schema. ' +
    'Use null for anything the sources do not state; never invent values.\n' +
    `Schema:\n${JSON.stringify(schema)}\n${instructions ? 'Instructions: ' + instructions : ''}\n\n${material}`;
  const base = process.env.WEB_AGENT_LLM_BASE_URL || 'http://127.0.0.1:20128/v1';
  const model = process.env.WEB_AGENT_LLM_MODEL || 'deepseek-flash';
  const key = omnirouteKey();
  const messages: { role: string; content: string }[] = [{ role: 'user', content: prompt }];
  let data: any = null, errors: string[] = [];
  for (let i = 0; i <= RETRIES; i++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) throw new Error(`extract LLM HTTP ${res.status}`);
    const reply: string = ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
    try {
      data = jsonFrom(reply);
      errors = validate(data, schema);
    } catch (e: any) {
      data = null;
      errors = [`not valid JSON: ${e.message}`];
    }
    if (!errors.length) break;
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'That did not validate:\n' + errors.slice(0, 10).join('\n') + '\nReturn corrected JSON only.' });
  }
  return { data, valid: !errors.length, errors: errors.slice(0, 10), sources: pages.map(p => p.url) };
}
