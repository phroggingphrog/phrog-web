import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openPersonalDb } from '../../src/personalization/db/index.js';
import { betaCdf, betaQuantile } from '../../src/personalization/stats/beta.js';
import { fitFromDb, statsConfig, memoryLookup, scoreSubjects, statsForItem, dbLookup, blend, confident, estimatePrior, type StatsResult } from '../../src/personalization/stats/model.js';
import { evaluate, collectLabels } from '../../src/personalization/stats/evaluate.js';
import { rebuildPreferences } from '../../src/personalization/preferences.js';
import { applyJev } from '../../src/personalization/filter.js';
import { setCardRenderer } from '../../src/personalization/render.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-stats-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
before(() => {
  process.env.PHROG_PERSONAL_ARTIFACTS_DIR = join(dir, 'art');
  delete process.env.PHROG_TASTE_FILE;
  setCardRenderer(async (cards) => cards.map(() => ({ png: PNG, width: 1, height: 1 })));
});
after(() => { setCardRenderer(null); rmSync(dir, { recursive: true, force: true }); });

const NEWEST = '2026-09-01T00:00:00Z';
const daysBefore = (n: number) => new Date(Date.parse(NEWEST) - n * 86_400_000).toISOString();

function mkdb() {
  const d = openPersonalDb(':memory:');
  d.exec("INSERT INTO source_accounts (id, provider, handle) VALUES ('a_ig','instagram','me'), ('a_sp','spotify','me'), ('a_rss','rss','feed')");
  return d;
}
let k = 0;
let n = 0;
/** One post by an Instagram author (creator item created on first use). */
function post(d: DatabaseSync, author: string, id = `it_p${++n}`) {
  const cid = `it_c_${author}`;
  if (!d.prepare('SELECT 1 FROM items WHERE id = ?').get(cid)) d.prepare("INSERT INTO items (id, kind, title, first_seen_at, updated_at) VALUES (?, 'creator', ?, ?, ?)").run(cid, author, NEWEST, NEWEST);
  d.prepare("INSERT INTO items (id, kind, creator_item_id, first_seen_at, updated_at) VALUES (?, 'post', ?, ?, ?)").run(id, cid, NEWEST, NEWEST);
  d.prepare("INSERT INTO item_ids (item_id, provider, native_id) VALUES (?, 'instagram', ?)").run(id, id);
  return id;
}
function obs(d: DatabaseSync, acc: string, item: string, action: string, at: string, extra: { learn?: number; sponsored?: number } = {}) {
  d.prepare('INSERT INTO observations (source_account_id, item_id, action, occurred_at, learn, sponsored, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(acc, item, action, at, extra.learn ?? 1, extra.sponsored ?? null, `k${++k}`);
}
function likes(d: DatabaseSync, author: string, count: number, at = NEWEST) { for (let i = 0; i < count; i++) obs(d, 'a_ig', post(d, author), 'like', at); }
const cfg = statsConfig();
const get = (d: DatabaseSync, type: string, key: string, horizon = 'long') =>
  d.prepare('SELECT * FROM preferences WHERE subject_type = ? AND subject_key = ? AND horizon = ?').get(type, key, horizon) as any;
const allRows = (d: DatabaseSync) => JSON.stringify(d.prepare('SELECT subject_type, subject_key, horizon, alpha, beta, mean, ci_low, ci_high, n_eff, evidence_count, distinct_days FROM preferences ORDER BY 1, 2, 3').all());
const NOW = '2026-10-26T00:00:00Z';

test('beta quantile matches closed-form reference values', () => {
  const close = (a: number, b: number, tol = 1e-8) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  for (const p of [0.05, 0.5, 0.95]) {
    close(betaQuantile(p, 1, 1), p); // uniform
    close(betaQuantile(p, 1, 4), 1 - Math.pow(1 - p, 1 / 4)); // Beta(1,b)
    close(betaQuantile(p, 3, 1), Math.pow(p, 1 / 3)); // Beta(a,1)
    close(betaQuantile(p, 0.5, 0.5), Math.sin((Math.PI * p) / 2) ** 2); // arcsine
  }
  close(betaCdf(0.3, 2, 2), 3 * 0.09 - 2 * 0.027); // 3x^2 - 2x^3
  close(betaCdf(0.5, 7, 7), 0.5);
  close(betaQuantile(0.5, 40, 10) + betaQuantile(0.5, 10, 40), 1, 1e-9); // symmetry
  // round trip over a grid, including large parameters
  for (const [a, b] of [[0.3, 0.7], [1.5, 1], [2, 30], [31, 1], [250, 80], [1000, 3]]) for (const p of [0.01, 0.05, 0.5, 0.95, 0.99]) close(betaCdf(betaQuantile(p, a, b), a, b), p, 1e-9);
  // a published value: Beta(2,5) 5% and 95% quantiles
  close(betaQuantile(0.05, 2, 5), 0.0628, 5e-4);
  close(betaQuantile(0.95, 2, 5), 0.5818, 5e-4);
});

test('shrinkage: one like barely moves the estimate, fifty likes do', () => {
  const d = mkdb();
  likes(d, 'rare', 1);
  likes(d, 'fan', 50);
  rebuildPreferences(d, NOW);
  const one = get(d, 'ig_author', 'rare'), many = get(d, 'ig_author', 'fan');
  assert.ok(one.mean > 0.5 && one.mean < 0.7, `one like: ${one.mean}`);
  assert.ok(many.mean > 0.9, `fifty likes: ${many.mean}`);
  assert.ok(one.ci_high - one.ci_low > many.ci_high - many.ci_low, 'one like is far less certain');
  assert.ok(many.ci_low > 0.7 && one.ci_low < 0.5);
  assert.ok(many.n_eff <= cfg.sourceCap + 1e-9, 'a single source cannot exceed the cap');
});

test('empirical-Bayes prior: method of moments on subjects with enough evidence, fallback otherwise', () => {
  const few = estimatePrior([{ s: 5, f: 5 }], cfg);
  assert.equal(few.method, 'fallback');
  assert.deepEqual([few.alpha, few.beta], [1, 1]);
  // 40 subjects with rates spread around 0.7, 20 observations each
  const masses = Array.from({ length: 40 }, (_, i) => { const p = 0.45 + 0.5 * (i / 39); return { s: 20 * p, f: 20 * (1 - p) }; });
  const pr = estimatePrior(masses, cfg);
  assert.equal(pr.method, 'mom');
  assert.ok(Math.abs(pr.mean - 0.7) < 0.02, `prior mean ${pr.mean}`);
  assert.ok(pr.strength >= 1 && pr.strength <= cfg.priorMaxStrength);
  // heavy shrinkage: with this prior, a subject with 1 success still sits near the type mean
  const a = pr.alpha + 1, b = pr.beta;
  assert.ok(Math.abs(a / (a + b) - pr.mean) < 0.15);
});

test('recent horizon decays old evidence relative to the newest observation of that source', () => {
  const d = mkdb();
  likes(d, 'now_author', 10, NEWEST);
  likes(d, 'old_author', 10, daysBefore(360)); // four half-lives older
  rebuildPreferences(d, NOW);
  const fresh = get(d, 'ig_author', 'now_author', 'recent'), old = get(d, 'ig_author', 'old_author', 'recent');
  assert.ok(Math.abs(fresh.n_eff - 5) < 1e-9);
  assert.ok(Math.abs(old.n_eff - 5 / 16) < 1e-6, `old recent n_eff ${old.n_eff}`);
  assert.ok(Math.abs(get(d, 'ig_author', 'old_author', 'long').n_eff - 5) < 1e-9, 'long horizon keeps full weight');
  assert.ok(old.mean < fresh.mean);
  // a stale import is not all zero: decay is relative to that source's newest row, not to now
  const d2 = mkdb();
  likes(d2, 'only', 4, '2020-01-01T00:00:00Z');
  rebuildPreferences(d2, NOW);
  assert.ok(Math.abs(get(d2, 'ig_author', 'only', 'recent').n_eff - 2) < 1e-9);
});

test('this_time feedback and situational types never change lasting taste; lasting feedback does', () => {
  const d = mkdb();
  d.exec("INSERT INTO items (id, kind, title, first_seen_at, updated_at) VALUES ('it_e1', 'event', 'Quiz', '2026-10-01', '2026-10-01')");
  d.exec("INSERT INTO event_details (item_id, venue_text, category) VALUES ('it_e1', 'The Pub', 'gigs')");
  likes(d, 'someone', 3);
  rebuildPreferences(d, NOW);
  const before = allRows(d);
  const fb = d.prepare('INSERT INTO feedback (id, item_id, type, scope, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)');
  fb.run('f1', 'it_e1', 'dislike', 'this_time', '2026-10-20', 'k1');
  fb.run('f2', 'it_e1', 'like', 'this_time', '2026-10-20', 'k2');
  fb.run('f3', 'it_e1', 'too_far', 'this_time', '2026-10-20', 'k3');
  fb.run('f4', 'it_e1', 'too_expensive', 'item', '2026-10-20', 'k4');
  fb.run('f5', 'it_e1', 'not_now', 'item', '2026-10-20', 'k5');
  rebuildPreferences(d, NOW);
  assert.equal(allRows(d), before);
  fb.run('f6', 'it_e1', 'dislike', 'item', '2026-10-21', 'k6');
  rebuildPreferences(d, NOW);
  const venue = get(d, 'venue', 'the pub'), cat = get(d, 'event_category', 'gigs');
  assert.ok(venue.mean < 0.5 && cat.mean < 0.5);
  assert.ok(Math.abs(venue.n_eff - 1) < 1e-9, 'explicit feedback is a full unit of evidence');
});

test('agent_decisions are never evidence', () => {
  const d = mkdb();
  likes(d, 'someone', 3);
  const p = post(d, 'agent_pick');
  rebuildPreferences(d, NOW);
  const before = allRows(d);
  for (const dec of ['interesting', 'send_to_owner', 'save_event', 'not_interesting']) {
    d.prepare('INSERT INTO agent_decisions (id, item_id, client, decision, created_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)').run(`dcn_${dec}`, p, 'hermes', dec, NEWEST, dec);
  }
  rebuildPreferences(d, NOW);
  assert.equal(allRows(d), before);
  assert.equal(get(d, 'ig_author', 'agent_pick'), undefined);
});

test('unseen is never negative: only displayed deliveries and non-sponsored seen posts count, and only weakly', () => {
  const d = mkdb();
  d.exec("INSERT INTO items (id, kind, title, first_seen_at, updated_at) VALUES ('it_e1', 'event', 'A', '2026-10-01', '2026-10-01'), ('it_e2', 'event', 'B', '2026-10-01', '2026-10-01')");
  d.exec("INSERT INTO event_details (item_id, venue_text, category) VALUES ('it_e1', 'Shown Venue', 'gigs'), ('it_e2', 'Unshown Venue', 'film')");
  d.exec("INSERT INTO discovery_runs (id, started_at) VALUES ('dsc_1', '2026-10-01')");
  d.exec(`INSERT INTO deliveries (id, discovery_run_id, item_id, position, returned_at, displayed_at) VALUES
    ('dlv_1', 'dsc_1', 'it_e1', 1, '2026-10-01', '2026-10-01T01:00:00Z'), ('dlv_2', 'dsc_1', 'it_e2', 2, '2026-10-01', NULL)`);
  const seen = post(d, 'seen_only'), ad = post(d, 'ad_author'), liked = post(d, 'liked_after_seen');
  obs(d, 'a_ig', seen, 'seen_in_feed', NEWEST);
  obs(d, 'a_ig', ad, 'seen_in_feed', NEWEST, { sponsored: 1 });
  obs(d, 'a_ig', liked, 'seen_in_feed', NEWEST);
  obs(d, 'a_ig', liked, 'like', NEWEST);
  post(d, 'never_observed');
  rebuildPreferences(d, NOW);
  const shown = get(d, 'venue', 'shown venue');
  assert.ok(Math.abs(shown.n_eff - 0.05) < 1e-9 && shown.mean < 0.5);
  assert.equal(get(d, 'venue', 'unshown venue'), undefined);
  assert.equal(get(d, 'event_category', 'film'), undefined);
  assert.ok(Math.abs(get(d, 'ig_author', 'seen_only').n_eff - 0.05) < 1e-9);
  assert.equal(get(d, 'ig_author', 'ad_author'), undefined);
  assert.equal(get(d, 'ig_author', 'never_observed'), undefined);
  assert.ok(Math.abs(get(d, 'ig_author', 'liked_after_seen').n_eff - 0.5) < 1e-9, 'a seen post that was liked is not also a failure');
  // feedback on a displayed delivery removes the seen-failure
  d.exec("INSERT INTO feedback (id, item_id, type, scope, created_at, idempotency_key) VALUES ('f1', 'it_e1', 'like', 'this_time', '2026-10-02', 'x')");
  rebuildPreferences(d, NOW);
  assert.equal(get(d, 'venue', 'shown venue'), undefined);
});

test('rebuild is deterministic and records the run', () => {
  const d = mkdb();
  likes(d, 'a', 5); likes(d, 'b', 2, daysBefore(200));
  const t = post(d, 'x');
  d.prepare("INSERT INTO items (id, kind, title, author_json, first_seen_at, updated_at) VALUES ('it_t', 'track', 'S', ?, ?, ?)").run(JSON.stringify({ artist: 'Band' }), NEWEST, NEWEST);
  d.prepare("INSERT INTO item_ids (item_id, provider, native_id) VALUES ('it_t', 'spotify', 't1')").run();
  obs(d, 'a_sp', 'it_t', 'play', NEWEST); obs(d, 'a_sp', 'it_t', 'skip', NEWEST); obs(d, 'a_ig', t, 'like', NEWEST);
  const a = rebuildPreferences(d, NOW);
  const rowsA = allRows(d);
  const b = rebuildPreferences(d, NOW);
  assert.equal(allRows(d), rowsA);
  assert.equal(a.version, b.version);
  const runs = d.prepare('SELECT * FROM preference_model_runs ORDER BY rowid').all() as any[];
  assert.equal(runs.length, 2);
  assert.equal(runs[0].model_version, 'stats-1');
  assert.ok(JSON.parse(runs[0].priors_json).ig_author.method);
  assert.equal(JSON.parse(runs[0].counts_json).evidence_rows.spotify, 2);
  assert.equal(runs[0].inputs_cutoff, NEWEST);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM preferences WHERE model_version IS NULL OR ci_low IS NULL').get()?.n, 0);
});

test('per-source cap keeps a prolific source from dominating, ratio preserved', () => {
  const d = mkdb();
  d.prepare("INSERT INTO items (id, kind, title, author_json, first_seen_at, updated_at) VALUES ('it_t', 'track', 'S', ?, ?, ?)").run(JSON.stringify({ artist: 'Loud' }), NEWEST, NEWEST);
  d.prepare("INSERT INTO item_ids (item_id, provider, native_id) VALUES ('it_t', 'spotify', 't1')").run();
  for (let i = 0; i < 1000; i++) obs(d, 'a_sp', 'it_t', 'play', NEWEST);
  for (let i = 0; i < 500; i++) obs(d, 'a_sp', 'it_t', 'skip', NEWEST);
  rebuildPreferences(d, NOW);
  const r = get(d, 'music_artist', 'loud');
  assert.ok(Math.abs(r.n_eff - cfg.sourceCap) < 1e-9);
  // 200 success : 100 failure -> 20 : 10 after the cap, plus the Beta(1,1) prior
  assert.ok(Math.abs(r.mean - 21 / 32) < 1e-9);
});

const st = (ci_low: number, ci_high: number, score = (ci_low + ci_high) / 2): StatsResult => ({ score, ci_low, ci_high, matched: [] });

test('ranking blend and confident pass/fail', () => {
  assert.ok(Math.abs(blend(0.8, st(0.2, 0.6, 0.4), cfg) - (0.6 * 0.8 + 0.4 * 0.4)) < 1e-12);
  assert.equal(blend(0.8, null, cfg), 0.8);
  assert.equal(confident(st(0.75, 0.95), cfg), 'pass');
  assert.equal(confident(st(0.7, 0.95), cfg), null); // strictly above 0.7
  assert.equal(confident(st(0.01, 0.15), cfg), 'fail');
  assert.equal(confident(st(0.01, 0.2), cfg), null);
  assert.equal(confident(st(0.3, 0.8), cfg), null);
  assert.equal(confident(null, cfg), null);
});

test('stats score for an item is the evidence-weighted mean of its matched subjects, null when nothing matches', () => {
  const d = mkdb();
  likes(d, 'fan', 40);
  const target = post(d, 'fan');
  const nobody = post(d, 'stranger');
  rebuildPreferences(d, NOW);
  const lookup = dbLookup(d);
  const s = statsForItem(d, lookup, target, cfg)!;
  assert.equal(s.matched[0].subject_type, 'ig_author');
  assert.ok(s.score > 0.9 && s.ci_low > 0.7);
  assert.equal(statsForItem(d, lookup, nobody, cfg), null);
  // weighting: a heavy subject outweighs a light one
  const fit = fitFromDb(d, cfg).fit;
  const mem = memoryLookup(fit);
  const both = scoreSubjects([{ type: 'ig_author', key: 'fan' }, { type: 'ig_author', key: 'unknown' }], '', mem, cfg)!;
  assert.equal(both.matched.length, 1);
});

test('feed filter: confident stats override the Jev threshold and show in prediction.stats', async () => {
  const d = mkdb();
  likes(d, 'fan', 60);
  for (let i = 0; i < 70; i++) obs(d, 'a_ig', post(d, 'hater'), 'not_interested', NEWEST);
  const a = post(d, 'fan'), b = post(d, 'hater'), c = post(d, 'stranger');
  rebuildPreferences(d, NOW);
  const mk = (id: string, handle: string) => ({ item_id: id, native_id: id, url: null, type: 'photo', sponsored: false, suggested: false, author: { handle, name: null, followed: null },
    caption: null, hashtags: [], mentions: [], media: [], location: null, render: null, filter: null, prediction: null });
  const items = [mk(c, 'stranger'), mk(b, 'hater'), mk(a, 'fan')];
  const out = await applyJev(d, 'run1', items, { includeFiltered: true, order: 'predicted', exploration: 0 });
  const by = (id: string) => out.items.find((i) => i.item_id === id);
  assert.deepEqual([by(a).filter.passed, by(a).filter.reason], [true, 'stats_confident_pass']);
  assert.deepEqual([by(b).filter.passed, by(b).filter.reason], [false, 'stats_confident_fail']); // overrides the "no text passes" rule
  assert.deepEqual([by(c).filter.passed, by(c).filter.reason], [true, 'no_text']);
  assert.equal(by(a).prediction.scorer, 'stats');
  assert.equal(by(a).prediction.p_match, null);
  assert.ok(by(a).prediction.stats.score > 0.9);
  assert.equal(by(a).prediction.stats.matched[0].key, 'fan');
  assert.equal(by(c).prediction, null);
  assert.equal(out.items[0].item_id, a, 'predicted order puts the strongest statistical match first');
  assert.equal(out.filteredOut, 1);
});

test('evaluation on a synthetic labelled set: chronological split, scores, calibration, small-sample notes', () => {
  const d = mkdb();
  // Two authors the owner likes (many likes over time) and two they ignore; labels = likes vs seen without action.
  let day = 0;
  const t = () => daysBefore(400 - day++);
  for (let i = 0; i < 40; i++) { obs(d, 'a_ig', post(d, 'loved_a'), 'like', t()); obs(d, 'a_ig', post(d, 'loved_b'), 'like', t()); }
  for (let i = 0; i < 40; i++) { obs(d, 'a_ig', post(d, 'meh_a'), 'seen_in_feed', t()); obs(d, 'a_ig', post(d, 'meh_b'), 'seen_in_feed', t()); }
  // interleave: more labelled outcomes later in time for the same authors
  for (let i = 0; i < 20; i++) { obs(d, 'a_ig', post(d, 'loved_a'), 'like', t()); obs(d, 'a_ig', post(d, 'meh_a'), 'seen_in_feed', t()); }
  const labels = collectLabels(d);
  assert.equal(labels.length, 200);
  assert.equal(labels.filter((l) => l.y === 1).length, 100);
  const r = evaluate(d);
  assert.equal(r.split.train_labels + r.split.test_labels, 200);
  assert.ok(r.split.test_labels >= 55 && r.split.test_labels <= 65);
  assert.equal(r.covered.test_without_subjects, 0);
  assert.equal(r.methods.stats_model.n, r.split.test_labels);
  assert.ok(r.methods.stats_model.brier! < r.methods.type_prior_baseline.brier!, `stats ${r.methods.stats_model.brier} vs baseline ${r.methods.type_prior_baseline.brier}`);
  assert.ok(r.methods.stats_model.log_loss! < r.methods.type_prior_baseline.log_loss!);
  assert.equal(r.methods.jev_p_match.n, 0);
  assert.equal(r.calibration_stats_model.reduce((s, b) => s + b.n, 0), r.methods.stats_model.n);
  const hi = r.calibration_stats_model.filter((b) => b.n && b.mean_predicted! > 0.6);
  assert.ok(hi.length && hi.every((b) => b.observed_rate! > 0.6), 'high predictions are mostly positive');
  assert.ok(r.notes.some((x) => /Jev is not scored/.test(x)));
  assert.equal(r.notes.some((x) => /^small sample: only \d+ test labels/.test(x)), r.split.test_labels < 30);
  assert.ok(r.notes.some((x) => /small sample: 0 explicit-feedback/.test(x)));
  // no contents leak into the result
  assert.ok(!/loved_a|meh_a/.test(JSON.stringify(r)));
  // Jev predictions on test items are scored when they exist
  const testItem = labels.filter((l) => l.at >= r.split.cutoff!)[0].item_id;
  d.prepare("INSERT INTO predictions (id, item_id, scorer, model_version, preference_summary_version, p_match, created_at) VALUES ('pr1', ?, 'jev', 'm', 'v', 0.9, ?)").run(testItem, NEWEST);
  const r2 = evaluate(d);
  assert.equal(r2.methods.jev_p_match.n, 1);
  assert.ok(r2.notes.some((x) => /small sample: Jev scored on 1/.test(x)));
  // too few labels
  const empty = evaluate(mkdb());
  assert.ok(empty.notes[0].includes('too few'));
});
