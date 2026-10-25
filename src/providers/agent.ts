import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { extract } from './extract.js';
import { browse, omnirouteKey } from './browse.js';

export type AgentMode = 'auto' | 'fetch' | 'browse' | 'deep';
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
  escalated_to: 'fetch' | 'browse' | 'deep';
  sources: string[];
  error?: string;
}
export type AgentEmit = (event: { type: 'STARTED' | 'PROGRESS' | 'COMPLETE' | 'ERROR'; [k: string]: any }) => void;

const INTERACTIVE = /\b(click|press|tap|type|fill|log ?in|sign ?in|submit|scroll|select|hover|drag|upload|download|wait for|after (clicking|pressing)|appears?)\b/i;
const MULTIPAGE = /\b(all pages|every page|each page|across (the )?(site|pages)|crawl|compare .* (sites|pages)|multiple pages|research)\b/i;
const LADDER: Exclude<AgentMode, 'auto'>[] = ['fetch', 'browse', 'deep'];

function llmBase() {
  return { base: process.env.WEB_AGENT_LLM_BASE_URL || 'http://127.0.0.1:20128/v1', model: process.env.WEB_AGENT_LLM_MODEL || 'deepseek-flash' };
}

function parseJson(text: string): any {
  text = text.trim();
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(m ? m[1] : text);
}

/** Turn free text produced by browse/deep into the requested JSON shape. */
async function shapeJson(material: string, goal: string, schema: Record<string, any> | undefined, signal: AbortSignal): Promise<any> {
  const { base, model } = llmBase();
  const prompt =
    `Goal: ${goal}\nUsing ONLY the material below, reply with ONE JSON value that answers the goal` +
    (schema ? ` and validates against this JSON Schema:\n${JSON.stringify(schema)}` : ' (an object with the requested fields)') +
    '. Use null for anything the material does not state.\n\nMATERIAL:\n' + material.slice(0, 30000);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${omnirouteKey()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`shape LLM HTTP ${res.status}`);
  return parseJson(((await res.json()) as any).choices?.[0]?.message?.content ?? '');
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
  const maxSteps = Math.min(Math.max(args.max_steps ?? 3, 1), 3);
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
  const rungs = mode === 'auto' ? LADDER.slice(start, start + maxSteps) : [LADDER[start]];
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
