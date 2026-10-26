import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { extract, validate } from './extract.js';
import { browse, omnirouteKey } from './browse.js';

export type AgentMode = 'auto' | 'fetch' | 'browse' | 'deep' | 'tinyfish';
export interface AgentArgs {
  url: string;
  goal: string;
  schema?: Record<string, any>;
  mode?: AgentMode;
  max_steps?: number;
  timeout_s?: number;
}
export interface AgentStep { action: string; detail: string; ms: number }
export interface AgentResult {
  status: 'COMPLETED' | 'FAILED';
  result: any;
  steps: AgentStep[];
  escalated_to: Exclude<AgentMode, 'auto'>;
  sources: string[];
  error?: string;
}
export type AgentEmit = (event: { type: 'STARTED' | 'PROGRESS' | 'COMPLETE' | 'ERROR'; [k: string]: any }) => void;

const INTERACTIVE = /\b(click|press|tap|type|fill|log ?in|sign ?in|submit|scroll|select|hover|drag|upload|download|wait for|after (clicking|pressing)|appears?)\b/i;
const MULTIPAGE = /\b(all pages|every page|each page|across (the )?(site|pages)|crawl|compare .* (sites|pages)|multiple pages|research)\b/i;
const LADDER: Exclude<AgentMode, 'auto'>[] = ['fetch', 'browse', 'deep', 'tinyfish'];

function llmBase() {
  return { base: process.env.WEB_AGENT_LLM_BASE_URL || 'http://127.0.0.1:20128/v1', model: process.env.WEB_AGENT_LLM_MODEL || 'deepseek-flash' };
}

function parseJson(text: string): any {
  text = text.trim();
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(m ? m[1] : text);
}

/** The schema wins over the goal wording: a single-object schema yields one object, a list needs an array field. */
const SCHEMA_RULE = 'The JSON Schema is the contract: if it describes one object, return exactly one object even if the goal asks for several; ' +
  'return a list only where the schema has an array field.';

/** Turn free text produced by browse/deep into the requested JSON shape, retrying once if it does not validate. */
async function shapeJson(material: string, goal: string, schema: Record<string, any> | undefined, signal: AbortSignal): Promise<any> {
  const { base, model } = llmBase();
  const prompt =
    `Goal: ${goal}\nUsing ONLY the material below, reply with ONE JSON value that answers the goal` +
    (schema ? ` and validates against this JSON Schema:\n${JSON.stringify(schema)}\n${SCHEMA_RULE}` : ' (an object with the requested fields)') +
    '. Use null for anything the material does not state.\n\nMATERIAL:\n' + material.slice(0, 30000);
  const messages: { role: string; content: string }[] = [{ role: 'user', content: prompt }];
  let out: any = null;
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${omnirouteKey()}` },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) throw new Error(`shape LLM HTTP ${res.status}`);
    const reply: string = ((await res.json()) as any).choices?.[0]?.message?.content ?? '';
    let errors: string[];
    try {
      out = parseJson(reply);
      errors = schema ? validate(out, schema) : [];
    } catch (e: any) {
      errors = [`not valid JSON: ${e.message}`];
    }
    if (!errors.length) return out;
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That did not validate:\n${errors.slice(0, 10).join('\n')}\nReturn corrected JSON only.` });
  }
  if (out == null) throw new Error('shape LLM returned no JSON');
  return out;
}

const TF_KEYWORDS = new Set(['anyOf', 'enum', 'format', 'items', 'maxItems', 'maximum', 'minItems', 'minimum', 'nullable', 'properties', 'propertyOrdering', 'required', 'type']);
const TF_FORMATS = new Set(['date', 'date-time', 'duration', 'time']);

/** Rewrite a JSON Schema into TinyFish's output_schema subset (object top level, nullable instead of type arrays, oneOf -> anyOf). */
export function toTinyfishSchema(schema: any): Record<string, any> {
  const conv = (n: any): any => {
    if (typeof n !== 'object' || n === null || Array.isArray(n)) return { type: 'string' };
    const o: any = {};
    if (n.const !== undefined) { o.type = 'string'; o.enum = [String(n.const)]; }
    if (n.oneOf) o.anyOf = n.oneOf.map(conv);
    for (const [k, v] of Object.entries(n)) {
      if (!TF_KEYWORDS.has(k)) continue;
      if (k === 'type' && Array.isArray(v)) {
        const t = (v as string[]).filter((x) => x !== 'null');
        o.type = t[0] ?? 'string';
        if (t.length < (v as string[]).length) o.nullable = true;
      } else if (k === 'properties') o.properties = Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, conv(pv)]));
      else if (k === 'items') o.items = conv(v);
      else if (k === 'anyOf') o.anyOf = (v as any[]).map(conv);
      else if (k === 'enum') o.enum = (v as any[]).map(String);
      else if (k === 'format') { if (TF_FORMATS.has(v as string)) o.format = v; }
      else o[k] = v;
    }
    if (o.enum) o.type = 'string';
    if (o.required && o.properties) o.required = o.required.filter((r: string) => r in o.properties);
    if (o.propertyOrdering && o.properties) o.propertyOrdering = o.propertyOrdering.filter((r: string) => r in o.properties);
    if (!o.type && !o.anyOf) o.type = o.properties ? 'object' : o.items ? 'array' : 'string';
    return o;
  };
  const c = conv(schema ?? { type: 'object' });
  return c.type === 'object' && !c.anyOf ? c : { type: 'object', properties: { result: c }, required: ['result'] };
}

/** True when a result has no real content (TinyFish's output_schema runs sometimes return only empty arrays/nulls). */
const isEmpty = (v: any): boolean =>
  v == null || v === '' || (Array.isArray(v) ? v.every(isEmpty) : typeof v === 'object' ? Object.values(v).every(isEmpty) : false);

async function tinyfishCall(body: Record<string, any>, signal: AbortSignal): Promise<any> {
  const res = await fetch('https://agent.tinyfish.ai/v1/automation/run', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.TINYFISH_API_KEY! },
    body: JSON.stringify(body),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`tinyfish HTTP ${res.status}: ${JSON.stringify(out.error ?? out).slice(0, 200)}`);
  if (out.status !== 'COMPLETED') throw new Error(`tinyfish ${out.status}: ${JSON.stringify(out.error).slice(0, 200)}`);
  return out.result;
}

/** Last rung: TinyFish's hosted browser agent (needs TINYFISH_API_KEY; uses TinyFish credits).
 *  Sends output_schema first; if that comes back empty, reruns without it and shapes the text locally. */
async function tinyfishRun(url: string, goal: string, schema: Record<string, any> | undefined, maxSeconds: number, signal: AbortSignal): Promise<{ result: any; detail: string }> {
  if (!process.env.TINYFISH_API_KEY) throw new Error('TINYFISH_API_KEY not set');
  const base = { url, goal, agent_config: { max_duration_seconds: maxSeconds } };
  if (schema) {
    const wrapped = schema.type !== 'object';
    const r = await tinyfishCall({ ...base, output_schema: toTinyfishSchema(schema) }, signal);
    const result = wrapped && r && 'result' in r ? r.result : r;
    if (!isEmpty(result)) return { result, detail: 'TinyFish agent answered with output_schema' };
  }
  const text = await tinyfishCall(base, signal);
  if (isEmpty(text)) throw new Error('tinyfish returned no result');
  if (!schema) return { result: text, detail: 'TinyFish agent answered' };
  return { result: await shapeJson(JSON.stringify(text), goal, schema, signal), detail: 'TinyFish text answer, shaped locally to the schema' };
}

function a2aToken(): string {
  const f = join(homedir(), '.config/web-agent-deep/a2a-token');
  if (!existsSync(f)) throw new Error('deep agent token file not found');
  return readFileSync(f, 'utf8').trim();
}

async function deepAsk(url: string, goal: string, signal: AbortSignal): Promise<string> {
  const base = process.env.WEB_AGENT_A2A_URL || 'http://127.0.0.1:42619';
  const res = await fetch(base, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a2aToken()}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: `Start page: ${url}\nGoal: ${goal}` }] }, metadata: { mode: 'web' } },
    }),
  });
  if (!res.ok) throw new Error(`deep agent HTTP ${res.status}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`deep agent: ${body.error.message}`);
  const task = body.result;
  if (task?.status?.state !== 'completed') throw new Error(`deep agent ${task?.status?.state}: ${task?.status?.message?.parts?.[0]?.text ?? ''}`);
  return task.artifacts?.[0]?.parts?.[0]?.text ?? '';
}

export async function runAgent(args: AgentArgs, emit: AgentEmit = () => {}): Promise<AgentResult> {
  loadConfig();
  const { url, goal } = args;
  if (!/^https?:\/\//.test(url ?? '')) throw new Error('url must start with http:// or https://');
  if (!goal?.trim() || goal.length > 2000) throw new Error('goal must be 1-2000 characters');
  const mode = args.mode ?? 'auto';
  const maxSteps = Math.min(Math.max(args.max_steps ?? 4, 1), 4);
  const deadline = Date.now() + (args.timeout_s ?? 180) * 1000;
  const steps: AgentStep[] = [];
  const sources = new Set<string>([url]);
  const step = (action: string, detail: string, t0: number) => {
    const s = { action, detail, ms: Date.now() - t0 };
    steps.push(s);
    emit({ type: 'PROGRESS', purpose: `${action}: ${detail}`, ...s });
  };
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('TIMEOUT');
    return AbortSignal.timeout(ms);
  };

  // Ladder start: forced mode, else interactive goals skip straight to browse, multi-page goals to deep.
  let start = 0;
  if (mode !== 'auto') start = LADDER.indexOf(mode);
  else if (MULTIPAGE.test(goal)) start = 2;
  else if (INTERACTIVE.test(goal)) start = 1;
  const ladder = process.env.TINYFISH_API_KEY ? LADDER : LADDER.filter((r) => r !== 'tinyfish');
  const rungs = mode === 'auto' ? ladder.slice(start, start + maxSteps) : [LADDER[start]];
  emit({ type: 'STARTED', url, goal, mode, plan: rungs });

  let level = rungs[0];
  let lastErr = '';
  for (const rung of rungs) {
    level = rung;
    const t0 = Date.now();
    try {
      if (rung === 'fetch') {
        const wrapped = {
          type: 'object', required: ['answerable', 'result'],
          properties: { answerable: { type: 'boolean' }, result: args.schema ?? {} },
        };
        const out = await Promise.race([
          extract({
            urls: [url], schema: wrapped,
            instructions: `Goal: ${goal}. Set answerable=true and fill result ONLY if the page text itself already contains the answer. If the goal needs clicking, typing, waiting for dynamic content, or other pages, set answerable=false and result=null.`,
          }),
          new Promise<never>((_, rej) => left().addEventListener('abort', () => rej(new Error('TIMEOUT')))),
        ]);
        out.sources.forEach(s => sources.add(s));
        const d = out.data;
        if (d?.answerable && d.result != null && out.valid) {
          step('fetch+extract', 'answered from page text', t0);
          return done(d.result);
        }
        step('fetch+extract', d?.answerable === false ? 'page text lacks the answer, escalating' : `unusable output: ${out.errors[0] ?? 'null result'}`, t0);
        lastErr = 'fetch level could not answer';
      } else if (rung === 'browse') {
        const secs = Math.max(20, Math.min(120, Math.floor((deadline - Date.now()) / 1000) - 30));
        const r = await browse({ url, goal, max_seconds: secs });
        if (r.page?.url) sources.add(r.page.url);
        const material = JSON.stringify({ status: r.status, steps: r.steps, page: r.page });
        step('browse', `Jev ${r.status ?? 'done'}, ${Array.isArray(r.steps) ? r.steps.length : '?'} browser steps`, t0);
        const t1 = Date.now();
        const result = await shapeJson(material, goal, args.schema, left());
        step('shape', 'browse output to JSON', t1);
        return done(result);
      } else if (rung === 'tinyfish') {
        const secs = Math.max(30, Math.floor((deadline - Date.now()) / 1000) - 5);
        const { result, detail } = await tinyfishRun(url, goal, args.schema, secs, left());
        step('tinyfish', detail, t0);
        return done(result);
      } else {
        const text = await deepAsk(url, goal, left());
        step('deep-agent', 'A2A web agent answered', t0);
        const t1 = Date.now();
        const result = await shapeJson(text, goal, args.schema, left());
        step('shape', 'deep output to JSON', t1);
        return done(result);
      }
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      step(rung, `failed: ${lastErr}`, t0);
      if (lastErr === 'TIMEOUT') break;
    }
  }
  const failed: AgentResult = { status: 'FAILED', result: null, steps, escalated_to: level, sources: [...sources], error: lastErr || 'no result' };
  emit({ type: 'ERROR', ...failed });
  return failed;

  function done(result: any): AgentResult {
    const r: AgentResult = { status: 'COMPLETED', result, steps, escalated_to: level, sources: [...sources] };
    emit({ type: 'COMPLETE', ...r });
    return r;
  }
}
