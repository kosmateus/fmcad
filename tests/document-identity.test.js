const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCadInput } = require('../src/cad-input');
const { buildCadScript, executeCad, catalog } = require('../src/cad');
const { main } = require('../src/cli');
const { scriptConfig } = require('./helpers/legacy');

const pins = { docId: 'creation-original', docFileId: 'urn:cloud:original' };

test('optional guards preserve legacy parsing and reject invalid/duplicate flags before backend', async () => {
  assert.deepEqual(parseCadInput(['--doc', 'Model']),
    { doc: 'Model', component: null, projectId: null, json: false, preview: false, data: {} });
  for (const flag of ['--doc-id', '--doc-file-id']) {
    for (const args of [[flag], [flag, ''], [flag, ' '], [flag, 'a b'], [flag, '-x'],
      [flag, '--json'], [flag, 'x', flag, 'x']]) {
      let backend = 0, error = '';
      const code = await main(['cad', 'status', '--doc', 'Model', ...args], {
        loadConfig: () => { backend++; throw new Error('backend reached'); },
        stdout: { write() {} }, stderr: { write(s) { error += s; } }, setExitCode() {},
      });
      assert.equal(code, 1, error);
      assert.equal(backend, 0);
      assert.match(error, /requires|Duplicate/);
    }
  }
});

test('CLI maps both document pins into typed catalog admission without creating a client', async () => {
  const config = { backend: 'mcp', routing: 'queue', url: 'http://127.0.0.1:1/mcp', headers: {},
    timeoutMs: 1000, tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18',
    queue: { autoStart: false }, controlCenter: { port: 4748 } };
  let admitted, calls = 0, factories = 0;
  const code = await main(['cad', 'status', '--doc', 'Model', '--doc-id', pins.docId,
    '--doc-file-id', pins.docFileId], {
    loadConfig: () => ({ cfg: config }),
    createBackend() { factories++; assert.fail('CLI must use the typed public service'); },
    createFmcad(options) {
      assert.equal(options.config.routing, 'queue');
      return {
        async start() {}, async dispose() {},
        async execute(payload, execution) {
          admitted = payload;
          assert.ok(execution.requestId);
          let stdout = '';
          const worker = require('../src/cad-service');
          const tools = require('../src/dist/core/application/cad/worker-command');
          const backend = {
            boundary: 'fmcad-broker', capabilities: { backend: 'mcp' },
            async callTool(args) {
              calls++;
              const request = scriptConfig(args.object.script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST;
              assert.equal(request.doc, 'Model');
              for (const key of Object.keys(pins)) assert.equal(request[key], pins[key]);
              return { text: 'FMCAD_RESULT {"success":true}', failed: false };
            },
          };
          const result = await worker.execute({ payload, argv: tools.cadWorkerPolicyArguments(payload) }, backend, () => {},
            { stdout: { write(text) { stdout += text; } }, stderr: { write() {} } });
          return { version: 1, requestId: execution.requestId, jobId: 'identity-test', state: result ? 'failed' : 'succeeded', result: null,
            output: { stdout, stderr: '' },
            outcome: { version: 1, requestId: null, jobId: null, acceptance: 'accepted',
              executionOutcome: result ? 'failed' : 'succeeded', mayHaveMutated: null,
              validation: { status: 'not_checked', source: null, artifactId: null, measurements: {} }, code: null } };
        },
      };
    },
    stdout: { write() {} }, stderr: { write() {} }, setExitCode() {},
  });
  assert.equal(code, 0);
  assert.equal(factories, 0);
  assert.equal(calls, 1);
  assert.equal(admitted.kind, 'cad-command');
  assert.equal(admitted.invocation.doc, 'Model');
  for (const key of Object.keys(pins)) assert.equal(admitted.invocation[key], pins[key]);
});

test('batch forwards pins every step and only replays unchanged historical context', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'document-identity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const client = { async callTool(args) {
    requests.push(scriptConfig(args.object.script, ['_FMCAD_REQUEST'])._FMCAD_REQUEST);
    return { text: 'FMCAD_RESULT {"success":true,"result":{}}' };
  } };
  const data = { runId: 'identity', atomic: false, reportPath: dir, operations: [
    { id: 'first', operation: 'status', data: {}, onExisting: 'reuse' },
    { id: 'second', operation: 'status', data: {}, component: 'Part', onExisting: 'reuse' },
  ] };
  const context = { doc: 'Model', ...pins };
  const result = await executeCad(client, 'batch.run', data, context);
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  for (const request of requests) for (const key of Object.keys(pins)) assert.equal(request[key], pins[key]);
  assert.equal(requests[1].component, 'Part');
  assert.equal((await executeCad(null, 'batch.run', data, context)).replayed, true);
  for (const key of Object.keys(pins)) {
    await assert.rejects(executeCad(null, 'batch.run', data, { ...context, [key]: 'changed' }), /hash differs/);
  }
  assert.equal(requests.length, 2);
});

test('real Python context and generated mutation/export/save wrappers enforce target identity', () => {
  const scripts = Object.fromEntries(['status', 'model.extrude', 'export.step', 'document.save_as'].map(operation =>
    [operation, buildCadScript(operation, catalog[operation].example, { doc: 'Model', ...pins })]));
  const result = spawnSync('python3', ['-B', path.join(__dirname, 'document_identity_test.py')], {
    input: JSON.stringify(scripts), encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
