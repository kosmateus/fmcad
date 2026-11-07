const test = require('node:test');
const assert = require('node:assert/strict');
const { McpClient } = require('../src/client');

test('JSON script output mentioning event: is not mistaken for an SSE stream', () => {
  const value = { jsonrpc: '2.0', id: 2, result: {
    content: [{ type: 'text', text: JSON.stringify({ success: true, stdout: 'event: diagnostic\ndata: plain text\n' }) }],
  } };
  assert.deepEqual(McpClient.prototype._parse(JSON.stringify(value)), value);
});
