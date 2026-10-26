import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromePath } from '../providers/places.js';

export interface Card {
  author: string | null;
  caption: string | null;
  type: string | null;
  url: string | null;
  imageUrl: string | null;
}
export interface RenderedCard { png: Buffer; width: number; height: number }
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
<div style="padding:12px 16px;display:flex;justify-content:space-between"><b>@${esc(c.author ?? 'unknown')}</b><span style="color:#666">${esc(c.type ?? '')}</span></div>
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
        const png = Buffer.from(await el.screenshot({ type: 'png' }));
        out.push({ png, width: Math.round(box.width), height: Math.round(box.height) });
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
