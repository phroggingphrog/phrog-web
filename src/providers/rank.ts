// Engine-level reciprocal-rank fusion, ported from the mechanism measured in
// fangchenghao/dsh-web-search (docs/rrf-ranking.md).
//
// Why this module exists: the provider-level fusion in search.ts scores each provider's
// *list position* (1/(k+index+1)). When only one provider answers — the common case, since
// TinyFish is a fallback — that collapses to a monotonic transform of that provider's order
// and reorders nothing. SearXNG already reports per-ENGINE positions, which is the signal
// worth fusing: a row found at rank 1 by two engines should beat a row one engine listed
// first only because its snippet was shorter.
//
//   vote  = 1 / (rrfConstant + position)
//   score = Σ engineWeight(e) * vote
//         + authorityBoost * isOfficialDomain(host, query)
//         + freshnessBoost * freshness(publishedDate, freshnessDays)
//
// RRF is used instead of score normalisation because engines report scores on
// incomparable scales (or not at all); ranks are the only honest shared signal.

export interface RrfKnobs {
  /** Larger values flatten the influence of a single engine's top slot. */
  rrfConstant: number;
  /** Weight added when the host looks like the official source for the query. */
  authorityBoost: number;
  /** Weight added for pages published inside `freshnessDays`. */
  freshnessBoost: number;
  freshnessDays: number;
}

export const DEFAULT_RRF: RrfKnobs = {
  rrfConstant: 60,
  authorityBoost: 0.25,
  freshnessBoost: 0.2,
  freshnessDays: 30,
};

/** Engine weights; anything unlisted is 1. Precision outliers can be lifted here. */
export const DEFAULT_ENGINE_WEIGHTS: Record<string, number> = { anysearch: 2 };

export interface EngineRankedRow {
  url: string;
  title?: string;
  content?: string;
  /** Engines that returned this row (SearXNG `engines`). */
  engines?: string[];
  /** Parallel 1-based ranks (SearXNG `positions`). */
  positions?: number[];
  publishedDate?: string | null;
  [key: string]: unknown;
}

export interface FusedRow extends EngineRankedRow {
  score: number;
  engines: string[];
}

const DOC_HOSTS = new Set([
  'github.com', 'developer.mozilla.org', 'kubernetes.io', 'docs.docker.com', 'podman.io',
  'python.org', 'docs.python.org', 'pypi.org', 'npmjs.com', 'crates.io', 'docs.rs',
  'go.dev', 'pkg.go.dev', 'rust-lang.org', 'doc.rust-lang.org', 'postgresql.org',
  'nodejs.org', 'kernel.org', 'man7.org', 'archlinux.org', 'debian.org', 'ubuntu.com',
  'serverfault.com', 'stackoverflow.com',
]);

const DOC_PREFIXES = ['docs.', 'doc.', 'developer.', 'developers.', 'learn.', 'api.', 'wiki.', 'man.'];
const DOC_SUFFIXES = ['.readthedocs.io', '.gitbook.io', '.docs.io'];

/** Strip `www.` and lowercase, so host comparisons are stable. */
export function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * 1 when the host is plausibly the canonical source for the query, else 0.
 * Two signals only — a curated doc-host set with prefix/suffix rules, and the
 * "the query names this project" test (query token == host's leading label), which is
 * what promotes docs.podman.io for "podman quadlet" without special-casing it.
 */
export function officialDomainScore(host: string, queryTokens: readonly string[]): number {
  const h = normaliseHost(host);
  if (DOC_HOSTS.has(h)) return 1;
  if (DOC_SUFFIXES.some((s) => h.endsWith(s))) return 1;
  if (DOC_PREFIXES.some((p) => h.startsWith(p))) return 1;
  const label = h.split('.')[0];
  return queryTokens.includes(label) ? 1 : 0;
}

/**
 * 1 for a page published now, decaying linearly to 0 at `freshnessDays`.
 * An unparseable or missing date scores 0 — the ranker cannot invent recency, which is a
 * documented limit rather than a silent default.
 */
export function freshnessScore(publishedDate: string | null | undefined, freshnessDays: number, now = Date.now()): number {
  if (!publishedDate) return 0;
  const ts = Date.parse(publishedDate);
  if (Number.isNaN(ts)) return 0;
  const ageDays = (now - ts) / 86_400_000;
  if (ageDays < 0) return 1;
  if (freshnessDays <= 0) return 0;
  return Math.max(0, 1 - ageDays / freshnessDays);
}

/** Canonical form used for de-duplication: no hash, lowercase host, no trailing slash. */
export function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
    return u.toString();
  } catch {
    return url;
  }
}

export function tokeniseQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Fuse rows by their per-engine positions. Rows with no `engines`/`positions` fall back to
 * their order in the input, so a single-engine provider still ranks sensibly.
 */
export function fuseEngineRanks(
  rows: readonly EngineRankedRow[],
  knobs: Partial<RrfKnobs> = {},
  engineWeights: Record<string, number> = DEFAULT_ENGINE_WEIGHTS,
  query = '',
  now = Date.now(),
): FusedRow[] {
  const k = { ...DEFAULT_RRF, ...knobs };
  const tokens = tokeniseQuery(query);
  const fused = new Map<string, FusedRow>();

  rows.forEach((row, index) => {
    if (!row || typeof row.url !== 'string' || !row.url) return;
    const key = canonicalKey(row.url);
    const engines = Array.isArray(row.engines) && row.engines.length ? row.engines : [];
    const positions = Array.isArray(row.positions) && row.positions.length ? row.positions : [];

    let vote = 0;
    if (engines.length && positions.length) {
      engines.forEach((engine, i) => {
        const position = Number(positions[i]);
        const pos = Number.isFinite(position) && position > 0 ? position : i + 1;
        vote += (engineWeights[engine] ?? 1) / (k.rrfConstant + pos);
      });
    } else {
      const single = typeof row.engine === 'string' ? row.engine : '';
      vote = (engineWeights[single] ?? 1) / (k.rrfConstant + index + 1);
    }

    const host = safeHost(row.url);
    // Boosts are expressed in VOTE UNITS, not raw score. A single top-rank vote is
    // 1/(rrfConstant+1) = 0.0164 at k=60, so adding the upstream 0.25 directly would
    // outweigh ~15 votes and turn the ranker into an authority-only sorter. Scaling by
    // one top-rank vote keeps the fused rank primary and the boosts as genuine tiebreakers.
    const voteUnit = 1 / (k.rrfConstant + 1);
    const boost =
      voteUnit * (
        k.authorityBoost * (host ? officialDomainScore(host, tokens) : 0) +
        k.freshnessBoost * freshnessScore(row.publishedDate, k.freshnessDays, now)
      );

    const existing = fused.get(key);
    if (existing) {
      existing.score += vote + boost;
      for (const e of engines) if (!existing.engines.includes(e)) existing.engines.push(e);
      if (!existing.content && row.content) existing.content = row.content;
      if (!existing.publishedDate && row.publishedDate) existing.publishedDate = row.publishedDate;
      return;
    }
    fused.set(key, {
      ...row,
      engines: [...engines],
      score: vote + boost,
    });
  });

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

function safeHost(url: string): string {
  try {
    return normaliseHost(new URL(url).hostname);
  } catch {
    return '';
  }
}
