import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { keyStatus, setKey, removeKey, PROVIDER_KEYS, envFilePath } from '../../src/provider-keys.js';

function tmpEnv(content = '') {
  const dir = mkdtempSync(resolve(tmpdir(), 'phrog-keys-'));
  const file = resolve(dir, 'phrog-web.env');
  writeFileSync(file, content);
  return file;
}

test('keyStatus reports configured state and length but never the value', () => {
  const file = tmpEnv('TINYFISH_API_KEY_2=short-key\nFIRECRAWL_API_KEY=\n');
  const keys = keyStatus(file);
  const free = keys.find((k) => k.key === 'TINYFISH_API_KEY_2')!;
  const fc = keys.find((k) => k.key === 'FIRECRAWL_API_KEY')!;
  assert.equal(free.configured, true);
  assert.equal(free.length, 'short-key'.length);
  assert.equal(free.source, 'env-file');
  assert.equal(free.plan, 'free');
  assert.equal(fc.configured, false);
  // the serialised form must not carry any secret
  assert.doesNotMatch(JSON.stringify(keys), /short-key/);
});

test('the registry marks TinyFish plans so free-vs-paid is explicit', () => {
  const plans = PROVIDER_KEYS.filter((k) => k.provider === 'tinyfish').map((k) => k.plan);
  assert.deepEqual(plans.sort(), ['free', 'paid']);
});

test('setKey appends a new key, preserves other lines, and hot-reloads process.env', () => {
  const file = tmpEnv('# comment\nOTHER=keep-me\n');
  const status = setKey('TMDB_API_KEY', 'abc123', file);
  assert.equal(status.configured, true);
  assert.equal(status.length, 6);
  assert.equal(process.env.TMDB_API_KEY, 'abc123');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# comment/);
  assert.match(text, /OTHER=keep-me/);
  assert.match(text, /TMDB_API_KEY=abc123/);
  delete process.env.TMDB_API_KEY;
});

test('setKey replaces an existing key instead of duplicating it', () => {
  const file = tmpEnv('TMDB_API_KEY=old\nOTHER=keep\n');
  setKey('TMDB_API_KEY', 'new', file);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.match(/TMDB_API_KEY=/g)?.length, 1);
  assert.match(text, /TMDB_API_KEY=new/);
  assert.match(text, /OTHER=keep/);
  delete process.env.TMDB_API_KEY;
});

test('setKey refuses unknown keys, empty values and values with whitespace', () => {
  const file = tmpEnv('');
  assert.throws(() => setKey('NOT_A_REAL_KEY', 'x', file), /unknown key/);
  assert.throws(() => setKey('TMDB_API_KEY', '   ', file), /must not be empty/);
  assert.throws(() => setKey('TMDB_API_KEY', 'has space', file), /whitespace/);
});

test('removeKey drops the line and clears process.env', () => {
  const file = tmpEnv('TMDB_API_KEY=gone\nOTHER=keep\n');
  process.env.TMDB_API_KEY = 'gone';
  assert.equal(removeKey('TMDB_API_KEY', file), true);
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /TMDB_API_KEY/);
  assert.match(text, /OTHER=keep/);
  assert.equal(process.env.TMDB_API_KEY, undefined);
  assert.equal(removeKey('TMDB_API_KEY', file), false);
});

test('envFilePath honours PHROG_WEB_ENV_FILE so tests never touch the live store', () => {
  const saved = process.env.PHROG_WEB_ENV_FILE;
  process.env.PHROG_WEB_ENV_FILE = '/tmp/example.env';
  assert.equal(envFilePath(), '/tmp/example.env');
  if (saved === undefined) delete process.env.PHROG_WEB_ENV_FILE; else process.env.PHROG_WEB_ENV_FILE = saved;
});
