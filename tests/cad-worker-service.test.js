const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { scriptConfig } = require('./helpers/legacy');
const context = { doc: 'Pinned', docId: 'creation-1', docFileId: 'file-1' };
function io() {
  let stdout = '', stderr = '';
  return { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    get out() { return stdout; }, get err() { return stderr; } };
}
function forbidCli(t) {
  const load = Module._load;
  t.mock.method(Module, '_load', function(request, ...args) {
    if (/(?:^|\/)cli(?:\.js)?$/.test(request)) assert.fail('typed service must not import CLI/parser');
    return load.call(this, request, ...args);
  });
}
test('typed service converts parsed CAD outside worker and executes without importing CLI', async t => {
  forbidCli(t);
  const service = require('../src/cad-service');
  const { catalog } = require('../src/catalog');
  const calls = [], outcomes = [], output = io();
  const backend = { callTool: async call => {
    const request = scriptConfig(call.object.script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST;
    calls.push({ request, readOnly: call.object.readOnly });
    return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation: request.operation, result: { source: 'fake-SDK' } }) };
  } };
  for (const operation of ['document.status', 'sketch.create']) {
    const converted = service.fromParsedCommand({ kind: 'cad', operation, data: catalog[operation].example, context, json: true });
    assert.equal(converted.payload.kind, 'cad-command');
    assert.equal(await service.execute(converted, backend, value => outcomes.push(value), output), 0);
  }
  assert.deepEqual(calls.map(value => value.readOnly), [true, false]);
  assert.equal(calls[0].request.docId, context.docId);
  assert.equal(calls[1].request.docFileId, context.docFileId);
  assert.equal(outcomes.length, 2);
  assert.equal(output.out.trim().split('\n').length, 2);
});
test('legacy batch DTO dispatches shared multi-turn workflow without CLI/parser', async t => {
  forbidCli(t);
  const service = require('../src/cad-service');
  const dir = fs.mkdtempSync('/tmp/opencode/typed-worker-batch-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const converted = service.fromParsedCommand({ kind: 'cad', operation: 'batch.run', context, json: true,
    data: { runId: 'typed', reportPath: dir, atomic: false, operations: [
      { id: 'created', operation: 'component.create', data: { name: 'Bracket' } },
      { id: 'renamed', operation: 'component.rename', data: { component: { $ref: 'created.result.component' }, name: 'Renamed' } },
    ] } });
  const calls = [];
  const backend = { callTool: async call => {
    const request = scriptConfig(call.object.script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST;
    const names = fs.readdirSync(dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
    const report = JSON.parse(fs.readFileSync(path.join(dir, names.at(-1)), 'utf8'));
    assert.equal(report.steps[calls.length].status, 'running');
    calls.push(request);
    return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true, result: { component: 'Bracket:1' } }) };
  } };
  const output = io();
  assert.equal(await service.execute(converted, backend, () => {}, output), 0, output.out + output.err);
  assert.deepEqual(calls.map(call => call.operation), ['component.create', 'component.rename']);
  assert.equal(calls[1].data.component, 'Bracket:1');
  assert.equal(JSON.parse(output.out).success, true);
});
test('run DTO pins source and executes helpers/prepared script without CLI parser, preserving output publication', async t => {
  forbidCli(t);
  const service = require('../src/cad-service');
  const dir = fs.mkdtempSync('/tmp/opencode/typed-worker-run-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trusted.py'), target = path.join(dir, 'result.json');
  fs.writeFileSync(file, 'ARGS = {}\nDOC_NAME = ""\ndef run(ctx): return ARGS\n');
  const converted = service.fromParsedCommand({ kind: 'run', request: {
    name: file, args: { unicode: 'Ż $&' }, hasArgs: true, doc: context.doc,
    identity: { docId: context.docId, docFileId: context.docFileId, readOnly: true }, helperVersion: 'cad-v1',
  }, output: { path: target, format: 'json', pretty: true } });
  assert.equal(converted.payload.kind, 'run');
  assert.ok(converted.payload.request.readOnlyOperations.includes('document.status'));
  assert.equal(converted.payload.request.name, file);
  let count = 0;
  const backend = { server: { backend: 'mcp' }, callTool: async call => {
    count++; assert.equal(call.object.readOnly, true);
    assert.match(call.object.script, /facade\._terminal\(\)/);
    assert.match(call.object.script, /creation-1/);
    return { text: 'FMCAD_RESULT {"success":true,"value":"Ż"}' };
  } };
  const output = io();
  assert.equal(await service.execute(converted, backend, () => {}, output), 0);
  assert.equal(count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { success: true, value: 'Ż' });
  assert.equal(output.out, 'FMCAD_RESULT {"success":true,"value":"Ż"}\n');
  // Existing output refuses execution, not merely publication after a second mutation.
  assert.equal(await service.execute(converted, backend, () => {}, io()), 1);
  assert.equal(count, 1);
});
test('run publication failure retains stdout, returns failure and never retries', async t => {
  forbidCli(t);
  const service = require('../src/cad-service');
  const dir = fs.mkdtempSync('/tmp/opencode/typed-run-publish-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'script.py'), target = path.join(dir, 'result.json');
  fs.writeFileSync(file, 'def run(ctx): pass\n');
  const request = service.fromParsedCommand({ kind: 'run', request: { name: file, args: [], hasArgs: false, identity: {} }, output: { path: target, format: 'json' } });
  let calls = 0;
  const output = io();
  assert.equal(await service.execute(request, { callTool: async () => { calls++; return { text: 'not JSON' }; } }, () => {}, output), 1);
  assert.equal(calls, 1);
  assert.equal(output.out, 'not JSON\n');
  assert.match(output.err, /may have mutated.*No automatic retry/);
  assert.equal(fs.existsSync(target), false);
});
test('missing/invalid payload and different guard metadata reject before any backend call', async t => {
  forbidCli(t);
  const service = require('../src/cad-service');
  const backend = { callTool: () => assert.fail('no backend call') };
  await assert.rejects(service.execute({ argv: ['run', 'legacy.py'] }, backend), /payload required/);
  const request = service.fromParsedCommand({ kind: 'cad', operation: 'document.status', data: {}, context });
  await assert.rejects(service.execute({ ...request, argv: ['cad', 'document', 'status', '--doc', 'Other'] }, backend), /guard metadata/);
  assert.throws(() => service.decodeInvocation({ version: 1, kind: 'run', request: { name: 'script.py', args: Infinity, hasArgs: true, identity: {}, readOnlyOperations: [] } }), /acyclic JSON/);
  assert.throws(() => service.decodeInvocation({ version: 1, kind: 'run', request: { name: 'script.py', args: {}, hasArgs: false, identity: { docId: 'id' }, readOnlyOperations: [] } }), /require --doc/);
});
test('shared exit policy distinguishes successful batch report versions from OperationResult DTO versions', () => {
  const { invocationFailed } = require('../src/catalog/execute');
  for (const operation of ['batch.run', 'definition.instantiate']) {
    for (const version of [1, 2]) {
      assert.equal(invocationFailed({ version, operation, success: true, status: 'success' }, operation), false);
      assert.equal(invocationFailed({ version, operation, success: false, status: 'unknown' }, operation), true);
    }
    assert.equal(invocationFailed({ version: 3, operation, success: true, status: 'success' }, operation), true);
  }
});
