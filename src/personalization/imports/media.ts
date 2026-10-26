import type { DatabaseSync } from 'node:sqlite';
import { Ctx, hasTable, iso, text } from './common.js';
import { ownPostKey } from './social.js';

/**
 * Picture text (description, OCR) becomes an annotation only when the file belongs to one of the owner's own posts
 * that the social import already created. Other media files carry no post link and are counted as skipped.
 */
export function importMedia(src: DatabaseSync, ctx: Ctx) {
  const c = ctx.counts;
  const rows = src.prepare(`SELECT p.platform, p.account, p.kind, p.ts_utc, p.caption, f.sha256, t.status, t.ocr_text, t.description, t.tags, t.is_screenshot,
      p.source_file post_source_file, p.source_row post_source_row
    FROM my_posts_snapshot p
    JOIN (SELECT my_posts_source_file sf, my_posts_source_row sr, sha256, MIN(file_id) file_id FROM media_files
          WHERE my_posts_source_file IS NOT NULL GROUP BY 1, 2, 3) m ON m.sf = p.source_file AND m.sr = p.source_row
    JOIN media_files f ON f.file_id = m.file_id
    LEFT JOIN media_text t ON t.sha256 = f.sha256
    ORDER BY p.platform, p.account, p.ts_utc, f.sha256`).all() as any[];
  const find = ctx.db.prepare("SELECT item_id FROM item_ids WHERE provider = 'import:own' AND native_id = ?");
  for (const r of rows) {
    c.read++;
    if (r.status !== 'ok') { ctx.reason('excluded', `status=${r.status ?? 'none'}`); continue; }
    const at = iso(r.ts_utc);
    const itemId = at ? (find.get(ownPostKey(r.platform, r.account, r.kind, at, text(r.caption))) as any)?.item_id : null;
    if (!itemId) { ctx.reason('excluded', 'no_matching_item'); continue; }
    const prov = `media.posts_with_media:${r.post_source_file}#${r.post_source_row}`;
    const d = text(r.description);
    const o = text(r.ocr_text);
    if (!d && !o) { ctx.reason('excluded', 'no_text'); continue; }
    if (d) ctx.annotation({ itemId, type: 'caption_summary', value: { text: d, tags: text(r.tags), sha256: r.sha256 }, key: `media\x1fdesc\x1f${itemId}\x1f${r.sha256}`, prov });
    if (o) ctx.annotation({ itemId, type: 'ocr', value: { text: o, sha256: r.sha256, is_screenshot: r.is_screenshot ?? null }, key: `media\x1focr\x1f${itemId}\x1f${r.sha256}`, prov });
  }
  // Files with no post link are not rows of the view; count them so the totals reconcile.
  if (hasTable(src, 'media_text')) {
    const total = (src.prepare('SELECT COUNT(*) n FROM media_text').get() as any).n as number;
    const unlinked = Math.max(0, total - new Set(rows.map((r) => r.sha256)).size);
    c.reasons['note:media_text_without_post_link'] = unlinked;
  }
}
