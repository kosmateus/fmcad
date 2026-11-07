const test = require('node:test');
const assert = require('node:assert/strict');
const { BrokerAddinClient } = require('../packages/node-adapters/dist/fusion-transport/addin');
const fs = require('node:fs');
const path = require('node:path');
const dependencies = { version: 'test', requestTimeout: server => server.timeoutMs,
  bridgeSource: () => fs.readFileSync(path.join(__dirname, '../assets/cad/identity.py'), 'utf8') + '\n' +
    fs.readFileSync(path.join(__dirname, '../assets/addin-bridge.py'), 'utf8') };

const script = 'def run(context):\n    print("hello")';
const execution = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

function fixture(t, result = execution({ success: true, stdout: 'hello\n', stderr: '' })) {
  const client = new BrokerAddinClient({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 100 }, dependencies);
  const requests = [];
  client._post = async (payload, sessionId) => {
    requests.push({ payload, sessionId });
    if (payload.method === 'initialize') return { status: 200, sessionId: 'addin-session', raw: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' };
    if (payload.method === 'notifications/initialized') return { status: 202, raw: '' };
    if (payload.method === 'tools/list') return { status: 200, raw: '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' };
    if (result instanceof Error) throw result;
    return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) };
  };
  return { client, requests, calls: () => requests.filter(r => r.payload.method === 'tools/call') };
}

test('scripts append the entry point exactly once, disable persistence and reuse protocol 2025 session', async t => {
  const f = fixture(t);
  await f.client.listTools();
  for (const readOnly of [true, false]) {
    const out = await f.client.callTool({ featureType: 'script', object: { script, readOnly } });
    const { name, arguments: args } = f.calls().at(-1).payload.params;
    assert.equal(name, 'execute_python');
    assert.equal(args.persistent, false);
    assert.equal(args.code.split('run("")').length - 1, 1);
    assert.ok(args.code.endsWith(script + '\n\nrun("")\n'));
    if (readOnly) assert.equal(args.code, script + '\n\nrun("")\n');
    else assert.match(args.code, /activeCommand[\s\S]*?raise RuntimeError/);
    assert.deepEqual(out, { text: 'hello\n', data: null, failed: false, stderr: '',
      backend: 'addin', readOnlyRequested: readOnly, readOnlyEnforced: false });
  }
  assert.equal(f.requests.filter(r => r.payload.method === 'initialize').length, 1);
  assert.equal(f.requests[0].payload.params.protocolVersion, '2025-06-18');
  assert.equal(f.requests.filter(r => r.payload.method === 'notifications/initialized').length, 1);
  for (const r of f.requests.slice(1)) assert.equal(r.sessionId, 'addin-session');
});

test('ordinary mutation command guard emits a request-bound proven preflight receipt', async t => {
  const f = fixture(t, execution({ success: false, stdout: '', stderr: '' }));
  let submitted = 0, guardedCode = '';
  f.client._post = async (payload) => {
    if (payload.method === 'initialize') return { status: 200, sessionId: 'addin-session', raw: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' };
    if (payload.method === 'notifications/initialized') return { status: 202, raw: '' };
    if (payload.method === 'tools/list') return { status: 200, raw: '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' };
    submitted++;
    guardedCode = payload.params.arguments.code;
    const token = guardedCode.match(/_fmcad_guard_token = \"([0-9a-f-]+)\"/)[1];
    return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: execution({ success: false,
      stdout: `FMCAD_UI_GUARD ${token} ${JSON.stringify({ status: 'rejected-before-mutation', notStarted: true,
        activeCommand: 'MoveCommand', identityAvailable: true })}`, stderr: 'guard rejected' }) }) };
  };
  const out = await f.client.callTool({ featureType: 'script', object: { script } });
  assert.equal(out.failed, true);
  assert.deepEqual(out.uiGuard, { status: 'rejected-before-mutation', notStarted: true,
    activeCommand: 'MoveCommand', identityAvailable: true });
  assert.equal(submitted, 1);
  assert.ok(guardedCode.endsWith(script + '\n\nrun("")\n'));
});

for (const [label, payload, failed, text] of [
  ['stdout and stderr', { success: true, stdout: 'ok', stderr: 'warning' }, false, 'ok'],
  ['exception', { success: false, stdout: 'partial', error: 'ValueError', traceback: 'stack', stderr: 'err' }, true, 'partial\nValueError\nstack\nerr'],
  ['ERROR line', { success: true, stdout: 'first\nERROR bad\nlast', stderr: 'err' }, true, 'first\nERROR bad\nlast\nerr'],
  ['embedded ERROR is not a line', { success: true, stdout: 'not ERROR bad', stderr: '' }, false, 'not ERROR bad'],
]) test(`execution payload: ${label}`, async t => {
  const f = fixture(t, execution(payload));
  const out = await f.client.callTool({ featureType: 'script', object: { script } });
  assert.equal(out.failed, failed);
  assert.equal(out.text, text);
  assert.equal(out.stderr, payload.stderr);
  assert.equal(f.calls().length, 1);
});

for (const payload of [null, {}, { success: 'true', stdout: '' }, { success: true }, { success: true, stdout: [] }]) {
  test(`malformed execution response ${JSON.stringify(payload)} is not retried`, async t => {
    const f = fixture(t, execution(payload));
    await assert.rejects(f.client.callTool({ featureType: 'script', object: { script } }), /Malformed.*may have run.*retrying/);
    assert.equal(f.calls().length, 1);
  });
}

test('structured execution payload and bridge prefix expose native-shaped data', async t => {
  const data = { results: [{ name: 'Part', id: 'file-id' }] };
  const f = fixture(t, { structuredContent: { success: true,
    stdout: 'diagnostic\r\nFMCAD_BRIDGE_RESULT ' + JSON.stringify(data) + '\r\n', stderr: '' } });
  const out = await f.client.callTool({ queryType: 'document', operation: 'search', name: 'Part' }, 'fusion_mcp_read');
  assert.deepEqual(out.data, data);
  assert.equal(out.text, JSON.stringify(data));
  assert.equal(out.failed, false);
  assert.equal(out.readOnlyEnforced, false);
  assert.match(f.calls()[0].payload.params.arguments.code, /_BRIDGE_REQUEST = /);
});

for (const stdout of ['missing marker', 'FMCAD_BRIDGE_RESULT {bad']) {
  test(`invalid bridge result: ${stdout}`, async t => {
    const f = fixture(t, execution({ success: true, stdout }));
    await assert.rejects(f.client.callTool({ queryType: 'projects' }, 'fusion_mcp_read'));
    assert.equal(f.calls().length, 1);
  });
}

test('bridge domain failure remains a failure', async t => {
  const data = { success: false, message: 'not found' };
  const f = fixture(t, execution({ success: true, stdout: 'FMCAD_BRIDGE_RESULT ' + JSON.stringify(data) }));
  const out = await f.client.callTool({ queryType: 'projects' }, 'fusion_mcp_read');
  assert.deepEqual(out.data, data);
  assert.equal(out.failed, true);
});

test('screenshot arguments map to capture_viewport and preserve image content', async t => {
  const result = { content: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }] };
  const f = fixture(t, result);
  const out = await f.client.callTool({ queryType: 'screenshot', width: 640, height: 480,
    direction: 'iso-top-right', antiAliasing: false, transparentBackground: true }, 'fusion_mcp_read');
  assert.deepEqual(f.calls()[0].payload.params, { name: 'capture_viewport', arguments: {
    width: 640, height: 480, view: 'iso_top_right', anti_aliasing: false, background: 'transparent' } });
  assert.deepEqual(JSON.parse(out.text), result);
  assert.equal(out.failed, false);
  await f.client.callTool({ queryType: 'screenshot', direction: 'current', transparentBackground: false }, 'fusion_mcp_read');
  assert.deepEqual(f.calls()[1].payload.params.arguments, { background: 'viewport' });
});

for (const [tool, request] of [
  ['fusion_mcp_read', { queryType: 'licensing' }],
  ['fusion_mcp_read', { queryType: 'document', operation: 'recent' }],
  ...['undo', 'redo'].map(featureType => ['fusion_mcp_update', { featureType }]),
  ['fusion_mcp_electronics_read', { entity_type: 'electronics.Board' }],
]) test(`unsupported ${JSON.stringify(request)} rejects before any post`, async t => {
  const f = fixture(t);
  await assert.rejects(f.client.callTool(request, tool), /--backend mcp.*fallback/i);
  assert.deepEqual(f.requests, []);
});

test('transport failure never retries or invokes a native tool', async t => {
  const f = fixture(t, new Error('connection lost; operation may have run'));
  await assert.rejects(f.client.callTool({ featureType: 'script', object: { script } }), /connection lost/);
  assert.deepEqual(f.calls().map(r => r.payload.params.name), ['execute_python']);
  assert.equal(f.client.capabilities.automaticFallback, false);
  assert.equal(f.client.capabilities.automaticMutationRetry, false);
});

test('MCP isError fails even when execution payload claims success', async t => {
  const f = fixture(t, { ...execution({ success: true, stdout: 'partial', stderr: 'error detail' }), isError: true });
  const out = await f.client.callTool({ featureType: 'script', object: { script } });
  assert.equal(out.failed, true);
  assert.equal(out.text, 'partial\nerror detail');
  assert.equal(f.calls().length, 1);
});

test('API documentation maps categories and rejects native filters offline', async t => {
  const f = fixture(t, { content: [{ type: 'text', text: 'documentation' }] });
  for (const [apiCategory, category] of [[undefined, 'all'], ['class', 'class_name'], ['member', 'member_name'],
    ['description', 'description'], ['all', 'all']]) {
    await f.client.callTool({ queryType: 'apiDocumentation', searchPattern: 'Sketch', apiCategory }, 'fusion_mcp_read');
    assert.deepEqual(f.calls().at(-1).payload.params, { name: 'fetch_api_documentation',
      arguments: { search_term: 'Sketch', category } });
  }
  const count = f.requests.length;
  for (const options of [{ filter: 'adsk.fusion' }, { apiCategory: 'invalid' }]) {
    await assert.rejects(f.client.callTool({ queryType: 'apiDocumentation', ...options }, 'fusion_mcp_read'));
  }
  assert.equal(f.requests.length, count);
});

test('array script objects with script properties must reject before execution', async t => {
  const f = fixture(t);
  const object = Object.assign([], { script, readOnly: true });
  await assert.rejects(f.client.callTool({ featureType: 'script', object }), /object/i);
  assert.deepEqual(f.requests, []);
});

for (const object of [undefined, null, [], 'script', 3, {}, { script: '' }, { script: '  ' }, { script: 3 }]) {
  test(`invalid script object ${JSON.stringify(object)} rejects offline`, async t => {
    const f = fixture(t);
    await assert.rejects(f.client.callTool({ featureType: 'script', object }));
    assert.deepEqual(f.requests, []);
  });
}

for (const readOnly of ['true', 'false', 0, 1, null, {}, []]) {
  test(`nonboolean readOnly ${JSON.stringify(readOnly)} must reject before execution`, async t => {
    const f = fixture(t);
    await assert.rejects(f.client.callTool({ featureType: 'script', object: { script, readOnly } }), /readOnly.*boolean/i);
    assert.deepEqual(f.requests, []);
  });
}

for (const request of [null, [], 'request', 1]) {
  test(`invalid request ${JSON.stringify(request)} rejects offline`, async t => {
    const f = fixture(t);
    await assert.rejects(f.client.callTool(request));
    assert.deepEqual(f.requests, []);
  });
}
