import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUpstreamError } from '../../src/providers/deepwiki.js';

test('the documented upstream failure is recognised as an error', () => {
  assert.equal(
    isUpstreamError('Error fetching wiki for phroggingphrog/phrog-web: Repository not found. Visit https://deepwiki.com/phroggingphrog/phrog-web to index it.'),
    true,
  );
});

test('real wiki content is not mistaken for an error', () => {
  assert.equal(isUpstreamError('# Overview\nThis repository is a web search service.'), false);
  assert.equal(isUpstreamError('## Search pipeline\nError handling lives in ...'), false);
});

test('a long essay that merely starts with the word error is not treated as a failure', () => {
  assert.equal(isUpstreamError('Errors are handled by the pipeline. ' + 'x'.repeat(500)), false);
});
