import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { personalArtifactsDir } from '../config.js';
import { getRenderer, sniffImage, type Card } from './render.js';

export const ARTIFACT_URL_PREFIX = '/api/personal/artifacts/';
export const ARTIFACT_ID_RE = /^art_[0-9a-f-]{36}$/;

export function readArtifact(d: DatabaseSync, id: string): Buffer | null {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  const row = d.prepare('SELECT path FROM artifacts WHERE id = ?').get(id) as any;
  if (!row || !existsSync(row.path)) return null;
  return readFileSync(row.path);
}

export async function renderFeedItems(d: DatabaseSync, items: any[]) {
  const todo = items.map((item) => ({ item }));
  const findArt = d.prepare("SELECT id, path, created_at FROM artifacts WHERE item_id = ? AND kind = 'post_card' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const need: { item: any }[] = [];
  const have = new Map<{ item: any }, { id: string; created_at: string; image: Buffer }>();
  for (const s of todo) {
    const a = findArt.get(s.item.item_id) as any;
    if (a && existsSync(a.path)) have.set(s, { id: a.id, created_at: a.created_at, image: readFileSync(a.path) });
    else need.push(s);
  }
  if (need.length) {
    const cards: Card[] = need.map((s) => ({
      author: s.item.author?.handle ?? s.item.author?.name ?? null, named: !s.item.author?.handle, caption: s.item.caption, type: s.item.type, url: s.item.url,
      imageUrl: (s.item.media.find((m: any) => m?.url) ?? {}).url ?? null,
    }));
    let rendered: Awaited<ReturnType<ReturnType<typeof getRenderer>>> = [];
    try { rendered = await getRenderer()(cards); } catch { /* render stays null */ }
    mkdirSync(personalArtifactsDir(), { recursive: true, mode: 0o700 });
    const insArt = d.prepare('INSERT INTO artifacts (id, kind, item_id, path, created_at) VALUES (?, ?, ?, ?, ?)');
    need.forEach((s, i) => {
      const r = rendered[i];
      if (!r) return;
      const image = r.image ?? r.png;
      if (!image) return;
      const id = `art_${randomUUID()}`;
      const path = join(personalArtifactsDir(), `${id}.${sniffImage(image)?.ext ?? 'png'}`);
      writeFileSync(path, image, { mode: 0o600 });
      chmodSync(path, 0o600);
      const at = new Date().toISOString();
      insArt.run(id, 'post_card', s.item.item_id, path, at);
      have.set(s, { id, created_at: at, image });
    });
  }

  for (const s of todo) {
    const a = have.get(s);
    if (!a) continue;
    const size = sniffImage(a.image);
    s.item.render = { screenshot: `${ARTIFACT_URL_PREFIX}${a.id}`, width: size?.width ?? null, height: size?.height ?? null, rendered_at: a.created_at };
  }
}

export function readArtifactImage(d: DatabaseSync, id: string) {
  const data = readArtifact(d, id);
  if (!data) return null;
  const info = sniffImage(data);
  return info ? { data, mime: info.mime } : null;
}
