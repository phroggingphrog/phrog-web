// Optional LLM query refinement, OFF by default.
//
// Measured on this box (2026-11-05) before writing it, so the default is a decision and not
// a guess: bc250/qwen3.5-9b returned 502, bc250/lfm3-1.7b-uncensored did not answer inside
// 20 s, and auto/best-fast took 5.5 s and echoed the prompt back unshortened. A search that
// blocks for 5 s to save a few keywords is worse than the deterministic shaper in
// query-shape.ts, which costs microseconds.
//
// Keep it wired for the day a fast local model is reliable: enable with PHROG_WEB_QUERY_LLM=1
// and give the local model a hard budget; if it overruns, the hosted fallback gets its own
// budget, and if that overruns too the caller keeps the deterministic result.

const DEFAULT_LOCAL = 'bc250/qwen3.5-9b';
const DEFAULT_FALLBACK = 'auto/best-fast';

export interface RefineResult {
  query?: string;
  model?: string;
  ms: number;
  via?: 'local' | 'fallback';
  reason?: string;
}

const BASE = () => (process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');

const PROMPT = 'Rewrite the user message as a web search query of at most 6 keywords. ' +
  'Keep product names, versions, file names and error strings verbatim. Drop question words and filler. ' +
  'Output only the query, no quotes, no explanation.';

async function ask(model: string, query: string, budgetMs: number): Promise<string | undefined> {
  const key = process.env.OMNIROUTE_API_KEY;
  if (!key) return undefined;
  try {
    const res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 48,
        temperature: 0,
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: query }],
      }),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return undefined;
    // Reject refusals, essays and anything that just echoed the prompt.
    const clean = text.split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim();
    if (!clean || clean.length > 120 || clean.toLowerCase() === query.trim().toLowerCase()) return undefined;
    return clean;
  } catch {
    return undefined;
  }
}

export function refineEnabled(): boolean {
  return process.env.PHROG_WEB_QUERY_LLM === '1';
}

export async function refineQuery(query: string, localBudgetMs = 1200, fallbackBudgetMs = 2500): Promise<RefineResult> {
  const t0 = Date.now();
  const local = process.env.PHROG_QUERY_MODEL_LOCAL || DEFAULT_LOCAL;
  const fallback = process.env.PHROG_QUERY_MODEL_FALLBACK || DEFAULT_FALLBACK;

  const viaLocal = await ask(local, query, localBudgetMs);
  if (viaLocal) return { query: viaLocal, model: local, ms: Date.now() - t0, via: 'local' };

  const viaFallback = await ask(fallback, query, fallbackBudgetMs);
  if (viaFallback) return { query: viaFallback, model: fallback, ms: Date.now() - t0, via: 'fallback' };

  return { ms: Date.now() - t0, reason: 'both models unavailable or over budget' };
}
