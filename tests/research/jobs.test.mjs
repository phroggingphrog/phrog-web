import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const engine = resolve('engines/feynman/bin/feynman.js');
const vault = resolve('engines/feynman/dist/vault/index.js');

test('staged jobs use registered artifacts and resume their checkpoint', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'phrog-jobs-'));
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `#!${process.execPath}\nimport { writeFile } from 'node:fs/promises';\nimport { getVaultPaths, getResearchRun, setResearchStep, setRunArtifacts } from ${JSON.stringify('file://' + vault)};\nconst id = process.argv[3].match(/durable research run id: ([^.]+)\\./)[1];\nconst paths = getVaultPaths(process.cwd());\nconst m = await getResearchRun(paths, id);\nif (m.query === 'missing artifact') process.exit(0);\nif (!process.argv[3].includes('Resume the existing run')) { await setResearchStep(paths,id,m.stepOrder[0],'done',{checkpoint:'first-checkpoint'}); process.exit(1); }\nif (m.steps[m.stepOrder[0]].checkpoint !== 'first-checkpoint') process.exit(2);\nfor (const step of m.stepOrder.slice(1)) await setResearchStep(paths,id,step,'skipped');\nawait writeFile('outputs/actual.md','CORRECT REPORT');\nawait writeFile('outputs/actual.provenance.md','CORRECT PROVENANCE');\nawait writeFile('outputs/zz-unrelated.md','WRONG REPORT');\nawait setRunArtifacts(paths,id,{report:'outputs/actual.md',provenance:'outputs/actual.provenance.md'});\n`);
  await chmod(worker, 0o700);
  const proc = spawn(process.execPath, [engine, 'mcp', '--mcp-host', '127.0.0.1', '--mcp-port', '0'], { cwd: root, env: { ...process.env, FEYNMAN_CLI: worker, FEYNMAN_HOME: root }, stdio: ['ignore','pipe','pipe'] });
  let client;
  try {
    const url = await new Promise((done, fail) => {
      let out = ''; const timer = setTimeout(() => fail(new Error('startup timeout')), 10000);
      proc.once('error', fail); proc.once('exit', code => fail(new Error(`server exited ${code}`)));
      proc.stdout.on('data', chunk => { out += chunk; const match = out.match(/listening at (http:\/\/127\.0\.0\.1:\d+\/mcp) for /); if (match) { clearTimeout(timer); done(match[1]); } });
    });
    client = new Client({ name:'job-test', version:'1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const call = async (name, args) => { const result = await client.callTool({name, arguments:args}, undefined, { timeout: 15000 }); assert.ok(!result.isError, JSON.stringify(result)); return result.content[0].text; };
    const first = await call('feynman_research', { workflow:'deepresearch', topic:'checkpoint test', tier:'light' });
    assert.match(first, /STATUS: failed/);
    const id = first.match(/RUN_ID: (.+)/)[1];
    const resumed = await call('feynman_resume', {runId:id});
    assert.match(resumed, /STATUS: done/);
    assert.match(resumed, /CORRECT REPORT/);
    assert.match(resumed, /CORRECT PROVENANCE/);
    assert.doesNotMatch(resumed, /WRONG REPORT/);
    const missing = await call('feynman_research', { workflow:'deepresearch', topic:'missing artifact', tier:'light' });
    assert.match(missing, /STATUS: failed/);
    assert.doesNotMatch(missing, /WRONG REPORT|CORRECT REPORT/);
    await rename(worker, worker + '.off');
    const failedSpawn = await client.callTool({ name:'feynman_research', arguments:{workflow:'deepresearch', topic:'spawn failure', tier:'light'} });
    assert.equal(failedSpawn.isError, true);
    assert.match(failedSpawn.content[0].text, /ENOENT/);
    await rename(worker + '.off', worker);
    const afterFailure = await call('feynman_research', {workflow:'deepresearch', topic:'missing artifact', tier:'light'});
    assert.match(afterFailure, /STATUS: failed/);
  } finally { await client?.close(); proc.kill(); await new Promise(done => proc.once('exit', done)); await rm(root,{recursive:true,force:true}); }
});
