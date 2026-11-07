'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createFmcad } = require('fmcad/api');
const { resolveFmcadConfiguration } = require('../dist/src/dist/core');
const { queueDirectory } = require('../dist/src/queue-connection');
const { serve } = require('../dist/src/queue-broker');
const { brokerConfigHash, durable } = require('../dist/src/queue-instance');
const { createBrokerTransport } = require('../src/dist/fusion-transport/broker');
const { preparePythonArtifact, pythonArtifactManifest } = require('../src/python');

test('public library admits status once and rejects bad typing before the physical sender', async t => {
  const home = fs.mkdtempSync('/tmp/opencode/library-broker-');
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  const dir = queueDirectory();
  // The documented library default covers the real public artifact plus the
  // broker's separately checked preflight and postflight receipts. Short local
  // deadlines are asserted at the worker boundary, not in this public E2E.
  const config = { ...resolveFmcadConfiguration({ adapter: { backend: 'mcp', url: 'http://localhost:1', timeoutMs: 180000 },
    environment: {}, file: {}, platformDefaults: {}, acceptedService: null }),
    queue: { autoStart: false, startupTimeoutMs: 45000, client: 'typed-library' },
    controlCenter: { port: 5481 },
  };
  const instance = { pid: 99, birth: 'mock:99', version: 'mock', activeCommand: 'SelectCommand', documents: [],
    documentState: { status: 'complete', fingerprint: 'unchanged', state: { identity: { creationId: 'creation', fileId: 'file' }, references: [] } } };
  const expected = { success: true, operation: 'document.status', result: {
    name: 'Model', creationId: 'creation', saved: true, modified: false,
    fileId: 'file', fileName: 'Model.f3d', version: 1, versionId: 'version-1',
    isComplete: true, folderId: 'folder', projectId: 'project',
  } };
  let calls = 0;
  function receipt(script) {
    const metadata = JSON.parse(execFileSync('python3', [path.join(__dirname, 'fixtures/observer-python-literals.py')], {
      input: script, encoding: 'utf8',
    }));
    const record = metadata._qr_binding || metadata._qr_binding_value;
    const file = metadata._qr_path;
    if (!record || typeof file !== 'string') return;
    const target = file.replace(/^\\\\wsl\$\\[^\\]+/, '').replaceAll('\\', '/');
    durable(target, { ...record, terminal: true, outcome: 'succeeded', instance });
  }
  const physical = createBrokerTransport({ backend: 'mcp', tool: 'fusion_mcp_execute',
    url: 'http://localhost:1', timeoutMs: 180000, headers: {} }, {
    version: 'test', requestTimeout: server => server.timeoutMs,
    bridgeSource: () => assert.fail('MCP has no bridge'),
  });
  physical._post = async payload => {
    if (payload.method === 'initialize')
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
        result: { protocolVersion: payload.params.protocolVersion } }) };
    if (payload.method === 'notifications/initialized') return { status: 202, raw: '' };
    const script = payload.params?.arguments?.object?.script || '';
    if (script.includes('FMCAD_QUEUE_INSTANCE')) {
      receipt(script);
      const text = 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(instance);
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
        result: { content: [{ type: 'text', text }] } }) };
    }
    calls++;
    receipt(script);
    const result = expected;
    const text = 'FMCAD_RESULT ' + JSON.stringify(result);
    return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text }] } }) };
  };
  let corruptNextCall = false;
  let corruptedCalls = 0;
  const prepareCallTool = physical.prepareCallTool.bind(physical);
  physical.prepareCallTool = async (argumentsObj, toolName, origin) => {
    if (corruptNextCall && argumentsObj.object?.script?.includes('_FMCAD_REQUEST')) {
      corruptNextCall = false;
      corruptedCalls++;
      if (origin) {
        const mapped = new Set(origin.sourceMap.map(entry => entry.unitId));
        const target = origin.units.find(unit => unit.role === 'wrapper') || origin.units.at(-1);
        const artifact = preparePythonArtifact(origin.units.map(unit => ({
          id: unit.id,
          filename: unit.filename,
          role: unit.role,
          source: unit.id === target.id
            ? unit.source + '\n_FMCAD_ADMISSION_REGRESSION: int = "bad"\n'
            : unit.source,
          embedded: !mapped.has(unit.id),
        })), { context: origin.context, request: origin.request });
        argumentsObj = structuredClone(argumentsObj);
        argumentsObj.object.script = artifact.script;
        origin = pythonArtifactManifest(artifact);
      } else {
        argumentsObj = structuredClone(argumentsObj);
        argumentsObj.object.script += '\n_FMCAD_ADMISSION_REGRESSION: int = "bad"\n';
      }
    }
    return prepareCallTool(argumentsObj, toolName, origin);
  };
  let broker;
  const api = createFmcad({ version: 1, config, context: { clientId: 'public-library', instanceId: 'library-instance',
    source: 'system', projectDirectory: home } });
  t.after(async () => {
    await api.dispose();
    await broker?.close();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    fs.rmSync(home, { recursive: true, force: true });
  });
  broker = await serve(config, { dir, confirmOwnership: true, createBackend: () => physical, pollMs: 5 });
  await api.start();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8')).configHash, brokerConfigHash(config));
  assert.equal((await api.query.status()).version, 1);
  const accepted = await api.execute({ version: 1, kind: 'cad', operation: 'document.status', data: {},
    doc: 'Model', docId: 'creation', docFileId: 'file', purpose: 'Inspect owned model' }, {
    requestId: 'stable-library-request', sequence: { action: 'begin', mode: 'automatic' }, queueTimeoutMs: 10000,
  });
  assert(accepted.jobId);
  assert(accepted.sequenceId === null || typeof accepted.sequenceId === 'string');
  assert.equal(accepted.requestId, 'stable-library-request');
  assert.equal(accepted.outcome.validation.status, 'not_checked');
  assert.equal((await api.query.request('stable-library-request')).jobId, accepted.jobId);
  assert.equal(await api.query.request('never-submitted'), null);
  let observed;
  for (let i = 0; i < 1000; i++) {
    observed = await api.query.result(accepted.jobId);
    if (['succeeded', 'failed', 'needs_reconciliation', 'expired'].includes(observed.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(observed.state, 'succeeded', JSON.stringify(observed));
  assert.equal(typeof observed.sequenceId, 'string', 'sequence identity is assigned when the broker starts the job');
  assert.deepEqual(observed.result, expected);
  assert.equal(observed.output.stdout, JSON.stringify(expected, null, 0) + '\n');
  assert.equal(observed.output.stderr, '');
  assert.equal(observed.outcome.executionOutcome, 'succeeded');
  assert.equal(calls, 1);
  assert(!Object.hasOwn(observed, 'request'));
  assert(!Object.hasOwn(observed, 'clientToken'));

  corruptNextCall = true;
  const invalid = await api.execute({ version: 1, kind: 'cad', operation: 'document.status', data: {},
    doc: 'Model', docId: 'creation', docFileId: 'file', purpose: 'Reject a type error before the sender' }, {
    requestId: 'stable-library-invalid',
  });
  let invalidObserved;
  for (let i = 0; i < 1000; i++) {
    invalidObserved = await api.query.result(invalid.jobId);
    if (['succeeded', 'failed', 'needs_reconciliation', 'expired'].includes(invalidObserved.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(corruptNextCall, false, 'the test mutation reached the public CAD source boundary');
  assert.equal(corruptedCalls, 1);
  assert.equal(invalidObserved.state, 'failed', JSON.stringify(invalidObserved));
  assert.equal(invalidObserved.pythonChecks?.[0]?.status, 'failed', JSON.stringify(invalidObserved));
  assert.equal(calls, 1, 'a rejected public API artifact has zero physical sender calls');

  // Complete cad-v1 helper analysis is exercised by the installed-consumer
  // profile; this queue test pins the light public route and sender fences.
  assert.equal(calls, 1);
  assert(fs.existsSync(path.join(dir, 'broker.lock')));
  await api.dispose();
  assert(fs.existsSync(path.join(dir, 'broker.lock')), 'dispose must not stop the shared broker');
});
