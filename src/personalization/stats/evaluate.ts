import type { DatabaseSync } from 'node:sqlite';
import { fitFromDb, itemSubjects, loadItemRow, memoryLookup, scoreSubjects, statsConfig, SUBJECT_TYPES, type StatsConfig } from './model.js';

export interface Label { item_id: string; y: 0 | 1; at: string; source: 'feedback' | 'import_like' | 'seen_no_action' }

export interface MethodScore { n: number; brier: number | null; log_loss: number | null }
export interface Bucket { range: string; n: number; mean_predicted: number | null; observed_rate: number | null }
export interface EvalResult {
  schema_version: 'evaluate.v1';
  labels: { total: number; positive: number; negative: number; by_source: Record<string, number> };
  split: { cutoff: string | null; train_labels: number; test_labels: number; test_positive: number; test_negative: number };
  covered: { test_with_subjects: number; test_without_subjects: number };
  methods: { type_prior_baseline: MethodScore; stats_model: MethodScore; jev_p_match: MethodScore; stats_model_on_jev_items: MethodScore; type_prior_on_jev_items: MethodScore };
  explicit_feedback_only: { test_labels: number; type_prior_baseline: MethodScore; stats_model: MethodScore };
  calibration_stats_model: Bucket[];
  notes: string[];
}

const EPS = 1e-6;
const score = (pairs: Array<[number, 0 | 1]>): MethodScore => {
  if (!pairs.length) return { n: 0, brier: null, log_loss: null };
  let b = 0, l = 0;
  for (const [p, y] of pairs) {
    b += (p - y) ** 2;
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    l += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  }
  return { n: pairs.length, brier: Math.round((b / pairs.length) * 1e4) / 1e4, log_loss: Math.round((l / pairs.length) * 1e4) / 1e4 };
};

/** Owner-labelled outcomes: explicit feedback, imported likes/saves, and feed items seen without any action. One label per item (positive wins). */
export function collectLabels(d: DatabaseSync): Label[] {
  const raw: Label[] = [];
  for (const r of d.prepare(`SELECT item_id, type, scope, created_at at FROM feedback WHERE type IN ('like','save','want_to_go','dislike') ORDER BY created_at, id`).all() as any[]) {
    if (r.type === 'dislike' && r.scope === 'this_time') continue; // "not tonight" is not a taste label
    raw.push({ item_id: r.item_id, y: r.type === 'dislike' ? 0 : 1, at: r.at, source: 'feedback' });
  }
  for (const r of d.prepare(`SELECT o.item_id, o.occurred_at at FROM observations o JOIN source_accounts a ON a.id = o.source_account_id
      WHERE o.learn = 1 AND a.provider = 'instagram' AND o.action IN ('like','save') ORDER BY o.id`).all() as any[]) raw.push({ item_id: r.item_id, y: 1, at: r.at, source: 'import_like' });
  for (const r of d.prepare(`SELECT o.item_id, o.occurred_at at FROM observations o JOIN source_accounts a ON a.id = o.source_account_id
      WHERE o.learn = 1 AND o.action = 'seen_in_feed' AND a.provider IN ('instagram','rss') AND COALESCE(o.sponsored, 0) = 0 ORDER BY o.id`).all() as any[]) raw.push({ item_id: r.item_id, y: 0, at: r.at, source: 'seen_no_action' });
  const byItem = new Map<string, Label>();
  for (const l of raw.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const e = byItem.get(l.item_id);
    if (!e || (e.y === 0 && l.y === 1)) byItem.set(l.item_id, l); // positive wins, with its own time
  }
  return [...byItem.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.item_id < b.item_id ? -1 : 1));
}

/**
 * Chronological split: the model is fitted on evidence strictly before the cutoff (70th percentile of label times) and
 * judged on labels at or after it. Returns counts and scores only.
 */
export function evaluate(d: DatabaseSync, over: Partial<StatsConfig> = {}, trainFraction = 0.7): EvalResult {
  const cfg = statsConfig(over);
  const labels = collectLabels(d);
  const notes: string[] = [];
  const res: EvalResult = {
    schema_version: 'evaluate.v1',
    labels: { total: labels.length, positive: labels.filter((l) => l.y === 1).length, negative: labels.filter((l) => l.y === 0).length,
      by_source: labels.reduce((m, l) => ({ ...m, [l.source]: (m[l.source] ?? 0) + 1 }), {} as Record<string, number>) },
    split: { cutoff: null, train_labels: 0, test_labels: 0, test_positive: 0, test_negative: 0 },
    covered: { test_with_subjects: 0, test_without_subjects: 0 },
    methods: { type_prior_baseline: score([]), stats_model: score([]), jev_p_match: score([]), stats_model_on_jev_items: score([]), type_prior_on_jev_items: score([]) },
    explicit_feedback_only: { test_labels: 0, type_prior_baseline: score([]), stats_model: score([]) },
    calibration_stats_model: [],
    notes,
  };
  if (labels.length < 4) { notes.push('too few labelled outcomes to split (need at least 4)'); return res; }

  const cutoff = labels[Math.floor(labels.length * trainFraction)].at;
  const test = labels.filter((l) => l.at >= cutoff);
  res.split = { cutoff, train_labels: labels.length - test.length, test_labels: test.length, test_positive: test.filter((l) => l.y === 1).length, test_negative: test.filter((l) => l.y === 0).length };

  const { fit } = fitFromDb(d, cfg, cutoff);
  const lookup = memoryLookup(fit);
  const priorMean = (types: Set<string>) => {
    const m = [...types].map((t) => fit.priors[t]?.mean ?? 0.5);
    return m.length ? m.reduce((x, y) => x + y, 0) / m.length : 0.5;
  };
  const predJev = d.prepare("SELECT p_match FROM predictions WHERE item_id = ? AND scorer = 'jev' ORDER BY created_at DESC, rowid DESC LIMIT 1");

  const sj: Array<[number, 0 | 1]> = [], bj: Array<[number, 0 | 1]> = [];
  const base: Array<[number, 0 | 1]> = [], stat: Array<[number, 0 | 1]> = [], jev: Array<[number, 0 | 1]> = [];
  const baseE: Array<[number, 0 | 1]> = [], statE: Array<[number, 0 | 1]> = [];
  for (const l of test) {
    const row = loadItemRow(d, l.item_id);
    const subs = row ? itemSubjects(row) : [];
    const st = row ? scoreSubjects(subs, row.text, lookup, cfg) : null;
    if (!subs.length && !st) { res.covered.test_without_subjects++; continue; }
    res.covered.test_with_subjects++;
    // Baseline: the typical rate of the subject types the item matches, with no subject-specific evidence.
    const types = new Set([...subs.map((s) => s.type), ...(st?.matched.map((m) => m.subject_type) ?? [])]);
    const p0 = priorMean(types);
    base.push([p0, l.y]);
    const p1 = st ? st.score : p0; // a subject with no evidence falls back to its type prior
    stat.push([p1, l.y]);
    if (l.source === 'feedback') { baseE.push([p0, l.y]); statE.push([p1, l.y]); }
    const j = predJev.get(l.item_id) as any;
    if (j) { jev.push([j.p_match, l.y]); sj.push([p1, l.y]); bj.push([p0, l.y]); }
  }
  res.methods = { type_prior_baseline: score(base), stats_model: score(stat), jev_p_match: score(jev), stats_model_on_jev_items: score(sj), type_prior_on_jev_items: score(bj) };
  res.explicit_feedback_only = { test_labels: statE.length, type_prior_baseline: score(baseE), stats_model: score(statE) };

  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  res.calibration_stats_model = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inb = stat.filter(([p]) => p >= lo && p < hi);
    return { range: `${lo.toFixed(1)}-${Math.min(1, hi).toFixed(1)}`, n: inb.length,
      mean_predicted: inb.length ? Math.round((inb.reduce((s, [p]) => s + p, 0) / inb.length) * 1e3) / 1e3 : null,
      observed_rate: inb.length ? Math.round((inb.reduce((s, [, y]) => s + y, 0) / inb.length) * 1e3) / 1e3 : null };
  });

  if (res.split.test_labels < 30) notes.push(`small sample: only ${res.split.test_labels} test labels; scores are indicative only`);
  if (res.split.test_positive === 0 || res.split.test_negative === 0) notes.push('the test set has only one outcome class; Brier and log loss are not comparable across methods');
  const rate = res.split.test_labels ? res.split.test_positive / res.split.test_labels : 0.5;
  if (res.split.test_labels && (rate > 0.95 || rate < 0.05)) notes.push(`${(rate * 100).toFixed(1)}% of test outcomes are positive: scores mostly reflect that base rate, and a model that predicts it constantly would beat all of these`);
  if (res.methods.jev_p_match.n === 0) notes.push('no stored Jev predictions for the test items; Jev is not scored');
  else if (res.methods.jev_p_match.n < 30) notes.push(`small sample: Jev scored on ${res.methods.jev_p_match.n} items`);
  if (res.explicit_feedback_only.test_labels < 30) notes.push(`small sample: ${res.explicit_feedback_only.test_labels} explicit-feedback test labels`);
  notes.push(`subject types modelled: ${SUBJECT_TYPES.join(', ')}; the prior of a type fits only that type's subjects`);
  return res;
}

export function formatEvaluate(r: EvalResult): string {
  const m = (x: MethodScore) => (x.n ? `n=${x.n} brier=${x.brier} log_loss=${x.log_loss}` : 'n=0');
  return [
    `labels: ${r.labels.total} (${r.labels.positive} positive, ${r.labels.negative} negative; ${Object.entries(r.labels.by_source).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    `split at ${r.split.cutoff ?? 'n/a'}: train ${r.split.train_labels}, test ${r.split.test_labels} (${r.split.test_positive} positive, ${r.split.test_negative} negative); with subjects ${r.covered.test_with_subjects}, without ${r.covered.test_without_subjects}`,
    `type-prior baseline: ${m(r.methods.type_prior_baseline)}`,
    `stats model:         ${m(r.methods.stats_model)}`,
    `jev p_match:         ${m(r.methods.jev_p_match)}`,
    `  same items as Jev:  baseline ${m(r.methods.type_prior_on_jev_items)}; stats ${m(r.methods.stats_model_on_jev_items)}`,
    `explicit feedback only (n=${r.explicit_feedback_only.test_labels}): baseline ${m(r.explicit_feedback_only.type_prior_baseline)}; stats ${m(r.explicit_feedback_only.stats_model)}`,
    'calibration (stats model): ' + r.calibration_stats_model.map((b) => `${b.range} n=${b.n}${b.n ? ` pred=${b.mean_predicted} obs=${b.observed_rate}` : ''}`).join(' | '),
    ...r.notes.map((n) => `note: ${n}`),
  ].join('\n');
}
