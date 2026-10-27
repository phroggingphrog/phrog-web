import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedToolResult, MAX_FEED_RESULT_BYTES } from '../../src/adapters/mcp/server.js';
import { sniffImage } from '../../src/personalization/render.js';

const item = (id: string, caption = '') => ({ item_id: id, caption, filter: { passed: true }, render: { screenshot: `/api/personal/artifacts/${id}` } });
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

test('oversized screenshot is explicitly omitted under total result cap', () => {
  const result = buildFeedToolResult({ items: [item('huge')] }, () => Buffer.alloc(960_000));
  assert.ok(bytes(result) <= MAX_FEED_RESULT_BYTES);
  const metadata = JSON.parse(result.content[0].text!).mcp_output;
  assert.equal(metadata.images_attached.length, 0);
  assert.equal(metadata.images_omitted[0].reason, 'image_budget');
});

test('multiple screenshots and text share one bounded payload', () => {
  const result = buildFeedToolResult({ items: Array.from({ length: 20 }, (_, i) => item(String(i))) }, () => Buffer.alloc(90_000));
  assert.ok(bytes(result) <= MAX_FEED_RESULT_BYTES);
  assert.ok(result.content.length > 1);
  const metadata = JSON.parse(result.content[0].text!).mcp_output;
  assert.equal(metadata.images_attached.length + metadata.images_omitted.length, 20);
});

test('large text is bounded and explicitly reports dropped items', () => {
  const result = buildFeedToolResult({ items: [item('large', 'x'.repeat(900_000))] }, () => Buffer.alloc(1));
  assert.ok(bytes(result) <= MAX_FEED_RESULT_BYTES);
  assert.equal(JSON.parse(result.content[0].text!).mcp_output.items_omitted_for_size, 1);
});

test('JPEG MIME survives MCP attachment and dimensions can be read', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(sniffImage(jpeg), { mime: 'image/jpeg', ext: 'jpg', width: 30, height: 20 });
  const result = buildFeedToolResult({ items: [item('jpeg')] }, () => jpeg);
  assert.equal(result.content[1].mimeType, 'image/jpeg');
});

test('legacy PNG dimensions and MIME remain supported', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  assert.deepEqual(sniffImage(png), { mime: 'image/png', ext: 'png', width: 1, height: 1 });
  assert.equal(buildFeedToolResult({ items: [item('png')] }, () => png).content[1].mimeType, 'image/png');
});
