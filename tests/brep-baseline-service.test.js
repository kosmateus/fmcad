'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main: cliMain } = require('../src/cli');
const { executeInvocation } = require('../src/catalog/execute');
const { contracts, mcpTools, mcpInvocation, validateInvocation, cliContracts } = require('../src/catalog');
const { cadBundleManifest } = require('../packages/node-adapters/dist/python/bundle');
const { randomUUID } = require('node:crypto');
const { resolveFmcadConfiguration } = require('../src/dist/core');
const { createFmcad } = require('../src/dist/api');
const { createMcpApplication } = require('../src/dist/entrypoints/mcp');
const { serve } = require('../src/queue-broker');
const { queueDirectory } = require('../src/queue-connection');
const { durable } = require('../src/queue-instance');

const context = { doc: 'Synthetic', docId: 'scratch-creation', docFileId: 'scratch-file' };
const data = {
  bodies: [
    { role: 'housing', body: { kind: 'body', token: 'body-token-a', name: 'Housing' } },
    { role: 'shaft', body: { kind: 'body', token: 'body-token-b', name: 'Shaft' } },
  ],
  frame: 'assembly',
  scope: 'durable',
  workBudgetMs: 30000,
};
const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  version: 1,
  scope: 'durable',
  source: { document: 'scratch-file', version: '7' },
  frame: 'assembly',
  bodies: [
    { role: 'housing', body: 'body-token-a', instance: 'occurrence:Root:1', pose },
    { role: 'shaft', body: 'body-token-b', instance: 'occurrence:Root:1', pose },
  ],
};
const tolerances = { volume: '0.001 mm^3', length: '0.001 mm', angle: '0.001 deg' };

function fixture(t, enterProject = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-brep-coordinator-'));
  const previous = process.cwd();
  if (enterProject) process.chdir(root);
  t.after(() => {
    if (enterProject) process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('canonical catalog, typed CLI/MCP project the same three public operations and hide internal turns', () => {
  const publicIds = ['measure.baseline.capture', 'measure.baseline.inspect', 'measure.baseline.compare'];
  for (const id of publicIds) {
    assert.equal(contracts[id].service.handler, 'brep-baseline');
    assert.ok(mcpTools.some(tool => tool._meta.fmcad.operation === id), id);
    assert.equal(cliContracts([])[id].operation, id);
  }
  assert.equal(mcpTools.some(tool => tool._meta.fmcad.operation.endsWith('_internal')), false);
  assert.equal(Object.keys(cliContracts([])).some(operation => operation.endsWith('_internal')), false);
  for (const operation of ['measure.baseline.capture_internal', 'measure.baseline.compare_internal']) {
    assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation, data: {} }), /Unknown CAD operation/);
  }
  const cad = require('../src/cad');
  assert.throws(() => cad.validateCad('measure.baseline.capture_internal', {
    bodies: data.bodies, frame: data.frame, scope: 'durable',
    _trustedBinding: { version: 1, session: 'forged', stagePaths: ['/tmp/forged.smt'],
      maxBytes: 1024, workBudgetMs: 1000 },
  }), /owned coordinator capability/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.baseline.capture',
    doc: 'Synthetic', data }), /doc-id or --doc-file-id/);
  assert.equal(mcpInvocation('fmcad_cad_measure_baseline_capture', {
    ...context, data,
  }).operation, 'measure.baseline.capture');
  assert.ok(cadBundleManifest.some(unit => unit.id === 'measure-baseline-domain'));
  assert.ok(cadBundleManifest.some(unit => unit.id === 'measure-baseline-fusion'));
  assert.ok(cadBundleManifest.some(unit => unit.id === 'measure-baseline-application'));
});

test('typed CLI and MCP execute capture → owned inspect → compare through the fake broker', { timeout: 60000 }, async t => {
  t.after(require('./fixtures/fake-wsl-platform.cjs')());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-brep-broker-'));
  const project = path.join(root, 'project');
  const state = path.join(root, 'state');
  fs.mkdirSync(project);
  const previousCwd = process.cwd();
  const oldState = process.env.XDG_STATE_HOME;
  process.chdir(project);
  process.env.XDG_STATE_HOME = state;
  const apis = [];
  let broker;
  const nativeCalls = [];
  const instance = {
    pid: 99,
    birth: 'fake:99',
    version: 'fake-fusion',
    activeCommand: 'SelectCommand',
    documents: [{ id: 'scratch-creation', fileId: 'scratch-file', name: 'Synthetic' }],
    documentState: {
      status: 'complete',
      fingerprint: 'fixture-document',
      state: { identity: { creationId: 'scratch-creation', fileId: 'scratch-file', name: 'Synthetic', version: 7 }, references: [] },
    },
  };
  const fakeBackend = {
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    async _post(envelope) {
      const request = envelope.params.arguments;
      const script = request.object.script;
      if (script.includes('FMCAD_QUEUE_INSTANCE')) {
        const text = 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(instance);
        return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: envelope.id,
          result: { content: [{ type: 'text', text }] } }) };
      }
      assert.match(script, /class BrepBaselineService/);
      assert.match(script, /class FusionExactBrepSerializer/);
      assert.match(script, /_measure_baseline_internal_handler/);
      assert.ok(request.object.readOnly);
      const binding = script.match(/_qr_binding = _qr_json.loads\(("(?:\\.|[^"\\])*")\)/);
      const receiptFile = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (binding && receiptFile) {
        const record = JSON.parse(JSON.parse(binding[1]));
        const target = JSON.parse(receiptFile[1]).replace(/^\\\\wsl\$\\[^\\]+/, '').replaceAll('\\', '/');
        durable(target, { ...record, terminal: true, outcome: 'succeeded', instance });
      }
      const stageId = fs.readdirSync(path.join(project, '.cad/baseline-staging'))[0];
      const stageDir = path.join(project, '.cad/baseline-staging', stageId);
      const entries = fs.readdirSync(stageDir);
      const op = entries.length === 0
        ? 'measure.baseline.capture_internal'
        : 'measure.baseline.compare_internal';
      const stagePaths = [0, 1].map(index => path.join(stageDir, `${index}.smt`));
      nativeCalls.push({ operation: op, stagePaths });
      assert.ok(script.includes(JSON.stringify(op)) || script.includes(op));
      if (op.endsWith('capture_internal')) {
        for (const [index, stagePath] of stagePaths.entries()) {
          fs.writeFileSync(stagePath, Buffer.from(`fake-exact-brep-${index}`), { flag: 'wx' });
        }
        const text = 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation: op,
          result: { status: 'pass', precision: 'exact', manifest, stagedPayloadCount: 2 } });
        return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: envelope.id,
          result: { content: [{ type: 'text', text }] } }) };
      }
      assert.deepEqual(stagePaths.map(file => fs.readFileSync(file).toString()),
        ['fake-exact-brep-0', 'fake-exact-brep-1']);
      const text = 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation: op,
        result: { status: 'pass', passed: true, precision: 'exact', geometryEqual: true, poseEqual: true,
          bodies: manifest.bodies.map(body => ({ role: body.role, volumeEqual: true, poseEqual: true })) } });
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: envelope.id,
        result: { content: [{ type: 'text', text }] } }) };
    },
    async callTool(value) {
      const response = await this._post({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
        params: { name: 'fusion_mcp_execute', arguments: value } });
      return { failed: false, text: JSON.parse(response.raw).result.content[0].text };
    },
  };
  const config = resolveFmcadConfiguration({
    adapter: { backend: 'mcp', routing: 'queue', url: 'http://127.0.0.1:8765/mcp', timeoutMs: 5000,
      headers: {} },
    environment: {}, file: {}, platformDefaults: {}, acceptedService: null,
  });
  const brokerDirectory = queueDirectory();
  t.after(async () => {
    for (const api of apis) await api.dispose();
    await broker?.close();
    process.chdir(previousCwd);
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const preload = path.join(root, 'fake-wsl-preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('./fixtures/fake-wsl-platform.cjs'))})();\n`);
  broker = await serve(config, {
    dir: brokerDirectory, confirmOwnership: true, createBackend: () => fakeBackend, pollMs: 5,
    spawnWorker(executable, args, options) {
      return require('node:child_process').spawn(executable, ['--require', preload, ...args], options);
    },
  });

  let cliOutput = '', cliErrors = '';
  const cliCode = await cliMain([
    'measure', 'baseline', 'capture', '--doc', context.doc,
    '--doc-id', context.docId, '--doc-file-id', context.docFileId,
    '--data', JSON.stringify(data), '--json',
  ], {
    loadConfig: () => ({ cfg: config }),
    stdout: { write: value => { cliOutput += value; } },
    stderr: { write: value => { cliErrors += value; } },
    setExitCode: () => {},
  });
  assert.equal(cliCode, 0, cliErrors);
  const captured = JSON.parse(cliOutput);
  assert.equal(captured.success, true);
  assert.equal(captured.operation, 'measure.baseline.capture');
  assert.equal(captured.result.status, 'pass');
  assert.equal(captured.result.precision, 'exact');
  assert.equal(captured.result.bodyPayloads.length, 2);
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].stagePaths.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(project, '.cad/baseline-staging')), []);

  const mcp = createMcpApplication({
    services(local, mcpContext) {
      const api = createFmcad({ version: 1, config, context: {
        ...mcpContext,
        clientId: mcpContext.clientId || 'brep-mcp-test',
        instanceId: mcpContext.instanceId || 'brep-mcp-instance',
        source: 'mcp',
        projectDirectory: mcpContext.projectDirectory || project,
      } });
      apis.push(api);
      return api;
    },
    clientContext: {
      identity: { clientId: 'brep-mcp-test', instanceId: 'brep-mcp-instance', sessionId: 'brep-mcp-session' },
      resolveProject: async selection => ({
        projectDirectory: selection.projectDirectory || project,
        source: selection.projectDirectory ? 'explicit' : 'none',
      }),
    },
    compatibility: async () => assert.fail('BRep application calls must not use the legacy backend proxy'),
    queueTools: [],
  });
  const mcpCall = async (id, operation, requestData, requestContext = {}) => {
    const response = await mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'fmcad_execute', arguments: { operation, data: requestData, context: {
        ...requestContext,
      } }, _meta: { fmcad: { projectDirectory: project } },
    } });
    const parsed = JSON.parse(response.raw);
    assert.equal(parsed.error, undefined, JSON.stringify(parsed));
    const value = parsed.result.structuredContent;
    const jobId = value.jobId || parsed.result._meta?.fmcad?.jobId;
    if (!jobId) return value;
    const api = apis.at(-1);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const receipt = await api.query.result(jobId);
      if (['succeeded', 'failed', 'cancelled', 'expired', 'needs_reconciliation'].includes(receipt.state))
        return receipt.result ?? receipt;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`MCP baseline job ${jobId} did not settle`);
  };
  const inspected = await mcpCall('inspect', 'measure.baseline.inspect', { baseline: captured.result.baseline });
  assert.equal(inspected.success, true);
  assert.equal(inspected.result.manifest.source.version, '7');
  assert.deepEqual(inspected.result.bodyPayloads.map(row => row.bytes), [17, 17]);
  assert.ok(inspected.result.bodyPayloads.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));

  const compareInput = mcpInvocation('fmcad_cad_measure_baseline_compare', {
    ...context, data: { baseline: captured.result.baseline, bodies: data.bodies, tolerances },
  }).invocation;
  const compared = await mcpCall('compare', 'measure.baseline.compare', compareInput.data, {
    doc: context.doc, docId: context.docId, docFileId: context.docFileId,
  });
  assert.equal(compared.success, true);
  assert.equal(compared.result.passed, true);
  assert.equal(compared.result.geometryEqual, true);
  assert.equal(compared.result.poseEqual, true);
  assert.equal(nativeCalls.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(project, '.cad/baseline-staging')), []);
});

test('unknown fake-broker outcome retains one owned staging turn and never replays', async t => {
  t.after(require('./fixtures/fake-wsl-platform.cjs')());
  const root = fixture(t, true);
  let turns = 0;
  const input = mcpInvocation('fmcad_cad_measure_baseline_capture', {
    ...context,
    data,
  }).invocation;
  await assert.rejects(() => executeInvocation(input, {
    callTool: async () => { turns++; throw new Error('unknown transport outcome'); },
  }), /unknown transport outcome/);
  assert.equal(turns, 1);
  const stages = fs.readdirSync(path.join(root, '.cad/baseline-staging'));
  assert.equal(stages.length, 1);
  assert.equal(fs.readdirSync(path.join(root, '.cad/baseline-staging', stages[0])).length, 0);
});
