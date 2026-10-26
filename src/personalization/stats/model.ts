import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { betaQuantile } from './beta.js';

// Beta-Binomial preference model. See docs/plans/personal-discovery-stats-model.md for the plain-English description.

export const MODEL_VERSION = 'stats-1';
export const SUBJECT_TYPES = ['ig_author', 'music_artist', 'rss_source', 'topic', 'venue', 'event_category', 'place_category'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type Horizon = 'long' | 'recent';
const DAY = 86_400_000;

export interface StatsConfig {
  /** Imported or live owner behaviour: success/failure weight per action. */
  actions: Record<string, { s?: number; f?: number }>;
  /** Explicit owner feedback (lasting scopes only). */
  feedbackSuccess: number;
  feedbackFailure: number;
  /** Weak failure for something displayed to the owner with no action. */
  seenFailure: number;
  /** Saved place (entity_state save). */
  placeSave: number;
  halfLifeDays: number;
  /** Max evidence mass one source may contribute to one subject; the success/failure ratio is kept. */
  sourceCap: number;
  priorMinMass: number;
  priorMinSubjects: number;
  priorMaxStrength: number;
  fallbackPrior: [number, number];
  ciLevel: number;
  /** Subject value = longWeight * long mean + (1 - longWeight) * recent mean when both exist. */
  longWeight: number;
  /** Final rank = jevWeight * jev + (1 - jevWeight) * stats when stats exist. */
  jevWeight: number;
  confidentPassLow: number;
  confidentFailHigh: number;
}

export const DEFAULT_CONFIG: StatsConfig = {
  actions: {
    like: { s: 0.5 }, save: { s: 0.5 }, comment: { s: 0.5 }, share: { s: 0.5 },
    play: { s: 0.2 }, skip: { f: 0.2 },
    not_interested: { f: 0.5 }, dislike: { f: 0.5 },
  },
  feedbackSuccess: 1.0,
  feedbackFailure: 1.0,
  seenFailure: 0.05,
  placeSave: 0.5,
  halfLifeDays: 90,
  sourceCap: 30,
  priorMinMass: 3,
  priorMinSubjects: 8,
  priorMaxStrength: 50,
  fallbackPrior: [1, 1],
  ciLevel: 0.9,
  longWeight: 0.6,
  jevWeight: 0.6,
  confidentPassLow: 0.7,
  confidentFailHigh: 0.2,
};

const num = (v: string | undefined, d: number) => { const n = v === undefined ? NaN : Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export function statsConfig(over: Partial<StatsConfig> = {}): StatsConfig {
  const e = process.env;
  return { ...DEFAULT_CONFIG, halfLifeDays: num(e.PHROG_STATS_HALF_LIFE_DAYS, DEFAULT_CONFIG.halfLifeDays), sourceCap: num(e.PHROG_STATS_SOURCE_CAP, DEFAULT_CONFIG.sourceCap),
    jevWeight: Math.min(1, num(e.PHROG_STATS_JEV_WEIGHT, DEFAULT_CONFIG.jevWeight)), ...over };
}

// ---------- subjects ----------

export interface Subj { type: SubjectType; key: string }
const lower = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '');
const parse = (s: unknown): any => { if (typeof s !== 'string' || !s) return null; try { return JSON.parse(s); } catch { return null; } };

export interface ItemRow { provider: string | null; ct: string | null; author_json: string | null; hashtags_json: string | null; venue: string | null; category: string | null }

/** The provider that decides how an item's author is read. Order matters when an item has several ids. */
export function pickProvider(providers: string[]): string | null {
  for (const p of ['instagram', 'spotify', 'apple_music', 'rss']) if (providers.includes(p)) return p;
  return null;
}

export function authorSubject(r: ItemRow): Subj | null {
  const a = parse(r.author_json);
  if (r.provider === 'instagram') { const k = lower(r.ct ?? a?.handle); return k ? { type: 'ig_author', key: k.slice(0, 80) } : null; }
  if (r.provider === 'spotify' || r.provider === 'apple_music') { const k = lower(a?.artist ?? r.ct); return k ? { type: 'music_artist', key: k.slice(0, 80) } : null; }
  if (r.provider === 'rss') { const k = lower(a?.name); return k ? { type: 'rss_source', key: k.slice(0, 80) } : null; }
  return null;
}

export function hashtagSubjects(r: ItemRow): Subj[] {
  const h = parse(r.hashtags_json);
  if (!Array.isArray(h)) return [];
  const out: Subj[] = [];
  for (const t of h.slice(0, 10)) {
    const k = lower(String(t).replace(/^#/, ''));
    if (k.length >= 2 && k.length <= 40 && !/^\d+$/.test(k)) out.push({ type: 'topic', key: k });
  }
  return out;
}

export function itemSubjects(r: ItemRow): Subj[] {
  const out: Subj[] = [];
  const a = authorSubject(r);
  if (a) out.push(a);
  const v = lower(r.venue);
  if (v) out.push({ type: 'venue', key: v.slice(0, 80) });
  const c = lower(r.category);
  if (c) out.push({ type: 'event_category', key: c.slice(0, 40) });
  out.push(...hashtagSubjects(r));
  return out;
}

const ITEM_SQL = `SELECT i.id, i.title, i.description, i.author_json, i.hashtags_json, c.title ct, e.venue_text venue, e.category category,
  (SELECT group_concat(provider) FROM item_ids x WHERE x.item_id = i.id) providers
  FROM items i LEFT JOIN items c ON c.id = i.creator_item_id LEFT JOIN event_details e ON e.item_id = i.id`;

export function loadItemRow(d: DatabaseSync, itemId: string): (ItemRow & { text: string }) | null {
  const r = d.prepare(`${ITEM_SQL} WHERE i.id = ?`).get(itemId) as any;
  if (!r) return null;
  return { provider: pickProvider(String(r.providers ?? '').split(',')), ct: r.ct, author_json: r.author_json, hashtags_json: r.hashtags_json, venue: r.venue, category: r.category,
    text: lower(`${r.title ?? ''} ${r.description ?? ''}`) };
}

// ---------- evidence ----------

interface SrcAgg { ls: number; lf: number; rs: number; rf: number }
interface SubjAgg { type: SubjectType; key: string; src: Map<string, SrcAgg>; n: number; days: Set<string> }
type Acc = Map<string, SubjAgg>;

export interface Evidence {
  acc: Acc;
  newest: Record<string, string>;
  rowsRead: Record<string, number>;
  inputsCutoff: string | null;
}

/**
 * Collect weighted evidence. `before` (ISO time) keeps only evidence strictly earlier, for the chronological evaluation.
 * Reads: owner behaviour observations with learn=1, saved places, owner feedback with a lasting scope, and deliveries
 * that were actually displayed. agent_decisions are never read. Unshown deliveries and unseen items add nothing.
 */
export function collectEvidence(d: DatabaseSync, cfg: StatsConfig, before: string | null = null): Evidence {
  const acc: Acc = new Map();
  const newest: Record<string, string> = {};
  const rowsRead: Record<string, number> = {};
  const b = before;

  // Newest evidence time per source first, so recent-horizon decay is relative to that source's own latest data.
  const noteNewest = (src: string, at: string | null) => { if (at && (!newest[src] || at > newest[src])) newest[src] = at; };
  const actionList = [...Object.keys(cfg.actions), 'seen_in_feed'].map((a) => `'${a}'`).join(',');
  const obsSource = `CASE WHEN o.action = 'seen_in_feed' THEN a.provider || '_live' ELSE a.provider END`;
  const PROVIDERS = `'instagram','spotify','apple_music','rss'`;
  for (const r of d.prepare(`SELECT ${obsSource} src, MAX(o.occurred_at) m FROM observations o JOIN source_accounts a ON a.id = o.source_account_id
      WHERE o.learn = 1 AND a.provider IN (${PROVIDERS}) AND o.action IN (${actionList}) AND (? IS NULL OR o.occurred_at < ?) GROUP BY 1`).all(b, b) as any[]) noteNewest(r.src, r.m);
  for (const r of d.prepare(`SELECT 'owner_feedback' src, MAX(created_at) m FROM feedback WHERE (? IS NULL OR created_at < ?)
    UNION ALL SELECT 'discover', MAX(displayed_at) FROM deliveries WHERE displayed_at IS NOT NULL AND (? IS NULL OR displayed_at < ?)
    UNION ALL SELECT 'saved_places', MAX(effective_at) FROM entity_state WHERE relation = 'save' AND state = 'active' AND (? IS NULL OR effective_at < ?)`).all(b, b, b, b, b, b) as any[]) noteNewest(r.src, r.m);

  const decay = (src: string, at: string | null): number => {
    const n = newest[src];
    if (!at || !n) return 0;
    const age = Date.parse(n) - Date.parse(at);
    return Number.isFinite(age) ? Math.pow(0.5, Math.max(0, age) / (cfg.halfLifeDays * DAY)) : 0;
  };
  const add = (s: Subj, src: string, at: string | null, ws: number, wf: number) => {
    const id = `${s.type}\x1f${s.key}`;
    let e = acc.get(id);
    if (!e) acc.set(id, (e = { type: s.type, key: s.key, src: new Map(), n: 0, days: new Set() }));
    let a = e.src.get(src);
    if (!a) e.src.set(src, (a = { ls: 0, lf: 0, rs: 0, rf: 0 }));
    const dc = decay(src, at);
    a.ls += ws; a.lf += wf; a.rs += ws * dc; a.rf += wf * dc;
    e.n++;
    if (at) e.days.add(at.slice(0, 10));
  };
  const count = (k: string) => { rowsRead[k] = (rowsRead[k] ?? 0) + 1; };

  // 1. Owner behaviour. seen_in_feed is a weak failure only when nothing else happened to that item (no positive action, no feedback).
  const seenOk = `NOT EXISTS (SELECT 1 FROM observations p WHERE p.item_id = o.item_id AND p.id <> o.id AND p.learn = 1 AND p.action IN ('like','save','comment','share')
      AND (? IS NULL OR p.occurred_at < ?)) AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.item_id = o.item_id AND (? IS NULL OR f.created_at < ?))`;
  const obsSql = `SELECT o.action, o.occurred_at at, ${obsSource} src, a.provider, c.title ct, i.author_json, i.hashtags_json
    FROM observations o JOIN source_accounts a ON a.id = o.source_account_id JOIN items i ON i.id = o.item_id LEFT JOIN items c ON c.id = i.creator_item_id
    WHERE o.learn = 1 AND a.provider IN (${PROVIDERS}) AND o.action IN (${actionList}) AND (? IS NULL OR o.occurred_at < ?)
      AND (o.action <> 'seen_in_feed' OR (COALESCE(o.sponsored, 0) = 0 AND ${seenOk})) ORDER BY o.id`;
  for (const r of d.prepare(obsSql).iterate(b, b, b, b, b, b) as Iterable<any>) {
    const w = r.action === 'seen_in_feed' ? { f: cfg.seenFailure } : cfg.actions[r.action];
    if (!w) continue;
    const row: ItemRow = { provider: r.provider, ct: r.ct, author_json: r.author_json, hashtags_json: r.hashtags_json, venue: null, category: null };
    const subs = [authorSubject(row), ...hashtagSubjects(row)].filter((x): x is Subj => !!x);
    if (!subs.length) continue;
    count(r.src);
    for (const s of subs) add(s, r.src, r.at, w.s ?? 0, w.f ?? 0);
  }

  // 2. Saved places: the list the owner saved the place to is the category.
  for (const r of d.prepare(`SELECT LOWER(TRIM(e.counterparty)) cat, e.effective_at at FROM entity_state e JOIN items i ON i.id = e.item_id
      WHERE e.relation = 'save' AND e.state = 'active' AND i.kind = 'venue' AND e.counterparty IS NOT NULL AND (? IS NULL OR e.effective_at < ?) ORDER BY e.id`).iterate(b, b) as Iterable<any>) {
    if (!r.cat) continue;
    count('saved_places');
    add({ type: 'place_category', key: String(r.cat).slice(0, 60) }, 'saved_places', r.at, cfg.placeSave, 0);
  }

  // 3. Explicit owner feedback. Only lasting scopes and only like/save/want_to_go/dislike. this_time and the situational types are ignored.
  for (const r of d.prepare(`${ITEM_SQL.replace('SELECT i.id,', 'SELECT f.type ftype, f.scope, f.reason, f.created_at at, i.id,')} JOIN feedback f ON f.item_id = i.id
      WHERE f.scope IN ('item','creator','topic','venue') AND f.type IN ('like','save','want_to_go','dislike') AND (? IS NULL OR f.created_at < ?) ORDER BY f.created_at, f.id`).iterate(b, b) as Iterable<any>) {
    const pos = r.ftype !== 'dislike';
    const row: ItemRow = { provider: pickProvider(String(r.providers ?? '').split(',')), ct: r.ct, author_json: r.author_json, hashtags_json: r.hashtags_json, venue: r.venue, category: r.category };
    let subs: Subj[] = [];
    if (r.scope === 'item') subs = itemSubjects(row);
    else if (r.scope === 'creator') subs = [authorSubject(row)].filter((x): x is Subj => !!x);
    else if (r.scope === 'venue') subs = itemSubjects(row).filter((s) => s.type === 'venue');
    else { const k = lower(r.reason).slice(0, 60); if (k) subs = [{ type: 'topic', key: k }]; }
    if (!subs.length) continue;
    count('owner_feedback');
    for (const s of subs) add(s, 'owner_feedback', r.at, pos ? cfg.feedbackSuccess : 0, pos ? 0 : cfg.feedbackFailure);
  }

  // 4. Events actually displayed to the owner and left without any feedback: weak failure. Returned-but-not-displayed adds nothing.
  for (const r of d.prepare(`${ITEM_SQL.replace('SELECT i.id,', 'SELECT dl.displayed_at at, i.id,')} JOIN deliveries dl ON dl.item_id = i.id
      WHERE dl.displayed_at IS NOT NULL AND (? IS NULL OR dl.displayed_at < ?)
      AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.item_id = i.id AND (? IS NULL OR f.created_at < ?)) ORDER BY dl.displayed_at, dl.id`).iterate(b, b, b, b) as Iterable<any>) {
    const row: ItemRow = { provider: pickProvider(String(r.providers ?? '').split(',')), ct: r.ct, author_json: r.author_json, hashtags_json: r.hashtags_json, venue: r.venue, category: r.category };
    const subs = itemSubjects(row);
    if (!subs.length) continue;
    count('discover');
    for (const s of subs) add(s, 'discover', r.at, 0, cfg.seenFailure);
  }

  const inputsCutoff = Object.values(newest).sort().pop() ?? null;
  return { acc, newest, rowsRead, inputsCutoff };
}

// ---------- fitting ----------

export interface Prior { alpha: number; beta: number; mean: number; strength: number; method: 'mom' | 'fallback'; subjects: number }
export interface Posterior {
  subject_type: SubjectType; subject_key: string; horizon: Horizon;
  alpha: number; beta: number; mean: number; ci_low: number; ci_high: number; n_eff: number; evidence_count: number; distinct_days: number;
}
export interface Fit { posteriors: Posterior[]; priors: Record<string, Prior>; counts: Record<string, { long: number; recent: number }> }

interface Mass { s: number; f: number }

function capped(a: SubjAgg, h: Horizon, cap: number): Mass {
  let s = 0, f = 0;
  for (const src of [...a.src.keys()].sort()) {
    const x = a.src.get(src)!;
    const ss = h === 'long' ? x.ls : x.rs, ff = h === 'long' ? x.lf : x.rf;
    const mass = ss + ff;
    const k = mass > cap ? cap / mass : 1;
    s += ss * k; f += ff * k;
  }
  return { s, f };
}

/** Method-of-moments Beta prior on the long-horizon rates of subjects with enough evidence; Beta(1,1) when that is not possible. */
export function estimatePrior(masses: Mass[], cfg: StatsConfig): Prior {
  const fallback: Prior = { alpha: cfg.fallbackPrior[0], beta: cfg.fallbackPrior[1], mean: cfg.fallbackPrior[0] / (cfg.fallbackPrior[0] + cfg.fallbackPrior[1]),
    strength: cfg.fallbackPrior[0] + cfg.fallbackPrior[1], method: 'fallback', subjects: 0 };
  const el = masses.filter((m) => m.s + m.f >= cfg.priorMinMass);
  fallback.subjects = el.length;
  if (el.length < cfg.priorMinSubjects) return fallback;
  const p = el.map((m) => m.s / (m.s + m.f));
  const mean = p.reduce((x, y) => x + y, 0) / p.length;
  const v = p.reduce((x, y) => x + (y - mean) ** 2, 0) / (p.length - 1);
  const r = el.reduce((x, m) => x + 1 / (m.s + m.f), 0) / el.length;
  const q = mean * (1 - mean);
  if (!(mean > 0.1 && mean < 0.9) || !(q - v > 0)) return fallback;
  const den = v - q * r;
  const kappa = den <= 0 ? cfg.priorMaxStrength : Math.min(cfg.priorMaxStrength, Math.max(1, (q - v) / den));
  return { alpha: mean * kappa, beta: (1 - mean) * kappa, mean, strength: kappa, method: 'mom', subjects: el.length };
}

export function fitModel(ev: Evidence, cfg: StatsConfig): Fit {
  const byType = new Map<SubjectType, SubjAgg[]>();
  for (const a of [...ev.acc.values()].sort((x, y) => (x.type + x.key < y.type + y.key ? -1 : 1))) {
    const l = byType.get(a.type) ?? [];
    l.push(a);
    byType.set(a.type, l);
  }
  const lo = (1 - cfg.ciLevel) / 2, hi = 1 - lo;
  const priors: Record<string, Prior> = {};
  const posteriors: Posterior[] = [];
  const counts: Fit['counts'] = {};
  for (const type of SUBJECT_TYPES) {
    const list = byType.get(type);
    if (!list) continue;
    const prior = estimatePrior(list.map((a) => capped(a, 'long', cfg.sourceCap)), cfg);
    priors[type] = prior;
    counts[type] = { long: 0, recent: 0 };
    for (const a of list) {
      for (const horizon of ['long', 'recent'] as const) {
        const m = capped(a, horizon, cfg.sourceCap);
        if (m.s + m.f < 1e-9) continue;
        const alpha = prior.alpha + m.s, beta = prior.beta + m.f;
        posteriors.push({ subject_type: type, subject_key: a.key, horizon, alpha, beta, mean: alpha / (alpha + beta),
          ci_low: betaQuantile(lo, alpha, beta), ci_high: betaQuantile(hi, alpha, beta), n_eff: m.s + m.f, evidence_count: a.n, distinct_days: a.days.size });
        counts[type][horizon]++;
      }
    }
  }
  return { posteriors, priors, counts };
}

// ---------- persistence ----------

export interface RebuildStatsResult { runId: string; fit: Fit; inputsCutoff: string | null; rowsRead: Record<string, number>; runtimeMs: number; config: StatsConfig }

export function fitFromDb(d: DatabaseSync, cfg: StatsConfig = statsConfig(), before: string | null = null) {
  const ev = collectEvidence(d, cfg, before);
  return { ev, fit: fitModel(ev, cfg) };
}

/** Replace the `preferences` rows with the fitted posteriors and record the run. `summaryVersion` fills the legacy `version` column. */
export function persistFit(d: DatabaseSync, res: { ev: Evidence; fit: Fit }, cfg: StatsConfig, now: string, summaryVersion: string, startedMs: number): RebuildStatsResult {
  const runId = `pmr_${randomUUID()}`;
  const runtimeMs = Date.now() - startedMs;
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM preferences');
    const ins = d.prepare(`INSERT INTO preferences (subject_type, subject_key, horizon, score, evidence_count, distinct_days, computed_at, version,
      alpha, beta, mean, ci_low, ci_high, n_eff, model_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of res.fit.posteriors) {
      ins.run(p.subject_type, p.subject_key, p.horizon, p.mean, p.evidence_count, p.distinct_days, now, summaryVersion, p.alpha, p.beta, p.mean, p.ci_low, p.ci_high, p.n_eff, MODEL_VERSION);
    }
    d.prepare('INSERT INTO preference_model_runs (id, model_version, computed_at, inputs_cutoff, config_json, counts_json, priors_json, runtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, MODEL_VERSION, now, res.ev.inputsCutoff, JSON.stringify(cfg), JSON.stringify({ subjects: res.fit.counts, evidence_rows: res.ev.rowsRead, newest_by_source: res.ev.newest }),
        JSON.stringify(res.fit.priors), runtimeMs);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { runId, fit: res.fit, inputsCutoff: res.ev.inputsCutoff, rowsRead: res.ev.rowsRead, runtimeMs, config: cfg };
}

// ---------- lookup and scoring ----------

export interface PostPair { long?: Posterior; recent?: Posterior }
export interface Lookup {
  get(type: SubjectType, key: string): PostPair;
  /** Topic subjects (long horizon) most backed by evidence, for matching free text. */
  topicKeys(): string[];
  priorMean(type: SubjectType): number;
}

export function memoryLookup(fit: Fit): Lookup {
  const m = new Map<string, PostPair>();
  for (const p of fit.posteriors) {
    const id = `${p.subject_type}\x1f${p.subject_key}`;
    const e = m.get(id) ?? {};
    e[p.horizon] = p;
    m.set(id, e);
  }
  const topics = fit.posteriors.filter((p) => p.subject_type === 'topic' && p.horizon === 'long' && p.subject_key.length >= 3).sort((a, b) => b.n_eff - a.n_eff).slice(0, 2000).map((p) => p.subject_key);
  return { get: (t, k) => m.get(`${t}\x1f${k}`) ?? {}, topicKeys: () => topics, priorMean: (t) => fit.priors[t]?.mean ?? 0.5 };
}

export function dbLookup(d: DatabaseSync): Lookup {
  const q = d.prepare('SELECT subject_type, subject_key, horizon, alpha, beta, mean, ci_low, ci_high, n_eff, evidence_count, distinct_days FROM preferences WHERE subject_type = ? AND subject_key = ? AND alpha IS NOT NULL');
  let topics: string[] | null = null;
  let priors: Record<string, Prior> | null = null;
  return {
    get(type, key) {
      const out: PostPair = {};
      for (const r of q.all(type, key) as any[]) out[r.horizon as Horizon] = { ...r };
      return out;
    },
    topicKeys() {
      topics ??= (d.prepare("SELECT subject_key k FROM preferences WHERE subject_type = 'topic' AND horizon = 'long' AND alpha IS NOT NULL AND length(subject_key) >= 3 ORDER BY n_eff DESC, subject_key LIMIT 2000").all() as any[]).map((r) => r.k);
      return topics;
    },
    priorMean(type) {
      if (!priors) {
        const r = d.prepare('SELECT priors_json FROM preference_model_runs ORDER BY computed_at DESC, rowid DESC LIMIT 1').get() as any;
        priors = r ? JSON.parse(r.priors_json) : {};
      }
      return priors![type]?.mean ?? 0.5;
    },
  };
}

export interface StatsMatch { subject_type: SubjectType; key: string; mean: number; ci: [number, number]; n_eff: number }
export interface StatsResult { score: number; ci_low: number; ci_high: number; matched: StatsMatch[] }
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Evidence-weighted mean of the matched posteriors (weight = long-horizon n_eff). null when nothing matches. */
export function scoreSubjects(subjects: Subj[], text: string, lookup: Lookup, cfg: StatsConfig): StatsResult | null {
  const seen = new Set<string>();
  const all: Subj[] = [];
  for (const s of subjects) { const id = `${s.type}\x1f${s.key}`; if (!seen.has(id)) { seen.add(id); all.push(s); } }
  if (text) for (const k of lookup.topicKeys()) { const id = `topic\x1f${k}`; if (!seen.has(id) && text.includes(k)) { seen.add(id); all.push({ type: 'topic', key: k }); } }
  const matched: StatsMatch[] = [];
  let w = 0, sm = 0, sl = 0, sh = 0;
  for (const s of all) {
    const p = lookup.get(s.type, s.key);
    if (!p.long) continue;
    const mix = (a: number, b: number | undefined) => (p.recent && b !== undefined ? cfg.longWeight * a + (1 - cfg.longWeight) * b : a);
    const mean = mix(p.long.mean, p.recent?.mean), lo = mix(p.long.ci_low, p.recent?.ci_low), hi = mix(p.long.ci_high, p.recent?.ci_high);
    const wt = Math.max(p.long.n_eff, 0.01);
    w += wt; sm += wt * mean; sl += wt * lo; sh += wt * hi;
    matched.push({ subject_type: s.type, key: s.key.slice(0, 60), mean: r4(mean), ci: [r4(lo), r4(hi)], n_eff: r4(p.long.n_eff) });
  }
  if (!matched.length) return null;
  matched.sort((a, b) => b.n_eff - a.n_eff || (a.key < b.key ? -1 : 1));
  return { score: r4(sm / w), ci_low: r4(sl / w), ci_high: r4(sh / w), matched: matched.slice(0, 8) };
}

export function statsForItem(d: DatabaseSync, lookup: Lookup, itemId: string, cfg: StatsConfig = statsConfig()): StatsResult | null {
  const row = loadItemRow(d, itemId);
  return row ? scoreSubjects(itemSubjects(row), row.text, lookup, cfg) : null;
}

/** Public shape for feed.v1 / discover.v1. */
export const publicStats = (s: StatsResult | null) => (s ? { score: s.score, matched: s.matched.map((m) => ({ subject_type: m.subject_type, key: m.key, mean: m.mean, ci: m.ci })) } : null);

/** 0.6 * jev + 0.4 * stats when stats exist, else jev alone. */
export function blend(jev: number, stats: StatsResult | null, cfg: StatsConfig = statsConfig()): number {
  return stats ? cfg.jevWeight * jev + (1 - cfg.jevWeight) * stats.score : jev;
}

/** Confident stats override the Jev threshold: pass when the interval is clearly high, fail when clearly low. */
export function confident(stats: StatsResult | null, cfg: StatsConfig = statsConfig()): 'pass' | 'fail' | null {
  if (!stats) return null;
  if (stats.ci_low > cfg.confidentPassLow) return 'pass';
  if (stats.ci_high < cfg.confidentFailHigh) return 'fail';
  return null;
}
