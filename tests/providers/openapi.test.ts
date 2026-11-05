import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApi, renderDocsHtml } from '../../src/openapi.js';
import { CAPABILITIES } from '../../src/capabilities.js';

const routes = [
  { method: 'GET', url: '/api/search' },
  { method: 'POST', url: '/api/research/:jobId/resume' },
  { method: 'HEAD', url: '/api/search' },
  { method: 'GET', url: '/*' },
  { method: 'DELETE', url: '/api/keys/:key' },
];
const spec = buildOpenApi(routes, CAPABILITIES);

test('every real route is documented, minus HEAD and the catch-all', () => {
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/keys/{key}', '/api/research/{jobId}/resume', '/api/search']);
  assert.equal(Object.keys(spec.paths['/api/search']).includes('head'), false);
});

test('path segments become required path parameters', () => {
  const op: any = (spec.paths['/api/research/{jobId}/resume'] as any).post;
  const param = op.parameters.find((p: any) => p.name === 'jobId');
  assert.equal(param.in, 'path');
  assert.equal(param.required, true);
});

test('a documented capability supplies the summary, provenance and cost', () => {
  const op: any = (spec.paths['/api/research/{jobId}/resume'] as any).post;
  assert.equal(op.summary, 'research_resume');
  assert.match(op.description, /feynman research run resume/);
});

test('query parameters are not invented for path or enum-style entries', () => {
  const op: any = (spec.paths['/api/search'] as any).get;
  const names = op.parameters.map((p: any) => p.name);
  assert.ok(names.includes('q'));
  assert.equal(names.includes('mode=quick|deep'), false);
});

test('the docs page is self-contained and points at the machine-readable spec', () => {
  const html = renderDocsHtml();
  assert.match(html, /\/openapi\.json/);
  assert.equal(html.includes('<script src='), false);
});
