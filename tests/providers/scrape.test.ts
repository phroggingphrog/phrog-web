import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, scrape, shotsDir, SCRAPE_FORMATS } from '../../src/providers/scrape.js';

const html = `
<html><body>
  <a href="https://example.com/a">First</a>
  <a href="/relative/b">  Second   link </a>
  <a href='https://example.com/c#frag'>Third</a>
  <a href="https://example.com/a">Duplicate</a>
  <a href="javascript:void(0)">JS</a>
  <a href="mailto:x@y.com">Mail</a>
  <a href="#anchor">Anchor</a>
  <a href="data:text/plain,hi">Data</a>
  <a>No href</a>
</body></html>`;

test('extractLinks resolves relative URLs and drops non-http schemes', () => {
  const links = extractLinks(html, 'https://example.com/root/page');
  const hrefs = links.map((l) => l.href);
  assert.deepEqual(hrefs, [
    'https://example.com/a',
    'https://example.com/relative/b',
    'https://example.com/c',
  ]);
});

test('extractLinks keeps visible text and trims it', () => {
  const links = extractLinks(html, 'https://example.com/');
  assert.equal(links[0].text, 'First');
  assert.equal(links[1].text, 'Second link');
});

test('extractLinks dedupes by URL and strips fragments', () => {
  const links = extractLinks(html, 'https://example.com/');
  assert.equal(links.filter((l) => l.href === 'https://example.com/a').length, 1);
  assert.equal(links.filter((l) => l.href === 'https://example.com/c').length, 1);
});

test('scrape refuses an unknown format instead of silently ignoring it', async () => {
  await assert.rejects(
    () => scrape({ url: 'https://example.com/', formats: ['nonsense' as never] }),
    /formats must be non-empty/,
  );
});

test('scrape requires a url', async () => {
  await assert.rejects(() => scrape({}), /url is required/);
});

test('the advertised format list is the one the route validates against', () => {
  assert.deepEqual(SCRAPE_FORMATS, ['markdown', 'html', 'rawHtml', 'links', 'screenshot', 'json']);
});

test('shotsDir honours PHROG_WEB_SHOTS_DIR so tests never write to the live directory', () => {
  const saved = process.env.PHROG_WEB_SHOTS_DIR;
  process.env.PHROG_WEB_SHOTS_DIR = '/tmp/shots-fixture';
  assert.equal(shotsDir(), '/tmp/shots-fixture');
  if (saved === undefined) delete process.env.PHROG_WEB_SHOTS_DIR; else process.env.PHROG_WEB_SHOTS_DIR = saved;
});
