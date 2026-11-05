import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { siteForUrl, writeJar, readJar, listJars, deleteJar, jarForUrl, profilesDir } from '../../src/providers/profiles.js';

function withDir() {
  const dir = mkdtempSync(resolve(tmpdir(), 'jars-'));
  const saved = process.env.PHROG_WEB_PROFILES_DIR;
  process.env.PHROG_WEB_PROFILES_DIR = dir;
  return () => { if (saved === undefined) delete process.env.PHROG_WEB_PROFILES_DIR; else process.env.PHROG_WEB_PROFILES_DIR = saved; };
}

test('siteForUrl reduces a URL to its registrable site, including two-part TLDs', () => {
  assert.equal(siteForUrl('https://docs.github.com/en/rest'), 'github.com');
  assert.equal(siteForUrl('https://www.example.co.uk/x'), 'example.co.uk');
  assert.equal(siteForUrl('https://sub.abc.com.au/'), 'abc.com.au');
  assert.equal(siteForUrl('https://localhost:8890/'), null);
  assert.equal(siteForUrl('http://192.168.0.80/'), null);
  assert.equal(siteForUrl('not a url'), null);
});

test('a jar round-trips and is written 0600', () => {
  const restore = withDir();
  try {
    const jar = writeJar('example.com', [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }]);
    assert.equal(jar.site, 'example.com');
    assert.equal(readJar('example.com')!.cookies[0].value, 'abc');
    const mode = statSync(resolve(profilesDir(), 'example.com.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { restore(); }
});

test('an empty cookie set is refused rather than saving a useless jar', () => {
  const restore = withDir();
  try {
    assert.throws(() => writeJar('empty.com', []), /no cookies found/);
  } finally { restore(); }
});

test('listJars reports cookie count and whether the jar has expired', () => {
  const restore = withDir();
  try {
    writeJar('fresh.com', [{ name: 'a', value: '1', domain: '.fresh.com', expires: Math.floor(Date.now() / 1000) + 86400 }]);
    writeJar('stale.com', [{ name: 'b', value: '2', domain: '.stale.com', expires: Math.floor(Date.now() / 1000) - 86400 }]);
    const jars = listJars();
    assert.equal(jars.length, 2);
    assert.equal(jars.find((j) => j.site === 'fresh.com')!.expired, false);
    assert.equal(jars.find((j) => j.site === 'stale.com')!.expired, true);
  } finally { restore(); }
});

test('jarForUrl only returns a jar when one is asked for', () => {
  const restore = withDir();
  try {
    writeJar('example.com', [{ name: 'sid', value: 'abc', domain: '.example.com' }]);
    assert.equal(jarForUrl('https://example.com/page', undefined), null);
    assert.equal(jarForUrl('https://example.com/page', true)!.site, 'example.com');
    assert.equal(jarForUrl('https://example.com/page', 'example.com')!.site, 'example.com');
    assert.equal(jarForUrl('https://other.com/page', true), null);
  } finally { restore(); }
});

test('deleteJar removes the file and reports whether anything was there', () => {
  const restore = withDir();
  try {
    writeJar('gone.com', [{ name: 'x', value: 'y', domain: '.gone.com' }]);
    assert.equal(deleteJar('gone.com'), true);
    assert.equal(existsSync(resolve(profilesDir(), 'gone.com.json')), false);
    assert.equal(deleteJar('gone.com'), false);
  } finally { restore(); }
});

test('a site name cannot escape the profiles directory', () => {
  const restore = withDir();
  try {
    writeJar('../../etc/passwd', [{ name: 'x', value: 'y', domain: '.x.com' }]);
    const dir = profilesDir();
    const files = readdirSync(dir);
    assert.equal(files.length, 1, 'exactly one jar file should exist');
    // Whatever the name becomes, it must resolve to a direct child of the profiles directory.
    const resolved = realpathSync(resolve(dir, files[0]));
    assert.ok(resolved.startsWith(realpathSync(dir) + '/'), `jar escaped the profiles dir: ${resolved}`);
    assert.equal(readJar('../../etc/passwd')!.cookies[0].value, 'y');
  } finally { restore(); }
});
