import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { personalDb, closePersonalDb, FeedInputError } from '../../src/personalization/feed.js';
import { personalDiscover } from '../../src/personalization/discover.js';
import { recordFeedback } from '../../src/personalization/feedback.js';
import { personalPreferences, rebuildPreferences, SUMMARY_MAX_CHARS } from '../../src/personalization/preferences.js';
import { preferenceSummary } from '../../src/personalization/jev.js';
import { parseWhen, parsePrice, parseVenue } from '../../src/personalization/eventparse.js';
import { registerPersonalRoutes } from '../../src/personalization/routes.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

const dir = mkdtempSync(join(tmpdir(), 'phrog-discover-'));
const TOKEN = 'test-token-not-real';
const NOW = new Date('2026-10-26T00:00:00Z'); // a Monday, Melbourne is on daylight time
let n = 0;

before(() => {
  process.env.PHROG_PERSONAL_TOKEN = TOKEN;
  delete process.env.PHROG_TASTE_FILE;
});
beforeEach(() => {
  closePersonalDb();
  process.env.PHROG_PERSONAL_DB = join(dir, `d${++n}.db`);
  delete process.env.PHROG_DISCOVER_MAX_JEV;
  delete process.env.PHROG_DISCOVER_MAX_PAGES;
  delete process.env.PHROG_JEV_MAX_POSTS_PER_DAY;
  delete process.env.PHROG_JEV_MAX_USD_PER_DAY;
});
after(() => { closePersonalDb(); rmSync(dir, { recursive: true, force: true }); });

// ---------- fakes ----------
const PAGES: Record<string, { title: string; markdown: string }> = {
  'https://events.humanitix.com/great-film': { title: 'Great Film Night', markdown: '# Great Film Night\nThu, 29 Oct, 7pm - 9pm AEDT\n## Location\nThe Backlot, 1 Main St, Fitzroy VIC 3065\nFree entry' },
  'https://events.humanitix.com/boring-seminar': { title: 'Boring Seminar', markdown: '# Boring Seminar\nFri, 30 Oct, 6pm AEDT\n## Location\nTown Hall, Melbourne VIC 3000\nTickets $20' },
  'https://events.humanitix.com/old-event': { title: 'Old Event', markdown: '# Old Event\nThu, 13 Aug, 7pm AEST\n## Location\nSomewhere VIC' },
  'https://events.humanitix.com/no-date': { title: 'No Date Event', markdown: '# No Date Event\nCome along sometime.' },
  'https://events.humanitix.com/sydney-gig': { title: 'Great Sydney Gig', markdown: '# Great Sydney Gig\nFri, 30 Oct, 8pm AEDT\n## Location\nThe Pub, Camden NSW 2570' },
  'https://www.eventbrite.com.au/e/great-jazz-night-tickets-1000000000001': { title: 'Great Jazz Night Tickets, Saturday, October 31  •  8 PM | Eventbrite', markdown: 'Great Jazz Night' },
};
const RESULTS = Object.keys(PAGES).map((url) => ({ title: PAGES[url].title, url, snippet: '' }));

function fakes(opts: { failEventbriteWriting?: boolean } = {}) {
  const calls = { search: 0, fetch: [] as string[], score: [] as string[] };
  return {
    calls,
    deps: {
      now: NOW,
      search: (async (q: string) => {
        calls.search++;
        if (opts.failEventbriteWriting && q.includes('eventbrite') && q.includes('writing group')) throw new Error('searxng down');
        return { query: q, results: [...RESULTS, { title: 'Listing', url: 'https://events.humanitix.com/discover', snippet: '' }], provider_used: 'fake', total: 1 };
      }) as any,
      fetch: (async (url: string) => {
        calls.fetch.push(url);
        const p = PAGES[url];
        if (!p) throw new Error('404');
        return { url, title: p.title, markdown: p.markdown, length: p.markdown.length, provider_used: 'fake' };
      }) as any,
      score: (async (post: any) => {
        calls.score.push(post.caption.split('\n')[0]);
        const great = /great/i.test(post.caption);
        return { p_match: great ? 0.9 : 0.3, p_engage: great ? 0.8 : 0.2, confidence: 0.9, cost_usd: 0.001, model_version: 'fake-jev' };
      }) as any,
    },
  };
}

// ---------- preferences ----------
function seedHistory() {
  const d = personalDb();
  const at = '2026-10-20T10:00:00Z';
  const old = '2025-01-05T10:00:00Z';
  d.prepare("INSERT INTO source_accounts (id, provider, handle) VALUES ('a_ig','instagram','me'), ('a_sp','spotify','me'), ('a_g','google','me')").run();
  const item = (id: string, kind: string, title: string | null, creator: string | null = null, author: string | null = null) =>
    d.prepare("INSERT INTO items (id, kind, title, creator_item_id, author_json, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, kind, title, creator, author, at, at);
  let k = 0;
  const obs = (acc: string, itemId: string, action: string, when: string, learn = 1) =>
    d.prepare('INSERT INTO observations (source_account_id, item_id, action, occurred_at, learn, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)').run(acc, itemId, action, when, learn, `k${++k}`);
  item('it_c1', 'creator', 'Poet_One');
  item('it_c2', 'creator', 'noise_author');
  item('it_p1', 'post', null, 'it_c1');
  item('it_p2', 'post', null, 'it_c1');
  item('it_p3', 'post', null, 'it_c2');
  obs('a_ig', 'it_p1', 'like', at); obs('a_ig', 'it_p2', 'save', old);
  obs('a_ig', 'it_p3', 'seen_in_feed', at); // learn=1 by default but not a deliberate action
  item('it_t1', 'track', 'Song', null, JSON.stringify({ artist: 'Band A' }));
  item('it_t2', 'track', 'Other', null, JSON.stringify({ artist: 'Band B' }));
  obs('a_sp', 'it_t1', 'play', at); obs('a_sp', 'it_t1', 'play', at); obs('a_sp', 'it_t1', 'play', old); obs('a_sp', 'it_t2', 'play', old);
  for (let i = 0; i < 5; i++) obs('a_sp', 'it_t2', 'skip', at);
  item('it_v1', 'venue', 'Cafe Nice');
  d.prepare(`INSERT INTO entity_state (state_key, source_account_id, item_id, counterparty, relation, state, first_observed_at, last_observed_at)
    VALUES ('s1', 'a_g', 'it_v1', 'Good Cafe', 'save', 'active', ?, ?)`).run(at, at);
  // An agent decision about noise_author's post: must never count as taste.
  d.prepare("INSERT INTO agent_decisions (id, item_id, client, decision, created_at, idempotency_key) VALUES ('dcn_1', 'it_p3', 'hermes', 'interesting', ?, 'x')").run(at);
}

const rows = () => personalDb().prepare('SELECT subject_type, subject_key, horizon, score, evidence_count, distinct_days, version FROM preferences ORDER BY subject_type, subject_key, horizon').all();

test('preference rebuild is deterministic and uses deliberate actions only', () => {
  seedHistory();
  const d = personalDb();
  const a = rebuildPreferences(d, '2026-10-26T00:00:00Z');
  const rowsA = JSON.stringify(rows());
  const b = rebuildPreferences(d, '2026-10-26T00:00:00Z');
  assert.equal(a.version, b.version);
  assert.equal(a.text, b.text);
  assert.equal(JSON.stringify(rows()), rowsA);

  const r = rows() as any[];
  const find = (t: string, k: string, h: string) => r.find((x) => x.subject_type === t && x.subject_key === k && x.horizon === h);
  assert.equal(find('ig_author', 'poet_one', 'long').score, 3); // like 1 + save 2
  assert.equal(find('ig_author', 'poet_one', 'recent').score, 1); // the save is older than 90 days of available data
  assert.equal(find('ig_author', 'noise_author', 'long'), undefined); // seen_in_feed and agent decisions are not taste
  assert.equal(find('music_artist', 'band a', 'long').score, 3);
  assert.equal(find('music_artist', 'band b', 'long').score, 1); // 5 skips not counted
  assert.equal(find('place_category', 'good cafe', 'long').evidence_count, 1);
  assert.ok(a.length <= SUMMARY_MAX_CHARS);
  assert.ok(!/noise_author/.test(a.text));
  assert.equal(preferenceSummary(d).version, a.version); // Jev uses the stored summary
});

test('summary stays within 2,500 characters with a long taste file and its version follows the text', () => {
  seedHistory();
  const f = join(dir, 'taste.md');
  writeFileSync(f, 'I like quiet poetry nights. '.repeat(400));
  process.env.PHROG_TASTE_FILE = f;
  try {
    const d = personalDb();
    const a = rebuildPreferences(d, '2026-10-26T00:00:00Z');
    assert.ok(a.length <= SUMMARY_MAX_CHARS);
    assert.match(a.text, /poetry/);
    writeFileSync(f, 'Now I only want loud gigs.');
    const b = rebuildPreferences(d, '2026-10-26T00:00:00Z');
    assert.notEqual(a.version, b.version);
  } finally { delete process.env.PHROG_TASTE_FILE; }
});

// ---------- discover ----------
test('discover returns ranked items, parses dates, records run and deliveries', async () => {
  const f = fakes({ failEventbriteWriting: true });
  const r = await personalDiscover({ limit: 10, client: 'test' }, f.deps);
  assert.equal(r.schema_version, 'discover.v1');
  assert.equal(r.status, 'partial');
  assert.ok(r.failed_sources.some((x) => x.source === 'eventbrite' && x.step === 'search' && /searxng down/.test(x.error)));
  assert.deepEqual(r.items.map((i) => i.title), ['Great Film Night', 'Great Jazz Night', 'Boring Seminar', 'No Date Event']);
  assert.deepEqual(r.items.map((i) => i.rank), [1, 2, 3, 4]);
  const film = r.items[0];
  assert.equal(film.starts_at, '2026-10-29T08:00:00.000Z'); // 7pm AEDT
  assert.equal(film.time_precision, 'minute');
  assert.equal(film.venue, 'The Backlot, 1 Main St, Fitzroy VIC 3065');
  assert.equal(film.price.free, true);
  assert.equal(r.items[1].starts_at, '2026-10-31T09:00:00.000Z'); // date from the Eventbrite page title
  const none = r.items[3];
  assert.equal(none.starts_at, null);
  assert.equal(none.time_precision, 'unknown');
  assert.ok(none.uncertainty.includes('date not found on the page'));
  assert.ok(r.items.every((i) => i.reason.length > 0 && /^dlv_/.test(i.delivery_id)));
  assert.equal(r.counts.outside_window, 1); // Old Event
  assert.equal(r.counts.wrong_area, 1); // Sydney gig
  assert.ok(!r.items.some((i) => /Sydney|Old Event/.test(i.title)));
  assert.equal(r.counts.with_exact_date, 3);
  assert.ok(Math.abs(r.cost_usd - 0.004) < 1e-9);

  const d = personalDb();
  assert.equal((d.prepare('SELECT COUNT(*) n FROM deliveries').get() as any).n, 4);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM items WHERE kind = 'event'").get() as any).n, 6);
  assert.equal((d.prepare('SELECT status, ranker_version FROM discovery_runs').get() as any).status, 'partial');
  const ed = d.prepare('SELECT * FROM event_details WHERE item_id = ?').get(film.item_id) as any;
  assert.equal(ed.starts_at, film.starts_at);
  assert.equal(ed.time_precision, 'minute');
  const unknown = d.prepare("SELECT starts_at FROM event_details e JOIN items i ON i.id = e.item_id WHERE i.title = 'No Date Event'").get() as any;
  assert.equal(unknown.starts_at, null); // unknown stays null

  // A second run re-uses the stored Jev scores and does not duplicate items.
  const f2 = fakes();
  const r2 = await personalDiscover({ limit: 10, client: 'test' }, f2.deps);
  assert.equal(f2.calls.score.length, 0);
  assert.equal(r2.counts.jev_cached, 4);
  assert.equal((d.prepare("SELECT COUNT(*) n FROM items WHERE kind = 'event'").get() as any).n, 6);
});

test('discover is bounded: page cap and Jev call cap', async () => {
  process.env.PHROG_DISCOVER_MAX_PAGES = '2';
  process.env.PHROG_DISCOVER_MAX_JEV = '1';
  const f = fakes();
  const r = await personalDiscover({ limit: 10 }, f.deps);
  assert.equal(f.calls.fetch.length, 2);
  assert.ok(f.calls.score.length <= 1);
  assert.ok(r.items.some((i) => i.uncertainty.includes('not scored by Jev (budget or error)')) || r.items.length <= 1);
  const bad = personalDiscover({ constraints: { days: 500 } }, f.deps);
  await assert.rejects(bad, FeedInputError);
});

test('exclude rule is honoured and changes the next run', async () => {
  const f = fakes();
  const before = await personalDiscover({}, f.deps);
  assert.ok(before.items.some((i) => /Jazz/.test(i.title)));
  const set: any = personalPreferences({ action: 'set_rule', rule: 'exclude', subject_key: 'Jazz' });
  assert.equal(set.rule.subject_key, 'jazz');
  const after = await personalDiscover({}, fakes().deps);
  assert.ok(!after.items.some((i) => /Jazz/.test(i.title)));
  assert.equal(after.counts.excluded, 1);
  assert.notEqual(after.preference_summary_version, before.preference_summary_version); // Jev cache follows the tastes
  const again: any = personalPreferences({ action: 'set_rule', rule: 'exclude', subject_key: 'jazz' });
  assert.equal(again.rule.duplicate, true);
  personalPreferences({ action: 'remove_rule', rule_id: set.rule.id });
  assert.ok((await personalDiscover({}, fakes().deps)).items.some((i) => /Jazz/.test(i.title)));
});

// ---------- feedback ----------
test('this_time feedback is not a lasting dislike; item dislike is', async () => {
  const r = await personalDiscover({}, fakes().deps);
  const seminar = r.items.find((i) => i.title === 'Boring Seminar')!;
  const v0 = personalPreferences({ action: 'rebuild' }) as any;

  const tooFar = recordFeedback({ delivery_id: seminar.delivery_id, type: 'too_far' });
  assert.equal(tooFar.scope, 'this_time');
  assert.equal(tooFar.effect, 'this_time_only');
  recordFeedback({ delivery_id: seminar.delivery_id, type: 'dislike', scope: 'this_time', reason: 'not tonight' });
  recordFeedback({ item_id: seminar.item_id, type: 'too_expensive' });
  const v1 = personalPreferences({ action: 'rebuild' }) as any;
  assert.equal(v1.version, v0.version);
  assert.equal((personalDb().prepare("SELECT COUNT(*) n FROM preferences WHERE subject_type LIKE 'fb_%'").get() as any).n, 0);
  assert.ok((await personalDiscover({}, fakes().deps)).items.some((i) => i.title === 'Boring Seminar'));

  const lasting = recordFeedback({ delivery_id: seminar.delivery_id, type: 'dislike', scope: 'item' });
  assert.equal(lasting.effect, 'lasting');
  const after = await personalDiscover({}, fakes().deps);
  assert.ok(!after.items.some((i) => i.title === 'Boring Seminar'));
  const prefs = personalPreferences({ action: 'get' }) as any;
  assert.match(prefs.summary.text, /no to: .*boring seminar/);

  // Positive owner feedback adds evidence.
  const film = r.items.find((i) => i.title === 'Great Film Night')!;
  recordFeedback({ item_id: film.item_id, type: 'want_to_go' });
  const v2 = personalPreferences({ action: 'rebuild' }) as any;
  assert.ok(v2.counts.fb_item);
  assert.match((personalPreferences({ action: 'get' }) as any).summary.text, /yes to: .*great film night/);
});

test('feedback is idempotent and validated', async () => {
  const r = await personalDiscover({}, fakes().deps);
  const it = r.items[0];
  const a = recordFeedback({ item_id: it.item_id, type: 'like', idempotency_key: 'k-1' });
  const b = recordFeedback({ item_id: it.item_id, type: 'like', idempotency_key: 'k-1' });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  assert.equal((personalDb().prepare('SELECT COUNT(*) n FROM feedback').get() as any).n, 1);
  assert.throws(() => recordFeedback({ item_id: r.items[1].item_id, type: 'like', idempotency_key: 'k-1' }), FeedInputError);
  assert.throws(() => recordFeedback({ item_id: it.item_id, type: 'love' }), FeedInputError);
  assert.throws(() => recordFeedback({ item_id: it.item_id, type: 'dislike', scope: 'topic' }), /reason/);
  assert.throws(() => recordFeedback({ type: 'like' }), FeedInputError);
  assert.throws(() => recordFeedback({ item_id: 'it_00000000-0000-0000-0000-000000000000', type: 'like' }), /unknown item_id/);
});

test("'shown' sets displayed_at once and is not feedback", async () => {
  const r = await personalDiscover({}, fakes().deps);
  const [a, b] = r.items;
  const d = personalDb();
  const shown = (id: string) => (d.prepare('SELECT displayed_at FROM deliveries WHERE id = ?').get(id) as any).displayed_at;
  assert.equal(shown(a.delivery_id), null); // returned is not shown
  const res = recordFeedback({ type: 'shown', delivery_ids: [a.delivery_id] }) as any;
  assert.equal(res.updated, 1);
  const first = shown(a.delivery_id);
  assert.ok(first);
  assert.equal(shown(b.delivery_id), null);
  assert.equal((recordFeedback({ type: 'shown', delivery_id: a.delivery_id }) as any).updated, 0);
  assert.equal(shown(a.delivery_id), first);
  assert.equal((d.prepare('SELECT COUNT(*) n FROM feedback').get() as any).n, 0);
  assert.throws(() => recordFeedback({ type: 'shown', delivery_id: 'dlv_00000000-0000-0000-0000-000000000000' }), /unknown delivery_id/);
});

// ---------- parsing ----------
test('parseWhen: only states what the text says', () => {
  const t = (s: string) => parseWhen(s, NOW);
  assert.equal(t('Thu, 29 Oct, 7pm - 9pm AEDT').starts_at, '2026-10-29T08:00:00.000Z');
  assert.equal(t('Saturday, May 16  •  4 PM - 5:50 PM').precision, 'minute'); // past (May 2026) but resolved by its weekday
  assert.equal(t('Sunday 8 November 2026, 6:30 pm').starts_at, '2026-11-08T07:30:00.000Z');
  assert.equal(t('8 November').precision, 'unknown'); // no year, no weekday: never guessed
  assert.equal(t('Wed 30 Oct').precision, 'unknown'); // weekday does not fit any nearby year
  const range = t('Sat, 31 Oct  •  7 - 10pm');
  assert.equal(range.precision, 'day'); // the start has no am/pm
  assert.equal(t('Date and time: Fri 30 Oct 2026 at 9:15 am').starts_at, '2026-10-29T22:15:00.000Z');
  assert.equal(parsePrice('Free entry for all').min, 0);
  assert.deepEqual([parsePrice('Tickets $15 or $25.50').min, parsePrice('Tickets $15 or $25.50').max], [15, 25.5]);
  assert.equal(parsePrice('no prices here').min, null);
  assert.equal(parseVenue('## Location\n[Show map](x)\nThe Corner Hotel, Richmond\n'), 'The Corner Hotel, Richmond');
});

// ---------- auth ----------
test('REST: new personal routes need the owner token', async () => {
  const app = Fastify();
  registerPersonalRoutes(app);
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const [method, url] of [['POST', '/api/personal/feedback'], ['POST', '/api/personal/discover'], ['GET', '/api/personal/preferences'], ['POST', '/api/personal/preferences']] as const) {
    assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 401, `${method} ${url} without token`);
    assert.equal((await app.inject({ method, url, payload: {}, headers: { authorization: 'Bearer wrong' } })).statusCode, 401, `${method} ${url} wrong token`);
  }
  const prefs = await app.inject({ method: 'GET', url: '/api/personal/preferences', headers: auth });
  assert.equal(prefs.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/personal/feedback', payload: { type: 'like' }, headers: auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/personal/preferences', payload: { action: 'set_rule', rule: 'nope', subject_key: 'x' }, headers: auth })).statusCode, 400);
  const set = await app.inject({ method: 'POST', url: '/api/personal/preferences', payload: { action: 'set_rule', rule: 'avoid', subject_key: 'karaoke' }, headers: auth });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().rule.rule, 'avoid');
  delete process.env.PHROG_PERSONAL_TOKEN;
  assert.equal((await app.inject({ method: 'POST', url: '/api/personal/discover', payload: {}, headers: auth })).statusCode, 503);
  process.env.PHROG_PERSONAL_TOKEN = TOKEN;
  await app.close();
});

async function mcpClient(ctx: { personalAuthorized?: boolean }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

test('MCP: personal_discover, personal_feedback and personal_preferences are listed and need the owner token', async () => {
  const anon = await mcpClient({});
  const tools = (await anon.listTools()).tools.map((t) => t.name);
  for (const name of ['personal_discover', 'personal_feedback', 'personal_preferences']) {
    assert.ok(tools.includes(name), name);
    const r: any = await anon.callTool({ name, arguments: name === 'personal_feedback' ? { type: 'like' } : {} });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /auth_required/);
  }
  const authed = await mcpClient({ personalAuthorized: true });
  const p: any = await authed.callTool({ name: 'personal_preferences', arguments: { action: 'set_rule', rule: 'prefer', subject_key: 'poetry' } });
  assert.notEqual(p.isError, true);
  assert.equal(JSON.parse(p.content[0].text).rule.rule, 'prefer');
  const bad: any = await authed.callTool({ name: 'personal_feedback', arguments: { type: 'like' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /item_id or delivery_id/);
});

test('a generic intent never replaces the owner categories; a topic is searched first', async () => {
  const seen: string[] = [];
  const f = fakes();
  const base = f.deps.search;
  const deps = { ...f.deps, search: (async (q: string, o: any) => { seen.push(q); return base(q, o); }) as any };
  await personalDiscover({ intent: 'Melbourne events next 14 days for the owner', limit: 3, client: 'test' }, deps);
  assert.ok(seen.some((q) => q.includes('writing group')) && seen.some((q) => q.includes('film screening')));
  assert.ok(!seen.some((q) => q.includes('for the owner')));
  seen.length = 0;
  await personalDiscover({ limit: 3, client: 'test', constraints: { topic: 'jazz' } }, deps);
  assert.ok(seen[0].includes('jazz'));
});
