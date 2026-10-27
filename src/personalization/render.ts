import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromePath } from '../providers/places.js';

export interface Card {
  author: string | null;
  /** author is a display name, not a handle (no @ prefix) */
  named?: boolean;
  caption: string | null;
  type: string | null;
  url: string | null;
  imageUrl: string | null;
}
/**
 * `image` is the encoded screenshot (JPEG by default). `png` is the legacy field name, still accepted
 * (renderers/tests that supply PNG bytes); format is always sniffed from the bytes.
 */
export interface RenderedCard { image?: Buffer; png?: Buffer; width: number; height: number }

/** JPEG quality for card screenshots; keeps normal cards well under transport event caps. */
export const CARD_JPEG_QUALITY = 65;

export interface ImageInfo { mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png'; width: number; height: number }

/** Identify PNG/JPEG bytes and read pixel dimensions from the header. Returns null for anything else. */
export function sniffImage(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: 'image/jpeg', ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}
/** Renders cards in order; an entry is null when that card failed. Replaceable in tests. */
export type CardRenderer = (cards: Card[]) => Promise<(RenderedCard | null)[]>;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUPPETEER = resolve(REPO_ROOT, 'engines/secondhand-mcp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js');
const WIDTH = 640;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? esc(u) : null);

export function cardHtml(c: Card): string {
  const img = safeUrl(c.imageUrl);
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font:15px/1.4 system-ui,sans-serif;color:#111">
<div id="card" style="width:${WIDTH}px;box-sizing:border-box">
<div style="padding:12px 16px;display:flex;justify-content:space-between"><b>${c.named ? '' : '@'}${esc(c.author ?? 'unknown')}</b><span style="color:#666">${esc(c.type ?? '')}</span></div>
${img ? `<img src="${img}" referrerpolicy="no-referrer" style="display:block;width:${WIDTH}px;max-height:800px;object-fit:contain;background:#eee">` : ''}
<div style="padding:12px 16px;white-space:pre-wrap;word-break:break-word">${esc((c.caption ?? '').slice(0, 1200))}</div>
<div style="padding:0 16px 12px;color:#666;font-size:12px">${esc(c.url ?? '')}</div></div>`;
}

export const puppeteerRenderer: CardRenderer = async (cards) => {
  if (!existsSync(PUPPETEER)) throw new Error('puppeteer-core not installed (run `npm install` in engines/secondhand-mcp)');
  const { default: puppeteer } = await import(pathToFileURL(PUPPETEER).href);
  const browser = await puppeteer.launch({ executablePath: chromePath(), args: ['--no-sandbox'], headless: true });
  try {
    const out: (RenderedCard | null)[] = [];
    for (const c of cards) {
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: WIDTH, height: 800 });
        await page.setContent(cardHtml(c), { waitUntil: 'load', timeout: 20000 });
        const el = await page.$('#card');
        const box = await el.boundingBox();
        const image = Buffer.from(await el.screenshot({ type: 'jpeg', quality: CARD_JPEG_QUALITY }));
        out.push({ image, width: Math.round(box.width), height: Math.round(box.height) });
        await page.close();
      } catch { out.push(null); }
    }
    return out;
  } finally {
    await browser.close();
  }
};

let renderer: CardRenderer = puppeteerRenderer;
export const getRenderer = () => renderer;
/** Test hook: replace the renderer, or pass null to restore the browser one. */
export function setCardRenderer(r: CardRenderer | null) { renderer = r ?? puppeteerRenderer; }
