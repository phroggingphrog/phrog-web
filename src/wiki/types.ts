export interface WikiNote {
  id: string;
  slug: string;
  title: string;
  path: string;
  content: string;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiSearchResult {
  id: string;
  title: string;
  path: string;
  similarity: number;
  snippet: string;
  tags: string[];
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
