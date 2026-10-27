import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'phrog-feynman-test-'));
const env = { ...process.env, PHROG_FEYNMAN_DATA_DIR: root, FEYNMAN_TELEMETRY: 'off' };
function run(script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, `child failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout.trim());
}
test('embedded vault persists notes and claims across Phrog processes', async () => {
  try {
    const created = run(`import { researchVault as v } from './dist/providers/vault.js';
      const note = await v({action:'save',title:'Portable proof',body:'Evidence about a cobalt sparrow.',source:'https://example.org/proof'});
      await v({action:'add_claim',note_id:note.id,claim:'Cobalt sparrows exist',quoted_support:'Evidence about a cobalt sparrow.'});
      console.log(JSON.stringify({id:note.id}));`);
    const found = run(`import { researchVault as v } from './dist/providers/vault.js';
      const note = await v({action:'read',note_id:${JSON.stringify(created.id)}});
      const matches = await v({action:'search',query:'cobalt'});
      const claims = await v({action:'search_claims',query:'sparrows'});
      console.log(JSON.stringify({note,matches,claims}));`);
    assert.match(found.note.body, /cobalt sparrow/);
    assert.ok(found.matches.some(note => note.id === created.id));
    assert.match(JSON.stringify(found.claims), /Cobalt sparrows exist/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
