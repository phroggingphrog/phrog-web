import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ImportOptions {
  accountMap: Map<string, string>;
  learnActions: Set<string>;
}

export interface Counts {
  read: number;
  added: number;
  skipped: number; // already imported (same dedupe key / state)
  excluded: number; // out of scope by policy
  rejected: number; // unusable rows
  updated: number; // current-state rows whose state changed
  reasons: Record<string, number>;
  added_by: Record<string, number>;
}

export const newCounts = (): Counts => ({ read: 0, added: 0, skipped: 0, excluded: 0, rejected: 0, updated: 0, reasons: {}, added_by: {} });

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const slug = (s: unknown) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
export const text = str;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// Databases that are mirrors or derived, never imported.
const MIRROR_TABLES = ['profile_items', 'top_artists', 'closeness'];
export function openSourceRo(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`source database not found: ${basename(path)}`);
  const name = basename(path).toLowerCase();
  if (/(^|\/)serve\//.test(path.replace(/\\/g, '/')) || name.startsWith('personal')) {
    throw new Error(`refusing ${basename(path)}: serve/personal is a mirror, not a source`);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name));
  if (MIRROR_TABLES.some((t) => tables.has(t))) {
    db.close();
    throw new Error(`refusing ${basename(path)}: looks like a mirror (has derived tables)`);
  }
  return db;
}

/** Shared state for one importer run (one source, one transaction). */
export class Ctx {
  readonly now = new Date().toISOString();
  readonly runId = `imp_${randomUUID()}`;
  readonly counts = newCounts();
  private accounts = new Map<string, string>();
  private itemCache = new Map<string, string>();
  private occ = new Map<string, number>();
  private st: Record<string, ReturnType<DatabaseSync['prepare']>> = {};

  constructor(readonly db: DatabaseSync, readonly source: string, readonly opts: ImportOptions) {}

  private q(sql: string) { return (this.st[sql] ??= this.db.prepare(sql)); }

  reason(kind: 'excluded' | 'rejected' | 'skipped', why: string) {
    this.counts[kind]++;
    this.counts.reasons[`${kind}:${why}`] = (this.counts.reasons[`${kind}:${why}`] ?? 0) + 1;
  }

  /** Index of an identical repeated row within this source file, so genuine repeats get distinct keys. */
  occurrence(base: string): number {
    const n = this.occ.get(base) ?? 0;
    this.occ.set(base, n + 1);
    return n;
  }

  account(provider: string, label: string): string {
    const k = `${provider}\0${label}`;
    let id = this.accounts.get(k);
    if (id) return id;
    const handle = this.opts.accountMap.get(`${provider}:${label}`) ?? label;
    this.db.prepare('INSERT OR IGNORE INTO source_accounts (id, provider, handle, label) VALUES (?, ?, ?, ?)').run(`acc_${randomUUID()}`, provider, handle, label);
    id = (this.db.prepare('SELECT id FROM source_accounts WHERE provider = ? AND handle = ?').get(provider, handle) as any).id as string;
    this.accounts.set(k, id);
    return id;
  }

  /** Find an item by any of its ids (or canonical URL); create it if missing and attach all ids. */
  item(a: {
    ids: Array<[string, string]>; kind: string; title?: string | null; description?: string | null; url?: string | null;
    creatorId?: string | null; durationMs?: number | null; publishedAt?: string | null; author?: unknown; location?: unknown;
  }): string {
    let id: string | undefined;
    for (const [p, n] of a.ids) {
      id = this.itemCache.get(`${p}\0${n}`);
      if (!id) id = (this.q('SELECT item_id FROM item_ids WHERE provider = ? AND native_id = ?').get(p, n) as any)?.item_id;
      if (id) break;
    }
    const url = a.url ? a.url.replace(/[?#].*$/, '') : null;
    if (!id && url) {
      const alt = url.endsWith('/') ? url.slice(0, -1) : `${url}/`;
      id = (this.q('SELECT id FROM items WHERE canonical_url = ? OR canonical_url = ? LIMIT 1').get(url, alt) as any)?.id;
    }
    if (!id) {
      id = `it_${randomUUID()}`;
      this.q(`INSERT INTO items (id, kind, title, description, canonical_url, creator_item_id, published_at, published_precision, duration_ms,
        author_json, location_json, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, a.kind, a.title ?? null, a.description ?? null, url, a.creatorId ?? null, a.publishedAt ?? null, a.publishedAt ? 'exact' : 'unknown',
          a.durationMs ?? null, a.author ? JSON.stringify(a.author) : null, a.location ? JSON.stringify(a.location) : null, this.now, this.now);
    }
    for (const [p, n] of a.ids) {
      const k = `${p}\0${n}`;
      if (this.itemCache.get(k) === id) continue;
      this.q('INSERT OR IGNORE INTO item_ids (item_id, provider, native_id) VALUES (?, ?, ?)').run(id, p, n);
      this.itemCache.set(k, id);
    }
    return id;
  }

  creator(provider: string, handle: string): string {
    return this.item({ ids: [[`${provider}_user`, slug(handle)]], kind: 'creator', title: handle });
  }

  /** Insert one observation. Returns true when new; a repeated dedupe key counts as skipped. */
  obs(o: {
    accountId: string; itemId: string; action: string; occurredAt: string; precision?: string; key: string; table: string; rowKey?: string;
    learn?: boolean; durationMs?: number | null; detail?: unknown; sponsored?: boolean;
  }): boolean {
    const learn = o.learn ?? this.opts.learnActions.has(o.action);
    const r = this.q(`INSERT OR IGNORE INTO observations (source_account_id, item_id, action, sponsored, occurred_at, time_precision, purpose, learn,
      dedupe_key, duration_ms, detail_json, source_db, source_table, source_row_key, import_run_id) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.accountId, o.itemId, o.action, o.sponsored ? 1 : null, o.occurredAt, o.precision ?? 'exact', learn ? 1 : 0, `imp1:${sha(o.key)}`,
        o.durationMs ?? null, o.detail ? JSON.stringify(o.detail) : null, this.source, o.table, o.rowKey ?? null, this.runId);
    if (Number(r.changes) === 1) { this.added('observations'); return true; }
    this.reason('skipped', 'already_imported');
    return false;
  }

  /** Current-state row (follow, save, library, favourite). Never deleted by a later import. */
  state(s: { accountId: string; itemId?: string | null; counterparty?: string | null; relation: string; state: string; effectiveAt: string | null; prov: string }) {
    const key = `imp1:${sha([s.accountId, s.relation, s.itemId ?? '', s.counterparty ?? ''].join('\x1f'))}`;
    const cur = this.q('SELECT id, state, last_observed_at, effective_at FROM entity_state WHERE state_key = ?').get(key) as any;
    if (!cur) {
      const at = s.effectiveAt ?? this.now;
      this.q(`INSERT INTO entity_state (state_key, source_account_id, item_id, counterparty, relation, state, first_observed_at, last_observed_at,
        effective_at, import_run_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, s.accountId, s.itemId ?? null, s.counterparty ?? null, s.relation, s.state, at, at, s.effectiveAt, this.runId, s.prov);
      this.added('entity_state');
      return;
    }
    if (s.effectiveAt && s.effectiveAt > cur.last_observed_at && s.state !== cur.state) {
      this.q('UPDATE entity_state SET state = ?, last_observed_at = ?, effective_at = ?, import_run_id = ?, provenance = ? WHERE id = ?')
        .run(s.state, s.effectiveAt, s.effectiveAt, this.runId, s.prov, cur.id);
      this.counts.updated++;
      return;
    }
    this.reason('skipped', 'state_unchanged');
  }

  annotation(a: { itemId: string; type: string; value: unknown; key: string; model?: string | null; createdAt?: string | null; prov: string }) {
    const r = this.q(`INSERT OR IGNORE INTO annotations (item_id, type, value_json, model_version, created_at, dedupe_key, import_run_id, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.itemId, a.type, JSON.stringify(a.value), a.model ?? null, a.createdAt ?? this.now, `imp1:${sha(a.key)}`, this.runId, a.prov);
    if (Number(r.changes) === 1) this.added('annotations'); else this.reason('skipped', 'already_imported');
  }

  private added(what: string) {
    this.counts.added++;
    this.counts.added_by[what] = (this.counts.added_by[what] ?? 0) + 1;
  }
}

/** Stable item id from a post/video URL. Instagram and TikTok ids match the live feed's native ids (shortcode / numeric id). */
export function nativeFromUrl(provider: string, url: string): { native: string; kind: string } {
  let m: RegExpMatchArray | null;
  if (provider === 'instagram') {
    if ((m = url.match(/instagram\.com\/(?:[^/?#]+\/)?(p|reel|reels|tv)\/([^/?#]+)/))) return { native: m[2], kind: m[1] === 'p' ? 'post' : 'video' };
    if ((m = url.match(/instagram\.com\/stories\/([^/?#]+)\/(\d+)/))) return { native: `story:${m[1]}:${m[2]}`, kind: 'story' };
  } else if (provider === 'tiktok') {
    if ((m = url.match(/\/video\/(\d+)/))) return { native: m[1], kind: 'video' };
  } else if (provider === 'youtube') {
    if ((m = url.match(/[?&]v=([\w-]{6,})/)) || (m = url.match(/youtu\.be\/([\w-]{6,})/))) return { native: m[1], kind: 'video' };
  }
  return { native: `url:${url.replace(/[?#].*$/, '')}`, kind: 'post' };
}

export const iso = (v: unknown): string | null => {
  const s = text(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

export const hasTable = (db: DatabaseSync, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
