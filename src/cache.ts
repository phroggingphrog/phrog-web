/**
 * A small TTL + LRU cache for fetched pages. Repeat reads of the same URL are common (an agent reads a
 * page, then re-reads it to quote it), and a cached body costs nothing while the providers bill or block.
 *
 * Deliberately not used for anything that depends on who is asking: logged-in fetches and anything with
 * cookies bypass it, because two callers of the same URL can legitimately get different pages.
 */
export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

interface Entry {
  value: unknown;
  storedAt: number;
  bytes: number;
}

const DEFAULTS: CacheConfig = { ttlMs: 10 * 60_000, maxEntries: 200, maxBytes: 32 * 1024 * 1024 };

const store = new Map<string, Entry>();
let hits = 0;
let misses = 0;
let evictions = 0;
let expired = 0;

function cfg(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return { ...DEFAULTS, ...overrides };
}

function bytesOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

export function cacheKeyFetch(url: string, options: { mode?: string; maxChars?: number }): string {
  return `fetch|${options.mode ?? 'auto'}|${options.maxChars ?? ''}|${url}`;
}

export function cacheGet<T>(key: string, overrides: Partial<CacheConfig> = {}): { value: T; ageSeconds: number } | undefined {
  const entry = store.get(key);
  if (!entry) { misses += 1; return undefined; }
  const ttl = cfg(overrides).ttlMs;
  const age = Date.now() - entry.storedAt;
  if (age > ttl) {
    store.delete(key);
    expired += 1;
    misses += 1;
    return undefined;
  }
  hits += 1;
  // LRU: re-insert so the most recently used entry is last.
  store.delete(key);
  store.set(key, entry);
  return { value: entry.value as T, ageSeconds: Math.round(age / 1000) };
}

export function cacheSet(key: string, value: unknown, overrides: Partial<CacheConfig> = {}): void {
  const limits = cfg(overrides);
  const bytes = bytesOf(value);
  if (bytes > limits.maxBytes) return;

  store.delete(key);
  store.set(key, { value, storedAt: Date.now(), bytes });

  let total = 0;
  for (const entry of store.values()) total += entry.bytes;
  while (store.size > limits.maxEntries || total > limits.maxBytes) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    const victim = store.get(oldest.value)!;
    store.delete(oldest.value);
    total -= victim.bytes;
    evictions += 1;
  }
}

export function cacheStats(overrides: Partial<CacheConfig> = {}) {
  const limits = cfg(overrides);
  let bytes = 0;
  const now = Date.now();
  for (const entry of store.values()) bytes += entry.bytes;
  return {
    entries: store.size,
    bytes,
    hits,
    misses,
    expired,
    evictions,
    hit_rate: hits + misses ? Number((hits / (hits + misses)).toFixed(3)) : 0,
    ttl_s: Math.round(limits.ttlMs / 1000),
    max_entries: limits.maxEntries,
    live_entries: [...store.values()].filter((e) => now - e.storedAt <= limits.ttlMs).length,
  };
}

/** Clearing entries and forgetting lifetime counters are separate: /api/cache DELETE keeps the history. */
export function cacheResetStats(): void {
  hits = 0;
  misses = 0;
  evictions = 0;
  expired = 0;
}

export function cacheClear(): number {
  const n = store.size;
  store.clear();
  return n;
}
