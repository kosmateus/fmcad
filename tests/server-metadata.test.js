const test = require('node:test');
const assert = require('node:assert/strict');
const { McpClient } = require('../src/client');
const { AddinClient } = require('../src/addin-client');
const { main } = require('../src/cli');

const cfg = { backend: 'mcp', url: 'https://host/mcp', tool: 'execute', timeoutMs: 1000,
  headers: { Authorization: 'Bearer private-token' } };
const metadata = { serverInfo: { name: 'fixture-backend', version: 'fixture-version',
  sessionId: 'private-session', credentials: 'private-token' }, protocolVersion: '2025-06-18' };

function fakePost(client, result, sse = false) {
  const calls = [];
  client._post = async (payload, sessionId) => {
    calls.push([payload.method, sessionId]);
    const raw = JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: payload.method === 'initialize' ? { protocolVersion: '2024-11-05', ...result } : { tools: [{ name: 'fixture-tool' }] } });
    return { status: 200, sessionId: 'private-session', raw: sse ? `event: message\ndata: ${raw}\n\n` : raw };
  };
  return calls;
}

for (const Client of [McpClient, AddinClient]) test(`${Client.name} parses initialize metadata without extra requests`, async () => {
  const client = new Client(cfg);
  const calls = fakePost(client, metadata, Client === AddinClient);
  assert.deepEqual(await client.listTools(), [{ name: 'fixture-tool' }]);
  assert.deepEqual(client.serverInfo, { name: 'fixture-backend', version: 'fixture-version' });
  assert.equal(client.negotiatedProtocolVersion, '2025-06-18');
  assert.deepEqual(calls, [['initialize', undefined], ['notifications/initialized', 'private-session'], ['tools/list', 'private-session']]);
});

test('initialization clears previous metadata and retains only nonempty strings', async () => {
  const client = new McpClient(cfg);
  for (const result of [metadata, {}, { serverInfo: { name: 123, version: ' ' } },
    { serverInfo: { name: 'partial', version: null } }]) {
    fakePost(client, result);
    await client._openSession();
    assert.deepEqual(client.serverInfo, result === metadata ? { name: 'fixture-backend', version: 'fixture-version' }
      : result.serverInfo?.name === 'partial' ? { name: 'partial' } : undefined);
    assert.equal(client.negotiatedProtocolVersion, result === metadata ? '2025-06-18' : '2024-11-05');
  }
});

for (const failure of ['http', 'rpc', 'parse', 'transport']) test(`failed ${failure} initialization clears metadata before request`, async () => {
  const client = new McpClient(cfg);
  fakePost(client, metadata);
  await client._openSession();
  client._post = async () => {
    assert.equal(client.serverInfo, undefined);
    assert.equal(client.negotiatedProtocolVersion, undefined);
    if (failure === 'transport') throw new Error('offline');
    return { status: failure === 'http' ? 500 : 200,
      raw: failure === 'parse' ? '{' : JSON.stringify({ error: { message: 'failed' }, result: metadata }) };
  };
  await assert.rejects(client._openSession());
  assert.equal(client.serverInfo, undefined);
  assert.equal(client.negotiatedProtocolVersion, undefined);
});

for (const result of [metadata, {}, { serverInfo: { name: 'Bearer private-token', version: 42 } }]) {
  test(`doctor renders reported metadata only: ${JSON.stringify(result)}`, async () => {
    let stdout = '';
    let configReads = 0;
    let calls;
    class Client extends McpClient {
      constructor(server) { super(server); calls = fakePost(this, result); }
    }
    const code = await main(['doctor'], {
      loadConfig: () => { configReads++; return { cfg }; }, McpClient: Client,
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => assert.fail(text) },
      setExitCode: () => {},
    });
    assert.equal(code, 0);
    assert.equal(configReads, 1);
    assert.deepEqual(calls.map(call => call[0]), ['initialize', 'notifications/initialized', 'tools/list']);
    const lines = stdout.trim().split('\n');
    assert.match(lines[0], /^CONFIG /);
    assert.match(lines[1], /^BACKEND /);
    assert.match(lines[2], /^SERVER /);
    assert.equal(lines[3], 'MCP_OK tools=1 (fixture-tool)');
    assert.deepEqual(JSON.parse(lines[2].slice(7)), result === metadata
      ? { name: 'fixture-backend', version: 'fixture-version', protocolVersion: '2025-06-18' }
      : { name: result.serverInfo ? '[REDACTED]' : 'not reported', version: 'not reported', protocolVersion: '2024-11-05' });
    for (const secret of ['private-token', 'private-session', 'credentials', 'sessionId']) assert.ok(!stdout.includes(secret), stdout);
  });
}
