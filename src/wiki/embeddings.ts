import { EmbeddingProvider } from './types.js';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 1. External OpenAI/OmniRoute/Ollama-compatible REST Embedding Provider
export class ApiEmbeddingProvider implements EmbeddingProvider {
  name: string;
  dimensions: number;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(options: { baseUrl: string; apiKey?: string; model?: string; dimensions?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'text-embedding-3-small';
    this.dimensions = options.dimensions || 1536;
    this.name = `api-${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Embedding API HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => d.embedding);
  }
}

// 2. Offline Deterministic Hashed TF-IDF Provider (Zero-config fallback)
export class TfIdfEmbeddingProvider implements EmbeddingProvider {
  name = 'local-tfidf-256';
  dimensions = 256;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vectorize(text));
  }

  private vectorize(text: string): number[] {
    const vec = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2);

    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = ((hash << 5) - hash) + token.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % this.dimensions;
      vec[idx] += 1;
    }

    // L2 Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    if (norm > 0) {
      norm = Math.sqrt(norm);
      for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    }

    return vec;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const p = (globalThis as any).process?.env || {};
  const baseUrl = p.EMBEDDING_BASE_URL || (p.OPENAI_API_KEY ? 'https://api.openai.com/v1' : undefined);
  const apiKey = p.OPENAI_API_KEY || p.OMNIROUTE_API_KEY;

  if (baseUrl) {
    return new ApiEmbeddingProvider({
      baseUrl,
      apiKey,
      model: p.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimensions: p.EMBEDDING_DIMENSIONS ? parseInt(p.EMBEDDING_DIMENSIONS, 10) : 1536,
    });
  }

  // Zero-config offline fallback
  return new TfIdfEmbeddingProvider();
}
