/**
 * TinyFish key roles and rotation.
 *
 * Two plans, two jobs (owner, 2026-11-05):
 *
 *   Hobby   (free)           30 searches/min, 150 fetches/min, Agent 2 concurrent, Browser 5
 *   Builder (paid credit)   150 searches/min, 250 fetches/min, Agent 5 concurrent, Browser 5
 *                           $0.005/search, $0.001/fetch, $0.016/agent step, $0.002/browser-min
 *
 * TINYFISH_API_KEY_2 is the Hobby account and TINYFISH_API_KEY is the Builder account. Search and
 * fetch consume the free allowance first and only spend Builder credit once Hobby is exhausted;
 * agent/browser work (job crawling) prefers Builder, where the concurrency and the per-step price
 * are what actually matter. Getting this backwards would quietly bill $0.005 for every routine
 * query that the free tier would have covered.
 *
 * Rotation: 401/402/403/429 means the key is exhausted, so try the next one and remember the key
 * that worked. A 5xx or a timeout does not burn a key.
 *
 * Do NOT try to lift keys out of omniroute: its provider_connections.api_key column is encrypted
 * at rest (its stored firecrawl blob is not a valid Firecrawl key, while omniroute itself calls
 * Firecrawl fine). Use omniroute's /v1/search endpoint instead, as the firecrawl provider does.
 */
export type TinyfishRole = 'search' | 'agent';
export type TinyfishPlan = 'free' | 'paid';

export interface TinyfishCredential { key: string; plan: TinyfishPlan }

/** Free (Hobby) first, paid (Builder) second — the order is the role-agnostic default. */
export function tinyfishCredentials(): TinyfishCredential[] {
  const env = globalThis.process?.env ?? {};
  const free = typeof env.TINYFISH_API_KEY_2 === 'string' ? env.TINYFISH_API_KEY_2.trim() : '';
  const paid = typeof env.TINYFISH_API_KEY === 'string' ? env.TINYFISH_API_KEY.trim() : '';
  const out: TinyfishCredential[] = [];
  if (free) out.push({ key: free, plan: 'free' });
  if (paid) out.push({ key: paid, plan: 'paid' });
  return out;
}

export function tinyfishKeys(): string[] {
  return tinyfishCredentials().map((c) => c.key);
}

let preferredKeyIndex = 0;

/** Credentials in the order this role should try them, starting from the one that last worked. */
export function tinyfishCredentialOrder(role: TinyfishRole = 'search'): TinyfishCredential[] {
  const creds = tinyfishCredentials();
  if (creds.length <= 1) return creds;
  // Search spends the free allowance first; agent work prefers the paid plan's concurrency.
  const ordered = role === 'agent' ? [...creds].sort((a, b) => (a.plan === 'paid' ? -1 : 0) - (b.plan === 'paid' ? -1 : 0))
    : creds;
  const start = preferredKeyIndex % ordered.length;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

export function tinyfishKeyOrder(role: TinyfishRole = 'search'): string[] {
  return tinyfishCredentialOrder(role).map((c) => c.key);
}

export function noteTinyfishKeySuccess(key: string): void {
  // Preference is tracked against the role-agnostic list so it survives role switching.
  const idx = tinyfishCredentials().findIndex((c) => c.key === key);
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

/** Run a TinyFish call, rotating to the next credential when the current one is exhausted. */
export async function runWithTinyfishKeys<T>(
  fn: (key: string, plan: TinyfishPlan) => Promise<T>,
  role: TinyfishRole = 'search',
): Promise<T> {
  const creds = tinyfishCredentialOrder(role);
  if (!creds.length) throw new Error('TINYFISH_API_KEY is not configured in environment');
  let lastError: unknown;
  for (const { key, plan } of creds) {
    try {
      const out = await fn(key, plan);
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
