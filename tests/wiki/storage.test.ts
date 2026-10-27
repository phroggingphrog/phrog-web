import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveToWiki, searchWiki } from '../../src/wiki/vault.js';

test('custom inbox and library index store and immediately find a note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phrog-wiki-'));
  process.env.WIKI_DIR = join(root, 'root');
  process.env.WIKI_INBOX_DIR = join(root, 'inbox');
  process.env.WIKI_INDEX_PATH = join(root, 'library', 'index.db');
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  try {
    const note = await saveToWiki('Quartz astronomy', 'Quartz astronomy telescope', { source: 'https://example.org' });
    assert.equal(note.path, join(root, 'inbox', 'quartz-astronomy.md'));
    assert.ok(existsSync(note.path));
    assert.ok(existsSync(process.env.WIKI_INDEX_PATH));
    const results = await searchWiki('quartz astronomy');
    assert.equal(results[0]?.id, 'quartz-astronomy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
