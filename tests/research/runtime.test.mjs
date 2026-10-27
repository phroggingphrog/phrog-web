import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('embedded engine checks its selected Node and uses it for child workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phrog-node-test-'));
  const fake = join(root, 'selected-node');
  try {
    const run = (node, script) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, PHROG_FEYNMAN_NODE: node, PHROG_FEYNMAN_DATA_DIR: root }, encoding: 'utf8', timeout: 12000,
    });
    const script = `import { embeddedFeynmanUrl } from './dist/providers/feynman-runtime.js';
      import { dispatchDeepResearch } from './dist/providers/research.js';
      for (const operation of [() => embeddedFeynmanUrl(), () => dispatchDeepResearch('test')]) {
        try { await operation(); process.exitCode = 1; } catch (e) { console.log(e.message); }
      }`;
    await writeFile(fake, '#!/bin/sh\necho v22.20.0\n');
    await chmod(fake, 0o700);
    let result = run(fake, script);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/requires Node.js >=22\.22\.0/g) || []).length, 2);
    assert.match(result.stdout, /v22\.20\.0 is unsupported/);
    result = run(join(root, 'missing'), script);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cannot check PHROG_FEYNMAN_NODE/);

    await writeFile(fake, '#!/bin/sh\nexec sleep 10\n');
    result = run(fake, `import { feynmanRuntime } from './dist/providers/feynman-runtime.js';
      try { feynmanRuntime(); process.exitCode = 1; } catch (e) { console.log(e.message); }`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cannot check PHROG_FEYNMAN_NODE.*ETIMEDOUT/);

    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.22.0; else printf "%s\\n" "$@"; fi\n');
    result = run(fake, `import { feynmanRuntime } from './dist/providers/feynman-runtime.js';
      import { spawnSync } from 'node:child_process';
      const r = feynmanRuntime();
      const child = spawnSync(r.env.FEYNMAN_CLI, ['deepresearch', 'hello world'], {env:r.env, encoding:'utf8'});
      console.log(JSON.stringify({node:r.node, engine:r.engine, status:child.status, output:child.stdout}));`);
    assert.equal(result.status, 0, result.stderr);
    const selected = JSON.parse(result.stdout);
    assert.equal(selected.node, fake);
    assert.equal(selected.status, 0);
    assert.equal(selected.output, `${selected.engine}\ndeepresearch\nhello world\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
