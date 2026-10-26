import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { jevConfig } from '../config.js';
import { preferenceSummary, scorePost, type JevScore } from './jev.js';
import { getRenderer, type Card } from './render.js';

export interface FilterOptions { includeFiltered: boolean; order: 'feed' | 'predicted'; exploration: number }

const MIN_TEXT_CHARS = 5;
const CONCURRENCY = 4;
export const ARTIFACT_URL_PREFIX = '/api/personal/artifacts/';
export const ARTIFACT_ID_RE = /^art_[0-9a-f-]{36}$/;

interface Pred extends JevScore { id: string; preference_summary_version: string; scorer: string }

function toPrediction(r: any): Pred {
  return { id: r.id, p_match: r.p_match, p_engage: r.p_engage, confidence: r.confidence, cost_usd: r.cost_usd,
    model_version: r.model_version, preference_summary_version: r.preference_summary_version, scorer: r.scorer };
}

function usedToday(d: DatabaseSync): { posts: number; usd: number } {
  const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const r = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) usd FROM predictions WHERE scorer = 'jev' AND created_at >= ?").get(start) as any;
  return { posts: r.n, usd: r.usd };
}

async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });

export function readArtifact(d: DatabaseSync, id: string): Buffer | null {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  const row = d.prepare('SELECT path FROM artifacts WHERE id = ?').get(id) as any;
  if (!row || !existsSync(row.path)) return null;
  return readFileSync(row.path);
}

/**
 * Score every item with Jev (cached per item and preference-summary version, bounded by the daily budget),
 * decide which pass, render screenshots for the passed ones only, and shape the final item list.
 * Mutates items in place (filter, prediction, render) and returns the kept list plus the filtered-out count.
 */
export async function applyJev(d: DatabaseSync, runId: string, items: any[], opts: FilterOptions): Promise<{ items: any[]; filteredOut: number }> {
  const cfg = jevConfig();
  const prefs = preferenceSummary();
  const now = () => new Date().toISOString();

  type State = { item: any; pred: Pred | null; reason: string | null; passed: boolean; fresh: boolean };
  const states: State[] = items.map((item) => ({ item, pred: null, reason: null, passed: false, fresh: false }));

  const find = d.prepare("SELECT * FROM predictions WHERE item_id = ? AND scorer = 'jev' AND preference_summary_version = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const ins = d.prepare(`INSERT INTO predictions (id, item_id, collection_run_id, scorer, model_version, preference_summary_version, p_match, p_engage,
    confidence, cost_usd, calibrated, created_at) VALUES (?, ?, ?, 'jev', ?, ?, ?, ?, ?, ?, 0, ?)`);

  // Budget is checked before each call; calls run a few at a time, so a page can overshoot by up to CONCURRENCY-1 calls.
  const toCall: State[] = [];
  for (const s of states) {
    const caption = (s.item.caption ?? '').trim();
    if (caption.length < MIN_TEXT_CHARS) { s.reason = 'no_text'; continue; } // no OCR capability in phrog-web yet: Hermes judges the screenshot
    const cached = find.get(s.item.item_id, prefs.version) as any;
    if (cached) { s.pred = toPrediction(cached); continue; }
    toCall.push(s);
  }
  const used = usedToday(d);
  let posts = used.posts, usd = used.usd;
  await pool(CONCURRENCY, toCall.map((s) => async () => {
    if (posts >= cfg.maxPostsPerDay || usd >= cfg.maxUsdPerDay) { s.reason = 'budget'; return; }
    posts++;
    try {
      const sc = await scorePost({
        caption: s.item.caption, author: s.item.author, type: s.item.type, hashtags: s.item.hashtags,
        location: s.item.location, sponsored: s.item.sponsored, suggested: s.item.suggested,
      }, prefs);
      usd += sc.cost_usd ?? 0;
      const id = `pred_${randomUUID()}`;
      ins.run(id, s.item.item_id, runId, sc.model_version, prefs.version, sc.p_match, sc.p_engage, sc.confidence, sc.cost_usd, now());
      s.pred = { ...sc, id, preference_summary_version: prefs.version, scorer: 'jev' };
      s.fresh = true;
    } catch { s.reason = 'jev_error'; }
  }));

  // Decide who passes. Explicit text-less and scorer-error posts pass so Hermes can judge them visually.
  for (const s of states) {
    if (s.pred) {
      if (s.pred.p_match >= cfg.threshold) { s.passed = true; s.reason = 'above_threshold'; }
      else if (opts.exploration > 0 && Math.random() < opts.exploration) { s.passed = true; s.reason = 'exploration'; }
      else s.reason = 'below_threshold';
    } else if (s.reason === 'no_text' || s.reason === 'jev_error') s.passed = true;
  }
  const rank = (s: State) => s.pred?.p_match ?? cfg.threshold;
  const passed = states.filter((s) => s.passed).sort((a, b) => rank(b) - rank(a));
  for (const s of passed.slice(cfg.maxPassPerPage)) { s.passed = false; s.reason = 'page_cap'; }

  // Screenshots: passed posts only.
  const todo = states.filter((s) => s.passed);
  const findArt = d.prepare("SELECT id, path, created_at FROM artifacts WHERE item_id = ? AND kind = 'post_card' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const need: State[] = [];
  const have = new Map<State, { id: string; created_at: string; png: Buffer }>();
  for (const s of todo) {
    const a = findArt.get(s.item.item_id) as any;
    if (a && existsSync(a.path)) have.set(s, { id: a.id, created_at: a.created_at, png: readFileSync(a.path) });
    else need.push(s);
  }
  if (need.length) {
    const cards: Card[] = need.map((s) => ({
      author: s.item.author?.handle ?? s.item.author?.name ?? null, caption: s.item.caption, type: s.item.type, url: s.item.url,
      imageUrl: (s.item.media.find((m: any) => m?.url) ?? {}).url ?? null,
    }));
    let rendered: Awaited<ReturnType<ReturnType<typeof getRenderer>>> = [];
    try { rendered = await getRenderer()(cards); } catch { /* render stays null */ }
    mkdirSync(cfg.artifactsDir, { recursive: true, mode: 0o700 });
    const insArt = d.prepare('INSERT INTO artifacts (id, kind, item_id, path, created_at) VALUES (?, ?, ?, ?, ?)');
    need.forEach((s, i) => {
      const r = rendered[i];
      if (!r) return;
      const id = `art_${randomUUID()}`;
      const path = join(cfg.artifactsDir, `${id}.png`);
      writeFileSync(path, r.png, { mode: 0o600 });
      chmodSync(path, 0o600);
      const at = now();
      insArt.run(id, 'post_card', s.item.item_id, path, at);
      have.set(s, { id, created_at: at, png: r.png });
    });
  }

  const upd = d.prepare('UPDATE predictions SET passed_filter = ?, filter_reason = ?, screenshot_ref = COALESCE(?, screenshot_ref) WHERE id = ?');
  for (const s of states) {
    const art = have.get(s);
    if (s.pred) upd.run(s.passed ? 1 : 0, s.reason, art?.id ?? null, s.pred.id);
    s.item.filter = { passed: s.passed, reason: s.reason };
    s.item.prediction = s.pred && {
      p_match: s.pred.p_match, p_engage: s.pred.p_engage, confidence: s.pred.confidence, calibrated: false,
      model_version: s.pred.model_version, scorer: 'jev', preference_summary_version: s.pred.preference_summary_version, cost_usd: s.pred.cost_usd,
    };
    if (art) s.item.render = { screenshot: ARTIFACT_URL_PREFIX + art.id, ...pngSize(art.png), rendered_at: art.created_at };
  }

  const filteredOut = states.filter((s) => !s.passed).length;
  let kept = opts.includeFiltered ? states : states.filter((s) => s.passed);
  if (opts.order === 'predicted') {
    kept = [...kept].sort((a, b) => (b.pred?.p_match ?? -1) - (a.pred?.p_match ?? -1));
  }
  return { items: kept.map((s) => s.item), filteredOut };
}
