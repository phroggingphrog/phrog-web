// Cross-encoder rerank stage, after RRF.
//
// RRF is a rank-voting rule: it is cheap, deterministic and cannot read the text. A
// cross-encoder reads (query, document) together and scores actual relevance, which is the
// one thing RRF structurally cannot do. So the order is: engines -> RRF (recall) ->
// reranker over the top-N (precision). The reranker can only reorder what RRF found; it
// cannot recover a page the engines never returned.
//
// Measured through omniroute on this box (2026-11-05), hosted only, no local model:
//   openrouter/cohere/rerank-4-fast    ~998 ms
//   openrouter/voyageai/rerank-3-lite  ~884 ms
// Both graded a relevant document ~0.80 and an off-topic one ~0.09, so the scores are usable
// as-is. Budget is per-model and the chain falls through on failure or timeout, ending at
// the RRF order — a slow reranker degrades ranking, never availability.

const MODELS = () => (process.env.PHROG_WEB_RERANK_MODELS || 'openrouter/cohere/rerank-4-fast,openrouter/voyageai/rerank-3-lite')
  .split(',').map((m) => m.trim()).filter(Boolean);

export interface RerankDoc { title?: string; snippet?: string; url: string }
export interface RerankOutcome {
  /** Indices of the input, best first. Empty when reranking did not happen. */
  order: number[];
  scores?: number[];
  model?: string;
  ms: number;
  reason?: string;
}

const BASE = () => (process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');

/** Keep the payload small: a reranker only needs enough text to judge topicality. */
const documentText = (d: RerankDoc) => `${d.title || ''} — ${d.snippet || ''} ${d.url}`.replace(/\s+/g, ' ').slice(0, 512);

export function rerankEnabled(): boolean {
  return process.env.PHROG_WEB_RERANK !== '0';
}

/**
 * Gate: only rerank when the candidate set is STARVED.
 *
 * Measured on two corpora, same reranker, opposite outcomes:
 *   history (40 real queries, ~10 candidates each): MRR +0.074 [+0.019, +0.148], 6 better 0 worse
 *   seed    (20 doc queries, 23-60 candidates)    : MRR -0.362 [-0.545, -0.193], 3 better 12 worse
 *
 * The split tracks candidate count, not query style: a cross-encoder has little to add when
 * RRF already has a deep, agreeing list, and it happily demotes authoritative docs in favour
 * of plausible prose. So default policy is "rerank only when thin".
 *
 * PROVISIONAL: fitted on 60 queries from two corpora. A third corpus that disagrees would
 * mean this is overfitting — re-measure before trusting the number.
 */
export function rerankMaxCandidates(): number {
  const n = Number(process.env.PHROG_WEB_RERANK_MAX_CANDIDATES || 16);
  return Number.isFinite(n) && n > 0 ? n : 16;
}

export async function rerank(query: string, docs: RerankDoc[], budgetMs = 1800): Promise<RerankOutcome> {
  const t0 = Date.now();
  if (!docs.length) return { order: [], ms: 0, reason: 'no documents' };
  const key = process.env.OMNIROUTE_API_KEY;
  if (!key) return { order: [], ms: 0, reason: 'no OMNIROUTE_API_KEY' };

  for (const model of MODELS()) {
    try {
      const res = await fetch(`${BASE()}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, query, documents: docs.map(documentText), top_n: docs.length }),
        signal: AbortSignal.timeout(budgetMs),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number }> };
      const results = data.results;
      if (!Array.isArray(results) || results.length !== docs.length) continue;
      const order = results.map((r) => Number(r.index)).filter((i) => Number.isInteger(i) && i >= 0 && i < docs.length);
      if (order.length !== docs.length) continue;
      return { order, scores: results.map((r) => Number(r.relevance_score) || 0), model, ms: Date.now() - t0 };
    } catch {
      // timeout or transport error: try the next model
    }
  }
  return { order: [], ms: Date.now() - t0, reason: 'all rerank models failed or over budget' };
}
