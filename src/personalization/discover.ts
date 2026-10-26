import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { discoverConfig, jevConfig } from '../config.js';
import { executeSearch } from '../providers/search.js';
import { executeFetch } from '../providers/fetch.js';
import { personalDb, FeedInputError } from './feed.js';
import { preferenceSummary, scorePost, type JevScore } from './jev.js';
import { usedToday } from './filter.js';
import { rebuildPreferences, activeRules, lastingFeedback, topKeys } from './preferences.js';
import { parseWhen, parseVenue, venueFromSnippet, looksEnded, parsePrice, looksOnline, cleanTitle, oneLine, type ParsedWhen } from './eventparse.js';

export interface DiscoverRequest {
  intent?: string;
  constraints?: { days?: number; radius_km?: number; near?: string; topic?: string };
  limit?: number;
  client?: string;
}
export interface DiscoverDeps {
  search?: typeof executeSearch;
  fetch?: typeof executeFetch;
  score?: typeof scorePost;
  now?: Date;
}

const SOURCES = [
  { id: 'humanitix', site: 'site:events.humanitix.com' },
  { id: 'eventbrite', site: 'site:eventbrite.com.au' },
] as const;
// Categories from the owner's current daily discovery cron.
export const CATEGORIES = [
  { id: 'gigs', q: 'live music gig' },
  { id: 'film', q: 'film screening' },
  { id: 'writing_competition', q: 'writing competition submissions' },
  { id: 'writing_group', q: 'writing group' },
  { id: 'book_swap_club', q: 'book swap book club' },
  { id: 'volunteering', q: 'volunteering' },
] as const;

const RANKER_VERSION = 'discover-1';
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const DAY = 86_400_000;
const CONCURRENCY = 4;

interface Cand {
  source: string; native: string; url: string; title: string; snippet: string; category: string; rank: number; qi: number;
}
interface Ev extends Cand {
  itemId: string; description: string; when: ParsedWhen; venue: string | null; online: boolean;
  price: ReturnType<typeof parsePrice>; status: 'cancelled' | 'sold_out' | 'unknown'; fetched: boolean;
  score: number | null; p_match: number | null; p_engage: number | null; confidence: number | null; reasons: string[]; dropped: string | null;
}

async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

/** Event pages only: Humanitix `events.humanitix.com/<slug>`, Eventbrite `/e/<slug>-<id>`. Everything else (listings, organiser pages) is skipped. */
export function eventRef(rawUrl: string): { source: string; native: string; url: string } | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'events.humanitix.com' && parts.length === 1 && !['host', 'discover', 'search'].includes(parts[0])) {
    return { source: 'humanitix', native: parts[0].toLowerCase(), url: `https://events.humanitix.com/${parts[0]}` };
  }
  if (/(^|\.)eventbrite\.[a-z.]+$/.test(host) && parts.length === 2 && parts[0] === 'e') {
    const id = /(\d{6,})$/.exec(parts[1])?.[1];
    if (id) return { source: 'eventbrite', native: id, url: `https://www.eventbrite.com.au/e/${parts[1]}` };
  }
  return null;
}

const sanitizeNear = (v: unknown, fallback: string) => (typeof v === 'string' && /^[\p{L}\p{N} .,'-]{1,60}$/u.test(v.trim()) ? v.trim() : fallback);

export async function personalDiscover(req: DiscoverRequest, deps: DiscoverDeps = {}) {
  const cfg = discoverConfig();
  const jev = jevConfig();
  const search = deps.search ?? executeSearch;
  const fetchPage = deps.fetch ?? executeFetch;
  const score = deps.score ?? scorePost;
  const now = deps.now ?? new Date();

  const c = req.constraints ?? {};
  const days = c.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new FeedInputError('constraints.days must be an integer 1..90');
  if (c.radius_km !== undefined && !(typeof c.radius_km === 'number' && c.radius_km > 0 && c.radius_km <= 1000)) throw new FeedInputError('constraints.radius_km must be a number 1..1000');
  const limit = req.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new FeedInputError(`limit must be an integer 1..${MAX_LIMIT}`);
  const intent = typeof req.intent === 'string' && req.intent.trim() ? req.intent.trim().slice(0, 200) : null;
  const near = sanitizeNear(c.near, cfg.city);

  const d = personalDb();
  const runId = `dsc_${randomUUID()}`;
  const started = now.toISOString();
  d.prepare('INSERT INTO discovery_runs (id, client, intent, constraints_json, ranker_version, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, req.client ?? 'unknown', intent, JSON.stringify({ days, radius_km: c.radius_km ?? null, near }), RANKER_VERSION, started, 'running');

  // Preferences are rebuilt first so Jev sees the current tastes (and its cache follows the summary version).
  rebuildPreferences(d, started);
  const prefs = preferenceSummary(d);

  const failures = new Map<string, { source: string; step: string; error: string; count: number }>();
  const fail = (source: string, step: string, err: unknown) => {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
    const k = `${source}|${step}`;
    const f = failures.get(k);
    if (f) f.count++; else failures.set(k, { source, step, error: msg, count: 1 });
  };

  // 1. Search: the owner's categories x month x source. Intent is recorded, not searched (a generic intent made poor queries);
  // an explicit constraints.topic is searched first, in addition to the categories.
  const queries: Array<{ source: string; category: string; q: string }> = [];
  const topic = typeof c.topic === 'string' && /^[\p{L}\p{N} .,'&-]{2,60}$/u.test(c.topic.trim()) ? c.topic.trim() : null;
  const cats = topic ? [{ id: 'topic', q: topic }, ...CATEGORIES] : [...CATEGORIES];
  // Search engines cannot filter by event date, so the month names of the window go into the query.
  const monthName = (t: number) => new Date(t).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Melbourne' });
  const months = [...new Set([monthName(now.getTime()), monthName(now.getTime() + days * DAY)])];
  for (const cat of cats) for (const m of months) for (const s of SOURCES) queries.push({ source: s.id, category: cat.id, q: `${s.site} ${near} ${cat.q} ${m}` });
  const usedQueries = queries.slice(0, cfg.maxSearches);
  const found = await pool(CONCURRENCY, usedQueries.map((q, qi) => async () => {
    try {
      const r = await search(q.q, { limit: 10 });
      return r.results.map((x, rank): Cand | null => {
        const ref = eventRef(x.url);
        return ref ? { ...ref, title: x.title, snippet: x.snippet ?? '', category: q.category, rank, qi } : null;
      }).filter((x): x is Cand => !!x);
    } catch (e) { fail(q.source, 'search', e); return [] as Cand[]; }
  }));
  const seen = new Set<string>();
  const cands: Cand[] = [];
  // Interleave by rank so the page cap is spread over every category and source.
  for (const x of found.flat().sort((a, b) => a.rank - b.rank || a.qi - b.qi)) {
    const k = `${x.source}:${x.native}`;
    if (!seen.has(k)) { seen.add(k); cands.push(x); }
  }
  // A date in the snippet or title that is clearly outside the window saves a page fetch.
  const winStart = now.getTime() - DAY, winEndMs = now.getTime() + days * DAY;
  let skippedBySnippet = 0;
  const pages = cands.filter((x) => {
    const w = parseWhen(`${x.title}\n${x.snippet}`, now);
    const t = w.starts_at ? Date.parse(w.starts_at) : null;
    if (t !== null && (t < winStart || t > winEndMs)) { skippedBySnippet++; return false; }
    return true;
  }).slice(0, cfg.maxPages);

  // 2. Fetch event pages (bounded) and extract facts.
  const fetched = await pool(CONCURRENCY, pages.map((p) => async () => {
    try { return await fetchPage(p.url, { maxChars: 8000 }); } catch (e) { fail(p.source, 'fetch', e); return null; }
  }));

  const upsert = d.prepare('SELECT item_id FROM item_ids WHERE provider = ? AND native_id = ?');
  const insItem = d.prepare("INSERT INTO items (id, kind, title, description, canonical_url, first_seen_at, updated_at) VALUES (?, 'event', ?, ?, ?, ?, ?)");
  const updItem = d.prepare('UPDATE items SET title = ?, description = ?, canonical_url = ?, updated_at = ? WHERE id = ?');
  const insId = d.prepare('INSERT INTO item_ids (item_id, provider, native_id) VALUES (?, ?, ?)');
  const putDetails = d.prepare(`INSERT OR REPLACE INTO event_details (item_id, starts_at, ends_at, timezone, time_precision, venue_text, price_min, price_max, currency, booking_url, category, status, last_checked_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const events: Ev[] = [];
  d.exec('BEGIN');
  try {
    pages.forEach((p, i) => {
      const page = fetched[i];
      const md = page?.markdown ?? '';
      const title = cleanTitle(page?.title || p.title) || cleanTitle(p.title);
      if (!title) return;
      const head = `${title}\n${p.snippet}`;
      // Eventbrite puts the date in the page title; Humanitix in the page body. The search snippet is the last resort.
      let when: ParsedWhen = page?.title ? parseWhen(page.title, now) : { starts_at: null, precision: 'unknown', local: null };
      if (when.precision === 'unknown' && md) when = parseWhen(md, now);
      if (when.precision === 'unknown') when = parseWhen(head, now);
      const venue = (md && parseVenue(md)) || venueFromSnippet(p.snippet) || null;
      const online = looksOnline(head) || /^\s*online event\s*$/im.test(md);
      const ended = looksEnded(md.slice(0, 4000));
      const price = parsePrice(md || head);
      const body = `${md.slice(0, 3000)} ${head}`;
      const status = /\bsold out\b/i.test(body.slice(0, 1500)) ? 'sold_out' : /\b(?:this event (?:has been )?cancel+ed|event cancel+ed|cancel+ed event)\b/i.test(body) ? 'cancelled' : 'unknown';
      const description = oneLine(md || p.snippet, 600);
      const existing = upsert.get(p.source, p.native) as any;
      let itemId: string;
      if (existing) { itemId = existing.item_id; updItem.run(title, description, p.url, now.toISOString(), itemId); }
      else {
        itemId = `it_${randomUUID()}`;
        insItem.run(itemId, title, description, p.url, now.toISOString(), now.toISOString());
        insId.run(itemId, p.source, p.native);
      }
      putDetails.run(itemId, when.starts_at, 'Australia/Melbourne', when.precision, venue, price.min, price.max, price.currency, p.url, p.category, status, now.toISOString());
      events.push({ ...p, title, itemId, description, when, venue, online, price, status, fetched: !!page, score: null, p_match: null, p_engage: null, confidence: null, reasons: [], dropped: ended ? 'ended' : null });
    });
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }

  // 3. Window, cancelled, explicit rules and lasting owner feedback.
  const winEnd = now.getTime() + days * DAY;
  const rules = activeRules(d, started);
  const fb = lastingFeedback(d);
  const hay = (e: Ev) => `${e.title} ${e.description} ${e.venue ?? ''} ${e.category}`.toLowerCase();
  const stats = { searches: usedQueries.length, candidates: cands.length, skipped_by_snippet_date: skippedBySnippet, pages_fetched: fetched.filter(Boolean).length, parsed: events.length, outside_window: 0, ended: 0, wrong_area: 0, excluded: 0, cancelled: 0 };
  for (const e of events) {
    if (e.dropped === 'ended') { stats.ended++; continue; }
    const t = e.when.starts_at ? Date.parse(e.when.starts_at) : null;
    if (e.status === 'cancelled') { e.dropped = 'cancelled'; stats.cancelled++; continue; }
    if (t !== null) {
      const floor = e.when.precision === 'day' ? now.getTime() - DAY : now.getTime();
      if (t < floor || t > winEnd) { e.dropped = 'outside_window'; stats.outside_window++; continue; }
    }
    // Melbourne search only: an address that names another state is not in range. No state in the text means unknown, which stays.
    if (/melbourne|vic/i.test(near) && e.venue && /\b(NSW|QLD|WA|SA|TAS|ACT|NT)\b\s*\d{4}\b/.test(e.venue) && !/\bVIC\b/.test(e.venue)) { e.dropped = 'wrong_area'; stats.wrong_area++; continue; }
    const h = hay(e);
    const ex = rules.find((r) => r.rule === 'exclude' && h.includes(r.subject_key));
    const neg = fb.find((f) => !f.positive && (f.scope === 'item' ? f.key === e.itemId : f.scope === 'venue' ? !!e.venue && e.venue.toLowerCase() === f.key : h.includes(f.key)));
    if (ex || neg) { e.dropped = 'excluded'; stats.excluded++; }
  }
  const live = events.filter((e) => !e.dropped);

  // 4. Jev scoring: cached by item and preference-summary version; at most maxJev new calls per run and within the daily budget.
  const find = d.prepare("SELECT * FROM predictions WHERE item_id = ? AND scorer = 'jev' AND preference_summary_version = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const insPred = d.prepare(`INSERT INTO predictions (id, item_id, collection_run_id, scorer, model_version, preference_summary_version, p_match, p_engage,
    confidence, cost_usd, calibrated, passed_filter, created_at) VALUES (?, ?, NULL, 'jev', ?, ?, ?, ?, ?, ?, 0, NULL, ?)`);
  const sc = new Map<string, JevScore>();
  let cached = 0, newCalls = 0, cost = 0, scoreErrors = 0;
  const toCall: Ev[] = [];
  const order = [...live].sort((a, b) => (a.when.starts_at ? 0 : 1) - (b.when.starts_at ? 0 : 1) || (a.when.starts_at ?? '').localeCompare(b.when.starts_at ?? ''));
  for (const e of order) {
    const row = find.get(e.itemId, prefs.version) as any;
    if (row) { sc.set(e.itemId, row); cached++; } else toCall.push(e);
  }
  const used = usedToday(d);
  let dayPosts = used.posts, dayUsd = used.usd;
  await pool(CONCURRENCY, toCall.map((e) => async () => {
    if (newCalls >= cfg.maxJev || dayPosts >= jev.maxPostsPerDay || dayUsd >= jev.maxUsdPerDay) return;
    newCalls++; dayPosts++;
    try {
      const r = await score({
        caption: [e.title, e.when.starts_at ? `When: ${whenText(e.when)}` : null, e.venue ? `Where: ${e.venue}` : null, priceText(e.price) ? `Price: ${priceText(e.price)}` : null, e.description].filter(Boolean).join('\n'),
        author: e.venue ? { name: e.venue } : null, type: 'event', hashtags: [e.category], location: e.venue ? { name: e.venue } : null, sponsored: false, suggested: false,
      }, prefs);
      dayUsd += r.cost_usd ?? 0; cost += r.cost_usd ?? 0;
      insPred.run(`pred_${randomUUID()}`, e.itemId, r.model_version, prefs.version, r.p_match, r.p_engage, r.confidence, r.cost_usd, new Date().toISOString());
      sc.set(e.itemId, r);
    } catch (err) { scoreErrors++; fail('jev', 'score', err); }
  }));

  // 5. Rank. Jev probability first, then the owner's explicit rules and feedback on top.
  const topArtists = topKeys(d, 'music_artist', 60).filter((k) => k.length >= 4);
  const topAuthors = topKeys(d, 'ig_author', 60).filter((k) => k.length >= 4);
  for (const e of live) {
    const s = sc.get(e.itemId);
    const h = hay(e);
    let adj = 0;
    if (s) { e.p_match = s.p_match; e.p_engage = s.p_engage; e.confidence = s.confidence; }
    e.reasons.push(s ? `Jev match ${s.p_match.toFixed(2)}${s.p_engage !== null ? `, want-to-see ${s.p_engage.toFixed(2)}` : ''}` : 'not scored by Jev');
    for (const r of rules) {
      if (r.rule === 'prefer' && h.includes(r.subject_key)) { adj += 0.15; e.reasons.push(`you prefer "${r.subject_key}"`); }
      if (r.rule === 'avoid' && h.includes(r.subject_key)) { adj -= 0.3; e.reasons.push(`you asked to avoid "${r.subject_key}"`); }
    }
    for (const f of fb) {
      if (f.positive && (f.scope === 'item' ? f.key === e.itemId : f.scope === 'venue' ? !!e.venue && e.venue.toLowerCase() === f.key : h.includes(f.key))) { adj += 0.1; e.reasons.push('you liked something similar'); break; }
    }
    const artist = topArtists.find((k) => h.includes(k));
    if (artist) e.reasons.push(`mentions "${artist}", one of your most played artists`);
    const author = topAuthors.find((k) => h.includes(k));
    if (author) e.reasons.push(`mentions "${author}", an Instagram account you like`);
    if (!e.when.starts_at) adj -= 0.1;
    const base = s ? 0.7 * s.p_match + 0.3 * (s.p_engage ?? s.p_match) : 0.25;
    e.score = Math.min(1, Math.max(0, base + adj));
  }
  live.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.when.starts_at ?? '9').localeCompare(b.when.starts_at ?? '9') || a.title.localeCompare(b.title));
  const top = live.slice(0, limit);

  // 6. Deliveries.
  const returnedAt = new Date().toISOString();
  const insDel = d.prepare('INSERT INTO deliveries (id, discovery_run_id, item_id, position, reason, returned_at) VALUES (?, ?, ?, ?, ?, ?)');
  const items = top.map((e, i) => {
    const deliveryId = `dlv_${randomUUID()}`;
    const reason = e.reasons.join('; ');
    insDel.run(deliveryId, runId, e.itemId, i + 1, reason, returnedAt);
    const unc: string[] = [];
    if (!e.when.starts_at) unc.push('date not found on the page');
    else if (e.when.precision === 'day') unc.push('start time not stated (date only)');
    if (!e.venue && !e.online) unc.push('venue not found');
    if (e.online) unc.push('looks like an online event');
    if (!e.fetched) unc.push('page could not be fetched; facts come from the search snippet');
    if (e.price.min === null) unc.push('price not found'); else if (!e.price.free) unc.push('price read from page text; may include add-ons or fees');
    if (e.status === 'sold_out') unc.push('page says sold out');
    if (!sc.get(e.itemId)) unc.push('not scored by Jev (budget or error)');
    if (c.radius_km !== undefined) unc.push('radius_km not checked: distance is not computed');
    return {
      rank: i + 1, delivery_id: deliveryId, item_id: e.itemId, title: e.title, url: e.url, source: e.source, category: e.category,
      starts_at: e.when.starts_at, time_precision: e.when.precision, timezone: 'Australia/Melbourne',
      venue: e.venue, price: { min: e.price.min, max: e.price.max, currency: e.price.currency, free: e.price.free || null },
      status: e.status, score: e.score === null ? null : Math.round(e.score * 1000) / 1000,
      p_match: e.p_match, p_engage: e.p_engage, confidence: e.confidence, reason, uncertainty: unc,
    };
  });

  const failed_sources = [...failures.values()];
  const status = !events.length && failed_sources.length ? 'failed' : failed_sources.length ? 'partial' : 'ok';
  const result = {
    schema_version: 'discover.v1', run_id: runId, status, intent, constraints: { days, radius_km: c.radius_km ?? null, near },
    preference_summary_version: prefs.version,
    counts: { ...stats, eligible: live.length, with_exact_date: live.filter((e) => e.when.starts_at).length, with_start_time: live.filter((e) => e.when.precision === 'minute').length,
      jev_calls: newCalls, jev_cached: cached, jev_errors: scoreErrors, returned: items.length },
    cost_usd: Math.round(cost * 1e6) / 1e6,
    failed_sources, items,
  };
  d.prepare('UPDATE discovery_runs SET finished_at = ?, status = ?, failed_sources_json = ?, stats_json = ? WHERE id = ?')
    .run(new Date().toISOString(), status, JSON.stringify(failed_sources), JSON.stringify({ ...result.counts, cost_usd: result.cost_usd }), runId);
  return result;
}

function whenText(w: ParsedWhen): string {
  if (!w.local) return 'unknown';
  const { y, m, d, hh, mm } = w.local;
  const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return hh === null ? day : `${day} ${String(hh).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')} Melbourne time`;
}
function priceText(p: ReturnType<typeof parsePrice>): string | null {
  if (p.free && (p.max === 0 || p.max === null)) return 'free';
  if (p.min === null) return null;
  return p.min === p.max ? `$${p.min}` : `$${p.min}-$${p.max}`;
}

