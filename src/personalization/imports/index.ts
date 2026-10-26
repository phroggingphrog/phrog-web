import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Ctx, openSourceRo, sha256File, type Counts, type ImportOptions } from './common.js';
import { importSocial } from './social.js';
import { importMusic } from './music.js';
import { importActivity } from './activity.js';
import { importMedia } from './media.js';

export const SOURCES = ['social', 'music', 'activity', 'media'] as const;
export type ImportSource = (typeof SOURCES)[number];

const RUNNERS: Record<ImportSource, (src: DatabaseSync, ctx: Ctx) => void> = {
  social: importSocial, music: importMusic, activity: importActivity, media: importMedia,
};

export interface ImportResult { source: ImportSource; status: 'success' | 'failed' | 'not_configured'; error?: string; dry_run: boolean; counts: Counts }

/** Import one or more sources into the central DB. Read-only on the old DBs; one transaction per source; a dry run rolls back. */
export async function runImport(db: DatabaseSync, paths: Record<ImportSource, string | null>, which: ImportSource[], opts: ImportOptions, dryRun = false): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  // media annotations attach to items made by social, so social always runs first
  for (const source of SOURCES.filter((s) => which.includes(s))) {
    const path = paths[source];
    if (!path) { out.push({ source, status: 'not_configured', dry_run: dryRun, counts: emptyCounts() }); continue; }
    const ctx0 = new Ctx(db, source, opts);
    let src: DatabaseSync | null = null;
    try {
      src = openSourceRo(path);
      const hash = await sha256File(path);
      db.exec('BEGIN');
      const ctx = ctx0;
      db.prepare('INSERT INTO import_runs (id, source, source_db, source_file_sha256, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.runId, source, basename(path), hash, ctx.now);
      RUNNERS[source](src, ctx);
      const c = ctx.counts;
      db.prepare('UPDATE import_runs SET finished_at = ?, rows_read = ?, rows_added = ?, rows_skipped = ?, rows_rejected = ?, status = ?, detail_json = ? WHERE id = ?')
        .run(new Date().toISOString(), c.read, c.added, c.skipped + c.excluded, c.rejected, 'success', JSON.stringify({ reasons: c.reasons, added_by: c.added_by, updated: c.updated }), ctx.runId);
      db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
      out.push({ source, status: 'success', dry_run: dryRun, counts: c });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      const id = `imp_${randomUUID()}`;
      if (!dryRun) {
        db.prepare("INSERT INTO import_runs (id, source, source_db, started_at, finished_at, status, detail_json) VALUES (?, ?, ?, ?, ?, 'failed', ?)")
          .run(id, source, basename(path), ctx0.now, new Date().toISOString(), JSON.stringify({ error: (e as Error).message.slice(0, 300) }));
      }
      out.push({ source, status: 'failed', error: (e as Error).message, dry_run: dryRun, counts: ctx0.counts });
    } finally {
      src?.close();
    }
  }
  return out;
}

const emptyCounts = (): Counts => ({ read: 0, added: 0, skipped: 0, excluded: 0, rejected: 0, updated: 0, reasons: {}, added_by: {} });

export function formatImport(results: ImportResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === 'not_configured') { lines.push(`${r.source}: not configured (set PHROG_IMPORT_${r.source.toUpperCase()}_DB)`); continue; }
    if (r.status === 'failed') { lines.push(`${r.source}: FAILED ${r.error}`); continue; }
    const c = r.counts;
    lines.push(`${r.source}${r.dry_run ? ' (dry run, nothing written)' : ''}: read ${c.read}, added ${c.added}, skipped ${c.skipped}, excluded ${c.excluded}, rejected ${c.rejected}, updated ${c.updated}`);
    const by = Object.entries(c.added_by).map(([k, v]) => `${k} ${v}`).join(', ');
    if (by) lines.push(`  added: ${by}`);
    const top = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of top.slice(0, 12)) lines.push(`  ${k}: ${v}`);
    if (top.length > 12) lines.push(`  ... ${top.length - 12} more reasons`);
  }
  return lines.join('\n');
}
