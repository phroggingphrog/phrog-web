/**
 * TinyFish key rotation.
 *
 * TinyFish is free to 12,000 search requests/day per account, so a second account is a real
 * second quota — but only if the service can switch to it. Keys are read from TINYFISH_API_KEY
 * and TINYFISH_API_KEY_2; the first that answers is remembered so a dead or exhausted key is not
 * retried on every request. 401/402/403/429 mean "this key is done, try the next one"; a 5xx or a
 * timeout does not burn a key.
 *
 * Do NOT try to lift a key out of omniroute: its provider_connections.api_key column is encrypted
 * at rest (a 143-char blob that is not even a valid Firecrawl key, while omniroute itself calls
 * Firecrawl fine). Use omniroute's own /v1/search endpoint instead, which is what the firecrawl
 * provider does.
 */
export function tinyfishKeys(): string[] {
  const env = globalThis.process?.env ?? {};
  return [env.TINYFISH_API_KEY, env.TINYFISH_API_KEY_2]
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => k.length > 0);
}

let preferredKeyIndex = 0;

/** Key order to try, starting at the one that last worked. */
export function tinyfishKeyOrder(): string[] {
  const keys = tinyfishKeys();
  if (keys.length <= 1) return keys;
  const start = preferredKeyIndex % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

export function noteTinyfishKeySuccess(key: string): void {
  const keys = tinyfishKeys();
  const idx = keys.indexOf(key);
  if (idx >= 0) preferredKeyIndex = idx;
}

/** True when the status means the key is unusable rather than the request being wrong. */
export function isKeyExhaustedStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

/** Reset the sticky preference (tests, or after new keys are loaded). */
export function resetTinyfishKeyPreference(): void {
  preferredKeyIndex = 0;
}

/**
 * Run a TinyFish call, rotating to the next key when the current one is exhausted.
 * Exported so search and fetch share exactly one rotation policy.
 */
export async function runWithTinyfishKeys<T>(fn: (key: string) => Promise<T>): Promise<T> {
  const keys = tinyfishKeyOrder();
  if (!keys.length) throw new Error('TINYFISH_API_KEY is not configured in environment');
  let lastError: unknown;
  for (const key of keys) {
    try {
      const out = await fn(key);
      noteTinyfishKeySuccess(key);
      return out;
    } catch (err) {
      lastError = err;
      const status = Number((err as { status?: number }).status ?? 0);
      if (!isKeyExhaustedStatus(status)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('every TinyFish key is exhausted');
}
