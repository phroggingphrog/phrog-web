import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readTaste } from './jev.js';
import { personalDb } from './feed.js';
import { fitFromDb, persistFit, statsConfig, type Fit, type Posterior, type SubjectType } from './stats/model.js';

export class PreferenceInputError extends Error {}

export const SUMMARY_MAX_CHARS = 2500;

export const RULES = ['prefer', 'avoid', 'exclude'] as const;
export type RuleKind = (typeof RULES)[number];

const POSITIVE = new Set(['like', 'save', 'want_to_go']);
const lower = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '');

export interface RebuildResult {
  version: string;
  length: number;
  text: string;
  counts: Record<string, { long: number; recent: number }>;
  run_id: string;
  runtime_ms: number;
  priors: Fit['priors'];
}

/**
 * Rebuild the derived preference rows (Beta posteriors, see stats/model.ts) and the compact summary from scratch.
 * Evidence is owner behaviour and explicit owner feedback only; agent decisions are never read. Same data and taste text give
 * the same rows and the same summary version.
 */
export function rebuildPreferences(d: DatabaseSync, now: string = new Date().toISOString()): RebuildResult {
  const t0 = Date.now();
  const cfg = statsConfig();
  const res = fitFromDb(d, cfg);
  const text = buildSummary(d, res.fit, now);
  const version = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const run = persistFit(d, res, cfg, now, version, t0);
  d.prepare('INSERT INTO preference_summary (id, version, text, computed_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, text = excluded.text, computed_at = excluded.computed_at')
    .run(version, text, now);
  return { version, length: text.length, text, counts: res.fit.counts, run_id: run.runId, runtime_ms: run.runtimeMs, priors: res.fit.priors };
}

const LIKE_LABEL: Record<string, string> = {
  ig_author: 'Instagram authors', music_artist: 'Music artists', rss_source: 'Feed sources', topic: 'Topics', venue: 'Venues',
  event_category: 'Event categories', place_category: 'Saved place categories',
};
const DISLIKE_TYPES = ['ig_author', 'rss_source', 'topic', 'venue', 'event_category'] as const;

function buildSummary(d: DatabaseSync, fit: Fit, now: string): string {
  const taste = readTaste();
  const rules = activeRules(d, now);
  const by = (k: string) => rules.filter((r) => r.rule === k).map((r) => `${r.subject_key}`.slice(0, 40));
  const pm = (t: string) => fit.priors[t]?.mean ?? 0.5;
  const of = (type: string, horizon: 'long' | 'recent') => fit.posteriors.filter((p) => p.subject_type === type && p.horizon === horizon);
  const fmt = (p: Posterior) => `${p.subject_key.slice(0, 40)} (${p.mean.toFixed(2)})`;
  // Strong likes: the credible interval sits above the type's typical rate.
  const likes = (type: string, horizon: 'long' | 'recent', n: number) => of(type, horizon).filter((p) => p.ci_low > pm(type))
    .sort((a, b) => b.ci_low - a.ci_low || (a.subject_key < b.subject_key ? -1 : 1)).slice(0, n).map(fmt);
  // Confident dislikes: the interval sits below the type's typical rate.
  const dislikes = (type: string, n: number) => of(type, 'long').filter((p) => p.ci_high < pm(type))
    .sort((a, b) => a.ci_high - b.ci_high || (a.subject_key < b.subject_key ? -1 : 1)).slice(0, n).map((p) => p.subject_key.slice(0, 40));
  const make = (n: number, tasteChars: number) => {
    const lines: string[] = [];
    if (taste && tasteChars > 0) lines.push(`Owner's own words: ${taste.replace(/\s+/g, ' ').slice(0, tasteChars)}`);
    const ruleLine = (['prefer', 'avoid', 'exclude'] as const).map((k) => (by(k).length ? `${k}: ${by(k).slice(0, 12).join(', ')}` : '')).filter(Boolean).join('; ');
    if (ruleLine) lines.push(`Explicit rules: ${ruleLine}`);
    const sec = (label: string, items: string[]) => { if (items.length) lines.push(`${label}: ${items.join(', ')}`); };
    for (const type of ['ig_author', 'music_artist', 'rss_source', 'topic', 'venue', 'event_category', 'place_category'] as SubjectType[]) {
      sec(`${LIKE_LABEL[type]} the owner clearly likes (estimated rate)`, likes(type, 'long', type === 'topic' || type === 'venue' || type === 'event_category' || type === 'rss_source' ? Math.ceil(n * 0.5) : n));
      if (type === 'ig_author' || type === 'music_artist') sec(`${LIKE_LABEL[type]}, recent months`, likes(type, 'recent', Math.ceil(n * 0.7)));
    }
    sec('Owner clearly does not like', DISLIKE_TYPES.flatMap((t) => dislikes(t, 5)).slice(0, 12));
    return lines.join('\n');
  };
  for (const [n, t] of [[12, 700], [10, 600], [8, 500], [6, 400], [4, 300], [2, 200], [0, 100]] as const) {
    const s = make(n, t);
    if (s.length <= SUMMARY_MAX_CHARS) return s;
  }
  return make(0, 0).slice(0, SUMMARY_MAX_CHARS);
}

// ---- explicit rules ----

export interface Rule { id: string; subject_type: string; subject_key: string; rule: RuleKind | string; value: string | null; valid_until: string | null; note: string | null; created_at: string }

export function activeRules(d: DatabaseSync, now: string = new Date().toISOString()): Rule[] {
  return d.prepare('SELECT * FROM preference_rules WHERE valid_until IS NULL OR valid_until > ? ORDER BY created_at, id').all(now) as unknown as Rule[];
}

export function setRule(d: DatabaseSync, r: { rule: string; subject_key: string; subject_type?: string; valid_until?: string; note?: string }): Rule & { duplicate: boolean } {
  if (!RULES.includes(r.rule as RuleKind)) throw new PreferenceInputError(`rule must be one of ${RULES.join(', ')}`);
  const key = lower(r.subject_key);
  if (!key || key.length > 80) throw new PreferenceInputError('subject_key must be 1..80 characters');
  const type = r.subject_type ?? 'keyword';
  if (!/^[a-z_]{1,24}$/.test(type)) throw new PreferenceInputError('subject_type must be 1..24 lowercase letters');
  if (r.valid_until !== undefined && Number.isNaN(Date.parse(r.valid_until))) throw new PreferenceInputError('valid_until must be a date');
  const now = new Date().toISOString();
  const dup = d.prepare('SELECT * FROM preference_rules WHERE subject_type = ? AND subject_key = ? AND rule = ? AND (valid_until IS NULL OR valid_until > ?)').get(type, key, r.rule, now) as any;
  if (dup) return { ...dup, duplicate: true };
  const row: Rule = { id: `rule_${randomUUID()}`, subject_type: type, subject_key: key, rule: r.rule, value: null,
    valid_until: r.valid_until ? new Date(r.valid_until).toISOString() : null, note: r.note ? String(r.note).slice(0, 500) : null, created_at: now };
  d.prepare('INSERT INTO preference_rules (id, subject_type, subject_key, rule, value, valid_until, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.subject_type, row.subject_key, row.rule, row.value, row.valid_until, row.note, row.created_at);
  return { ...row, duplicate: false };
}

export function removeRule(d: DatabaseSync, id: string): boolean {
  return Number(d.prepare('DELETE FROM preference_rules WHERE id = ?').run(id).changes) === 1;
}

/** Stored summary, rows (top 10 per type/horizon) and active rules, for the read side of personal_preferences. */
export function readPreferences(d: DatabaseSync) {
  const s = d.prepare('SELECT version, text, computed_at FROM preference_summary WHERE id = 1').get() as any;
  const rows = d.prepare('SELECT subject_type, subject_key, horizon, mean, ci_low, ci_high, n_eff, evidence_count, distinct_days FROM preferences ORDER BY subject_type, horizon, ci_low DESC, subject_key').all() as any[];
  const seen = new Map<string, number>();
  const topRows = rows.filter((r) => { const k = `${r.subject_type}/${r.horizon}`; const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return n <= 10; });
  return { summary: s ? { version: s.version, length: s.text.length, text: s.text, computed_at: s.computed_at } : null, top: topRows, rules: activeRules(d) };
}

export interface PreferencesRequest { action?: string; rule?: string; subject_key?: string; subject_type?: string; valid_until?: string; note?: string; rule_id?: string }

/** Shared entry point for the MCP tool, REST route and CLI. Reads never rebuild unless asked; any rule change rebuilds so Jev sees it. */
export function personalPreferences(req: PreferencesRequest) {
  const d = personalDb();
  const action = req.action ?? 'get';
  if (action === 'get') {
    const r = readPreferences(d);
    if (!r.summary) return { ...r, note: 'no summary yet: run with action "rebuild"' };
    return r;
  }
  if (action === 'rebuild') { const r = rebuildPreferences(d); return { rebuilt: true, version: r.version, length: r.length, counts: r.counts }; }
  if (action === 'set_rule') {
    const rule = setRule(d, { rule: String(req.rule ?? ''), subject_key: String(req.subject_key ?? ''), subject_type: req.subject_type, valid_until: req.valid_until, note: req.note });
    const r = rebuildPreferences(d);
    return { rule, summary_version: r.version };
  }
  if (action === 'remove_rule') {
    if (typeof req.rule_id !== 'string' || !req.rule_id) throw new PreferenceInputError('rule_id is required');
    const removed = removeRule(d, req.rule_id);
    return { removed, summary_version: rebuildPreferences(d).version };
  }
  throw new PreferenceInputError('action must be get, rebuild, set_rule or remove_rule');
}

/** Lasting owner feedback the ranker can match against an event: item/venue/topic keys with a sign. */
export function lastingFeedback(d: DatabaseSync): Array<{ scope: 'item' | 'venue' | 'topic'; key: string; positive: boolean }> {
  const out: Array<{ scope: 'item' | 'venue' | 'topic'; key: string; positive: boolean }> = [];
  for (const r of d.prepare(`SELECT f.type, f.scope, f.reason, f.item_id, e.venue_text FROM feedback f LEFT JOIN event_details e ON e.item_id = f.item_id
      WHERE f.scope IN ('item','venue','topic') AND f.type IN ('like','save','want_to_go','dislike') ORDER BY f.created_at, f.id`).all() as any[]) {
    const positive = POSITIVE.has(r.type);
    if (r.scope === 'item') out.push({ scope: 'item', key: r.item_id, positive });
    else if (r.scope === 'venue' && r.venue_text) out.push({ scope: 'venue', key: lower(r.venue_text), positive });
    else if (r.scope === 'topic' && r.reason) out.push({ scope: 'topic', key: lower(r.reason).slice(0, 60), positive });
  }
  return out;
}

/** Top subject keys of a type (long horizon, posterior mean above 0.5, best lower bound first), used for readable reasons. */
export function topKeys(d: DatabaseSync, type: string, n: number): string[] {
  return (d.prepare("SELECT subject_key k FROM preferences WHERE subject_type = ? AND horizon = 'long' AND mean > 0.5 ORDER BY ci_low DESC, subject_key LIMIT ?").all(type, n) as any[]).map((r) => r.k);
}
