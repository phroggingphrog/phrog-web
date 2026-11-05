import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnySearch, parseExaText, parseFirecrawl, parseWikimedia } from '../../src/providers/free-engines.js';

test('parseExaText reads the repeated Title/URL/Highlights blocks', () => {
  const text = [
    'Title: NAME ¶',
    'URL: https://docs.podman.io/en/latest/markdown/podman-quadlet.1.html',
    'Published: N/A',
    'Author: N/A',
    'Highlights:',
    '# NAME ¶',
    '',
    'podman-quadlet - Allows users to manage Quadlets',
    'Title: Make systemd better for Podman with Quadlet',
    'URL: https://www.redhat.com/en/blog/quadlet-podman',
    'Published: 2023-05-01',
    'Author: Red Hat',
    'Highlights:',
    'Quadlet is a tool for running Podman containers under systemd.',
  ].join('\n');
  const rows = parseExaText(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://docs.podman.io/en/latest/markdown/podman-quadlet.1.html');
  assert.equal(rows[0].title, 'NAME ¶');
  assert.match(rows[0].snippet, /Allows users to manage Quadlets/);
  assert.equal(rows[1].engine, 'exa');
  assert.match(rows[1].snippet, /^Quadlet is a tool/);
});

test('parseExaText skips blocks without a URL and collapses whitespace', () => {
  const rows = parseExaText('Title: no url here\nHighlights:\nstuff\nTitle: Real\nURL: https://example.com/a\nHighlights:\n  spaced   out\n  text ');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.com/a');
  assert.equal(rows[0].snippet, 'spaced out text');
});

test('parseExaText returns nothing for an unchanged empty payload', () => {
  assert.deepEqual(parseExaText(''), []);
});

test('parseAnySearch maps the envelope and drops rows without a url', () => {
  const rows = parseAnySearch({ data: { results: [
    { title: 'Quadlet', url: 'https://www.redhat.com/en/blog/quadlet-podman', snippet: 'Quadlet is  a\n tool' },
    { title: 'no url', snippet: 'dropped' },
    { url: 'https://docs.podman.io/', description: 'description fallback' },
  ] } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].snippet, 'Quadlet is a tool');
  assert.equal(rows[1].title, 'https://docs.podman.io/');
  assert.equal(rows[1].snippet, 'description fallback');
  assert.equal(rows[0].engine, 'anysearch');
});

test('parseAnySearch tolerates a malformed or empty payload', () => {
  assert.deepEqual(parseAnySearch({}), []);
  assert.deepEqual(parseAnySearch({ data: {} }), []);
});

test('parseFirecrawl maps the envelope and strips the extraction markers', () => {
  const rows = parseFirecrawl({ success: true, data: [
    { url: 'https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html', title: 'podman-systemd.unit',
      description: '# DESCRIPTION [¶](https://x/#description)\nall users sessions execute the Quadlet' },
    { title: 'no url' },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, 'firecrawl');
  assert.doesNotMatch(rows[0].snippet, /¶|\[/);
  assert.match(rows[0].snippet, /^# DESCRIPTION/);
});

test('parseFirecrawl tolerates a failed envelope', () => {
  assert.deepEqual(parseFirecrawl({ success: false }), []);
  assert.deepEqual(parseFirecrawl({}), []);
});

test('parseWikimedia builds article URLs and strips HTML from snippets', () => {
  const rows = parseWikimedia({ query: { search: [
    { title: 'Podman', snippet: '<span class="searchmatch">Podman</span> is a container engine' },
    { title: 'Container Linux' },
  ] } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://en.wikipedia.org/wiki/Podman');
  assert.equal(rows[0].snippet, 'Podman is a container engine');
  assert.equal(rows[1].url, 'https://en.wikipedia.org/wiki/Container_Linux');
  assert.equal(rows[1].engine, 'wikimedia');
});

test('parseWikimedia tolerates an empty query block', () => {
  assert.deepEqual(parseWikimedia({}), []);
  assert.deepEqual(parseWikimedia({ query: {} }), []);
});
