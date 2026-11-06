import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';
import { buildToolCatalogue, CATALOGUE_URI, renderToolDomainsMarkdown, toolDocumentation } from '../../src/tool-domains.js';

test('MCP domain resource covers every actual tool exactly once with matching descriptions', async () => {
  const server = createMcpServer();
  const client = new Client({ name: 'catalogue-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const baselineTools = tools.filter(t => t.name !== 'phrogweb-feed');
    assert.equal(baselineTools.length, 51);
    const resources = await client.listResources();
    assert.ok(resources.resources.some(r => r.uri === CATALOGUE_URI));
    const result = await client.readResource({ uri: CATALOGUE_URI });
    const content = result.contents[0];
    assert.ok('text' in content);
    const catalogue = JSON.parse(content.text);
    assert.deepEqual(catalogue, server.toolCatalogue);
    const entries = catalogue.domains.flatMap((d: any) => {
      assert.ok(d.purpose && d.pick_when && d.tools.length);
      return d.tools;
    });
    assert.equal(entries.length, tools.length);
    assert.deepEqual(entries.map((t: any) => t.name).sort(), tools.map(t => t.name).sort());
    for (const entry of entries) {
      assert.equal(entry.description, tools.find(t => t.name === entry.name)?.description);
      assert.match(entry.description, /returns?/i);
    }
    const baseline = buildToolCatalogue(entries.filter((t: any) => t.name !== 'phrogweb-feed'));
    assert.equal(readFileSync(new URL('../../docs/TOOL-DOMAINS.md', import.meta.url), 'utf8'), renderToolDomainsMarkdown(baseline));
  } finally { await client.close(); await server.close(); }
});

test('catalogue rejects missing, unknown and duplicate registrations', () => {
  assert.throws(() => toolDocumentation('invented_tool'), /lacks domain documentation/);
  assert.throws(() => buildToolCatalogue([]), /mismatch/);
  assert.throws(() => buildToolCatalogue([{ name: 'feed', description: '' }, { name: 'feed', description: '' }]), /Duplicate/);
});

test('existing legacy feed alias is included only when registered', () => {
  const server = createMcpServer();
  const entries = server.toolCatalogue.domains.flatMap(d => d.tools).filter(t => t.name !== 'phrogweb-feed');
  const catalogue = buildToolCatalogue([...entries, { name: 'phrogweb-feed', description: toolDocumentation('phrogweb-feed') }]);
  assert.equal(catalogue.tool_count, 52);
  assert.deepEqual(catalogue.domains.find(d => d.id === 'feed')?.tools.map(t => t.name), ['feed', 'phrogweb-feed']);
  void server.close();
});
