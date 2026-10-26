import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readTaste } from './jev.js';
import { personalDb } from './feed.js';

export class PreferenceInputError extends Error {}

export const SUMMARY_MAX_CHARS = 2500;
const RECENT_DAYS = 90;
const KEEP_PER_GROUP = 200;
const DAY = 86_400_000;

export const RULES = ['prefer', 'avoid', 'exclude'] as const;
export type RuleKind = (typeof RULES)[number];

// Owner feedback weights. Only deliberate, lasting feedback counts; this_time scope and the situational types never do.
const POSITIVE = new Set(['like', 'save', 'want_to_go']);
const FB_WEIGHT: Record<string, number> = { like: 3, save: 3, want_to_go: 3, dislike: -4 };
const LASTING_SCOPES = new Set(['item', 'creator', 'topic', 'venue']);

interface Agg { score: number; n: number; days: Set<string> }
type Groups = Map<string, Map<string, { long: Agg; recent: Agg }>>; // subject_type -> key -> horizons

const lower = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '');

function add(groups: Groups, type: string, key: string, weight: number, at: string | null, cutoff: number | null) {
  if (!key) return;
  let g = groups.get(type);
  if (!g) groups.set(type, (g = new Map()));
  let e = g.get(key);
  if (!e) g.set(key, (e = { long: { score: 0, n: 0, days: new Set() }, recent: { score: 0, n: 0, days: new Set() } }));
  const day = at ? at.slice(0, 10) : null;
  const hs = [e.long];
  if (cutoff !== null && at && Date.parse(at) >= cutoff) hs.push(e.recent);
  for (const h of hs) { h.score += weight; h.n++; if (day) h.days.add(day); }
}

/** Cutoff = RECENT_DAYS before the newest row of that data set, so a stale export still has a "recent" window. */
function cutoffOf(max: string | null): number | null {
  const t = max ? Date.parse(max) : NaN;
  return Number.isFinite(t) ? t - RECENT_DAYS * DAY : null;
}

export interface RebuildResult {
  version: string;
  length: number;
  text: string;
  counts: Record<string, { long: number; recent: number }>;
}

/**
 * Rebuild the derived preference rows and the compact summary from scratch, from deliberate owner actions only
 * (observations with learn=1: Instagram like/save, music plays without skips, saved places, plus owner feedback).
 * Agent decisions are never read. Same data and taste text give the same rows and the same summary version.
 */
export function rebuildPreferences(d: DatabaseSync, now: string = new Date().toISOString()): RebuildResult {
  const groups: Groups = new Map();

  const maxAt = (where: string) => (d.prepare(`SELECT MAX(o.occurred_at) m FROM observations o JOIN source_accounts a ON a.id = o.source_account_id WHERE o.learn = 1 AND ${where}`).get() as any).m as string | null;

  // Instagram authors the owner liked or saved. Weight: save 2, like 1.
  const igCut = cutoffOf(maxAt("a.provider = 'instagram' AND o.action IN ('like','save')"));
  for (const r of d.prepare(`SELECT LOWER(TRIM(COALESCE(c.title, CASE WHEN i.kind = 'creator' THEN i.title END, json_extract(i.author_json, '$.handle')))) k,
      o.action act, o.occurred_at at FROM observations o JOIN source_accounts a ON a.id = o.source_account_id JOIN items i ON i.id = o.item_id
      LEFT JOIN items c ON c.id = i.creator_item_id
      WHERE o.learn = 1 AND a.provider = 'instagram' AND o.action IN ('like','save') ORDER BY o.id`).iterate() as Iterable<any>) {
    add(groups, 'ig_author', r.k ?? '', r.act === 'save' ? 2 : 1, r.at, igCut);
  }

  // Music artists by plays. Skips are a different action and are not counted.
  const muCut = cutoffOf(maxAt("o.action = 'play'"));
  for (const r of d.prepare(`SELECT LOWER(TRIM(COALESCE(json_extract(i.author_json, '$.artist'), c.title))) k, o.occurred_at at
      FROM observations o JOIN items i ON i.id = o.item_id LEFT JOIN items c ON c.id = i.creator_item_id
      WHERE o.learn = 1 AND o.action = 'play' ORDER BY o.id`).iterate() as Iterable<any>) {
    add(groups, 'music_artist', r.k ?? '', 1, r.at, muCut);
  }

  // Saved places: list name as category, location label/address as area when the export has one.
  for (const r of d.prepare(`SELECT LOWER(TRIM(e.counterparty)) cat, LOWER(TRIM(COALESCE(json_extract(i.location_json, '$.label'), json_extract(i.location_json, '$.address')))) area, e.effective_at at
      FROM entity_state e JOIN items i ON i.id = e.item_id
      WHERE e.relation = 'save' AND e.state = 'active' AND i.kind = 'venue' ORDER BY e.id`).iterate() as Iterable<any>) {
    add(groups, 'place_category', r.cat ?? '', 1, r.at, null);
    add(groups, 'place_area', (r.area ?? '').slice(0, 60), 1, r.at, null);
  }

  // Owner feedback (the truth labels).
  const fbMax = (d.prepare('SELECT MAX(created_at) m FROM feedback').get() as any).m as string | null;
  const fbCut = cutoffOf(fbMax);
  for (const r of d.prepare(`SELECT f.type, f.scope, f.reason, f.created_at at, i.title, i.description, i.author_json, c.title ctitle, e.venue_text
      FROM feedback f JOIN items i ON i.id = f.item_id LEFT JOIN items c ON c.id = i.creator_item_id LEFT JOIN event_details e ON e.item_id = i.id
      ORDER BY f.created_at, f.id`).iterate() as Iterable<any>) {
    const w = FB_WEIGHT[r.type];
    if (w === undefined || !LASTING_SCOPES.has(r.scope)) continue;
    let a: any = null;
    try { a = r.author_json ? JSON.parse(r.author_json) : null; } catch { /* ignore */ }
    if (r.scope === 'creator') add(groups, 'fb_creator', lower(r.ctitle ?? a?.handle ?? a?.artist ?? a?.name), w, r.at, fbCut);
    else if (r.scope === 'topic') add(groups, 'fb_topic', lower(r.reason).slice(0, 60), w, r.at, fbCut);
    else if (r.scope === 'venue') add(groups, 'fb_venue', lower(r.venue_text), w, r.at, fbCut);
    else add(groups, 'fb_item', lower(r.title ?? r.description).slice(0, 80), w, r.at, fbCut);
  }

  // Persist (top KEEP_PER_GROUP per subject_type and horizon, stable order).
  const counts: RebuildResult['counts'] = {};
  const rows: Array<{ type: string; key: string; horizon: 'long' | 'recent'; a: Agg }> = [];
  for (const [type, g] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
    counts[type] = { long: 0, recent: 0 };
    for (const horizon of ['long', 'recent'] as const) {
      const list = [...g].filter(([, e]) => e[horizon].n > 0).sort((x, y) => y[1][horizon].score - x[1][horizon].score || x[0].localeCompare(y[0])).slice(0, KEEP_PER_GROUP);
      counts[type][horizon] = list.length;
      for (const [key, e] of list) rows.push({ type, key, horizon, a: e[horizon] });
    }
  }

  const text = buildSummary(d, groups, now);
  const version = createHash('sha256').update(text).digest('hex').slice(0, 12);
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM preferences');
    const ins = d.prepare('INSERT INTO preferences (subject_type, subject_key, horizon, score, evidence_count, distinct_days, computed_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.type, r.key, r.horizon, r.a.score, r.a.n, r.a.days.size, now, version);
    d.prepare('INSERT INTO preference_summary (id, version, text, computed_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, text = excluded.text, computed_at = excluded.computed_at')
      .run(version, text, now);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { version, length: text.length, text, counts };
}

function top(groups: Groups, type: string, horizon: 'long' | 'recent', n: number): string[] {
  const g = groups.get(type);
  if (!g || n <= 0) return [];
  return [...g].filter(([, e]) => e[horizon].n > 0 && e[horizon].score > 0)
    .sort((x, y) => y[1][horizon].score - x[1][horizon].score || x[0].localeCompare(y[0])).slice(0, n)
    .map(([k, e]) => `${k.slice(0, 40)} (${Math.round(e[horizon].score)})`);
}
function negatives(groups: Groups, type: string, n: number): string[] {
  const g = groups.get(type);
  if (!g || n <= 0) return [];
  return [...g].filter(([, e]) => e.long.score < 0).sort((x, y) => x[1].long.score - y[1].long.score || x[0].localeCompare(y[0])).slice(0, n).map(([k]) => k.slice(0, 40));
}

function buildSummary(d: DatabaseSync, groups: Groups, now: string): string {
  const taste = readTaste();
  const rules = activeRules(d, now);
  const by = (k: string) => rules.filter((r) => r.rule === k).map((r) => `${r.subject_key}`.slice(0, 40));
  const make = (n: number, tasteChars: number) => {
    const lines: string[] = [];
    if (taste && tasteChars > 0) lines.push(`Owner's own words: ${taste.replace(/\s+/g, ' ').slice(0, tasteChars)}`);
    const ruleLine = (['prefer', 'avoid', 'exclude'] as const).map((k) => (by(k).length ? `${k}: ${by(k).slice(0, 12).join(', ')}` : '')).filter(Boolean).join('; ');
    if (ruleLine) lines.push(`Explicit rules: ${ruleLine}`);
    const sec = (label: string, items: string[]) => { if (items.length) lines.push(`${label}: ${items.join(', ')}`); };
    sec('Instagram authors liked/saved, long-term', top(groups, 'ig_author', 'long', n));
    sec('Instagram authors liked/saved, last 90 days', top(groups, 'ig_author', 'recent', Math.ceil(n * 0.7)));
    sec('Music artists by plays, long-term', top(groups, 'music_artist', 'long', n));
    sec('Music artists by plays, last 90 days', top(groups, 'music_artist', 'recent', Math.ceil(n * 0.7)));
    sec('Saved place categories', top(groups, 'place_category', 'long', Math.ceil(n * 0.6)));
    sec('Saved place areas', top(groups, 'place_area', 'long', Math.ceil(n * 0.6)));
    sec('Owner said yes to', [...top(groups, 'fb_item', 'long', Math.ceil(n * 0.5)), ...top(groups, 'fb_topic', 'long', 5), ...top(groups, 'fb_venue', 'long', 5), ...top(groups, 'fb_creator', 'long', 5)]);
    sec('Owner said no to', [...negatives(groups, 'fb_item', 6), ...negatives(groups, 'fb_topic', 6), ...negatives(groups, 'fb_venue', 6), ...negatives(groups, 'fb_creator', 6)]);
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
  const rows = d.prepare('SELECT subject_type, subject_key, horizon, score, evidence_count, distinct_days FROM preferences ORDER BY subject_type, horizon, score DESC, subject_key').all() as any[];
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

/** Top subject keys of a type (long horizon), used for readable reasons. */
export function topKeys(d: DatabaseSync, type: string, n: number): string[] {
  return (d.prepare("SELECT subject_key k FROM preferences WHERE subject_type = ? AND horizon = 'long' AND score > 0 ORDER BY score DESC, subject_key LIMIT ?").all(type, n) as any[]).map((r) => r.k);
}
