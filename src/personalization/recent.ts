import { personalDb, FeedInputError } from './feed.js';

export const RECENT_MAX_HOURS = 24 * 14;

/**
 * What the owner was actually shown recently, in message order, so a later conversation can resolve "number 3" or "that post".
 * (a) deliveries with displayed_at in the window, grouped by discovery run; (b) feed items an agent decided send_to_owner.
 * Returned-but-not-displayed deliveries are not listed.
 */
export function personalRecent(req: { hours?: number } = {}, now: Date = new Date()) {
  const hours = req.hours ?? 48;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > RECENT_MAX_HOURS) throw new FeedInputError(`hours must be a number in (0, ${RECENT_MAX_HOURS}]`);
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const d = personalDb();

  const rows = d.prepare(`SELECT dl.discovery_run_id run, dl.position, dl.id delivery_id, dl.item_id, dl.displayed_at, i.title, i.canonical_url url
    FROM deliveries dl JOIN items i ON i.id = dl.item_id
    WHERE dl.displayed_at IS NOT NULL AND dl.displayed_at >= ? ORDER BY dl.displayed_at, dl.discovery_run_id, dl.position`).all(since) as any[];
  const runs: Array<{ run_id: string; displayed_at: string; items: any[] }> = [];
  for (const r of rows) {
    let g = runs.find((x) => x.run_id === r.run);
    if (!g) runs.push((g = { run_id: r.run, displayed_at: r.displayed_at, items: [] }));
    g.items.push({ number: r.position, title: r.title, url: r.url, delivery_id: r.delivery_id, item_id: r.item_id });
  }

  const sent = d.prepare(`SELECT a.item_id, a.created_at decided_at, i.canonical_url url, i.title, json_extract(i.author_json, '$.handle') handle, json_extract(i.author_json, '$.name') name
    FROM agent_decisions a JOIN items i ON i.id = a.item_id
    WHERE a.decision = 'send_to_owner' AND a.created_at >= ? ORDER BY a.created_at, a.rowid`).all(since) as any[];
  const seen = new Set<string>();
  const sent_posts = sent.filter((r) => !seen.has(r.item_id) && !!seen.add(r.item_id)).map((r) => ({
    item_id: r.item_id, url: r.url, title: r.title, author: r.handle ?? r.name ?? null, decided_at: r.decided_at,
  }));
  return { schema_version: 'recent.v1', hours, since, discovery_runs: runs, sent_posts };
}
