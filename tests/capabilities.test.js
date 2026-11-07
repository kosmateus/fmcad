'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../src/dist/core');
const { catalog, contracts, mcpTools, mcpInvocation, localInvocation, executeCapability } = require('../src/catalog');
const { commands, findCommand } = require('../src/commands');
const { detail } = require('../src/help');
const { manuals } = require('../src/help-manual');
const { validateBatch } = require('../src/batch');

const fixturePath = path.join(__dirname, 'fixtures/evidence/nonpassing.json');

test('capabilities.inspect projects the real catalog, helper metadata and cookbook offline', () => {
  const discovery = executeCapability('capabilities.inspect', { query: 'interference', limit: 5 });
  assert.equal(discovery.success, true);
  assert.equal(discovery.status, 'pass');
  assert.equal(discovery.source, 'catalog+cad-v1');
  assert.equal(discovery.boundaries.inventoryCoverage, 'exact-registered-catalog-and-public-helper-index');
  assert.equal(discovery.boundaries.modelValidation, 'not-performed');
  assert.match(discovery.boundaries.nativeSdkProbe, /separate explicit broker/);
  assert.ok(discovery.totalMatches > 0);
  assert.ok(discovery.items.some(item => item.id === 'clearance.grid'));
  assert.ok(discovery.cookbook.some(item => item.capabilityId === 'clearance.grid'));
  assert.ok(discovery.items.every(item => item.evidence.status === 'unknown' &&
    item.evidence.precision === 'unknown' && item.evidence.coverage === 'unknown' &&
    item.evidence.sdkProbe === 'not-run'));

  const accented = executeCapability('capabilities.inspect', { query: 'interférènce', limit: 5 });
  assert.ok(accented.items.some(item => item.id === 'clearance.grid'));
  assert.equal(executeCapability('capabilities.inspect', { query: '🛠️', limit: 5 }).totalMatches, 0);
  assert.deepEqual(discovery.cookbook.find(item => item.capabilityId === 'clearance.grid').example,
    catalog['clearance.grid'].example);
});

test('capability inventory paginates deterministically and describes requirements without claiming proof', () => {
  const first = core.inspectCapabilities(contracts, { limit: 100 });
  assert.equal(first.totalMatches,
    Object.values(contracts).filter(contract => !contract.declaration.internalOnly).length + core.CAD_V1_HELPERS.length);
  assert.equal(first.items.length, 100);
  assert.equal(first.nextOffset, 100);

  const all = [];
  let offset = 0;
  while (offset !== null) {
    const page = core.inspectCapabilities(contracts, { limit: 100, offset });
    all.push(...page.items);
    offset = page.nextOffset;
  }
  assert.equal(all.length, first.totalMatches);
  assert.equal(new Set(all.map(item => item.id)).size, all.length);

  const operation = all.find(item => item.id === 'capabilities.inspect');
  assert.deepEqual(operation.prerequisites.backend, ['local']);
  assert.equal(operation.prerequisites.sdk, 'none');
  assert.equal(operation.prerequisites.identity.documentRequired, false);
  assert.equal(operation.prerequisites.identity.targetInspected, false);
  assert.equal(operation.prerequisites.build.nativeCompatibility, 'unknown');
  assert.equal(operation.mutation.readOnlyRequested, true);
  assert.equal(operation.mutation.readOnlyEnforced, false);
  assert.equal(operation.mutation.possible, 'none');
  assert.equal(operation.mutation.restoration, 'not-applicable');
  assert.ok(Array.isArray(operation.limitations));

  const helper = all.find(item => item.id === 'helper.require_pass');
  assert.equal(helper.method, 'FMCAD.require_pass');
  assert.equal(helper.mutation.possible, 'none');
  assert.equal(helper.mutation.restoration, 'not-applicable');
  assert.match(helper.limitations.join(' '), /does not rerun/);
});

test('CLI, MCP, help and batch expose the same offline boundary without probing Fusion', () => {
  const command = commands.find(entry => entry.target === 'capabilities.inspect');
  const tool = mcpTools.find(entry => entry._meta.fmcad.operation === 'capabilities.inspect');
  assert.ok(command);
  assert.ok(tool);
  assert.equal(command.key, 'capabilities inspect');
  assert.equal(command.requiresDoc, false);
  assert.equal(command.contract.requirements.sdk, 'none');
  assert.deepEqual(command.contract.requirements.backends, []);
  assert.equal(command.contract.service.kind, 'local');
  assert.equal(catalog['capabilities.inspect'].offline, true);
  assert.equal(localInvocation(mcpInvocation(tool.name, { data: { query: 'fit' } }).invocation), true);
  assert.equal(findCommand(['capabilities', 'inspect']), command);
  assert.ok(manuals['capabilities.inspect']);
  assert.match(detail('capabilities', 'inspect'), /cookbook array projects/);
  assert.match(detail('capabilities', 'inspect'), /No probe is run by inspect/);
  assert.throws(() => mcpInvocation(tool.name, { data: {}, unexpected: true }), /Unknown catalog MCP arguments/);

  const batch = validateBatch({
    runId: 'discovery',
    operations: [{ id: 'inspect', operation: 'capabilities.inspect', data: { query: 'fit' } }],
  }, catalog);
  assert.equal(batch.success, false);
  assert.match(batch.errors.join(' '), /Unknown or non-CAD operation/);
});

test('capabilities.probe is a separate SDK-required, pinned broker route', () => {
  const command = commands.find(entry => entry.target === 'capabilities.probe');
  const tool = mcpTools.find(entry => entry._meta.fmcad.operation === 'capabilities.probe');
  assert.ok(command);
  assert.ok(tool);
  assert.equal(command.requiresDoc, true);
  assert.equal(command.contract.requirements.sdk, 'required');
  assert.equal(command.contract.service.handler, 'capabilities');
  assert.equal(catalog['capabilities.probe'].offline, undefined);
  assert.throws(() => mcpInvocation(tool.name, {
    data: { capabilityId: 'clearance.grid' }, doc: 'Model',
  }), /requires --doc-id or --doc-file-id/);
  assert.equal(mcpInvocation(tool.name, {
    data: { capabilityId: 'clearance.grid' }, doc: 'Model', docId: 'creation-1',
  }).operation, 'capabilities.probe');
  assert.throws(() => mcpInvocation(tool.name, {
    data: { capabilityId: 'clearance.grid' }, doc: 'Model', docId: 'bad pin',
  }), /identity without whitespace|valid pinned document identity/);
  assert.match(detail('capabilities', 'probe'), /explicit BrokerSdkProbePort/);
  assert.match(detail('capabilities', 'probe'), /direct client\/callTool fallback is rejected/);

  const batch = validateBatch({
    runId: 'probe',
    operations: [{ id: 'probe', operation: 'capabilities.probe', data: { capabilityId: 'clearance.grid' } }],
  }, catalog);
  assert.equal(batch.success, false);
});

test('actual CLI and MCP inspect dispatch match and never load a backend', async () => {
  let configLoads = 0;
  let backends = 0;
  const stdout = { value: '', write(text) { this.value += text; } };
  const stderr = { value: '', write(text) { this.value += text; } };
  const code = await require('../src/cli').main([
    'capabilities', 'inspect', '--data', JSON.stringify({ query: 'clearance.grid', limit: 5 }), '--json',
  ], {
    loadConfig() { configLoads++; throw new Error('offline inspect must not load config'); },
    createBackend() { backends++; throw new Error('offline inspect must not create backend'); },
    stdout,
    stderr,
    setExitCode() {},
  });
  assert.equal(code, 0, stderr.value);
  const cliResult = JSON.parse(stdout.value);
  const tool = mcpTools.find(entry => entry._meta.fmcad.operation === 'capabilities.inspect');
  const invocation = mcpInvocation(tool.name, { data: { query: 'clearance.grid', limit: 5 } }).invocation;
  const mcpResult = await require('../src/catalog/execute').executeInvocation(invocation, null);
  assert.deepEqual(mcpResult, cliResult);
  assert.equal(configLoads, 0);
  assert.equal(backends, 0);
  assert.ok(cliResult.items.some(item => item.id === 'clearance.grid'));
});

test('cad-v1 helper inventory matches implemented public facade methods exactly', () => {
  const inventory = JSON.parse(execFileSync('python3', ['-B', '-c', `
import ast,json,sys
tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
facade=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='FMCAD')
methods=[]
properties=[]
for node in facade.body:
    if not isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) or node.name.startswith('_'): continue
    property_method=any(isinstance(d,ast.Name) and d.id=='property' for d in node.decorator_list)
    (properties if property_method else methods).append(node.name)
print(json.dumps(dict(methods=sorted(methods),properties=sorted(properties))))
`, path.join(__dirname, '../assets/cad/helpers.py')], { encoding: 'utf8' }));
  assert.deepEqual(core.CAD_V1_HELPERS.map(helper => helper.id).sort(), inventory.methods);
  assert.deepEqual(inventory.properties, ['has_emitted']);
  assert.ok(!core.CAD_V1_HELPERS.some(helper => helper.id.startsWith('_') || inventory.properties.includes(helper.id)));
  for (const name of ['mechanism_drive_test', 'terminal']) {
    const item = executeCapability('capabilities.inspect', { query: 'FMCAD.' + name, limit: 100 }).items.find(item => item.id === 'helper.' + name);
    assert.ok(item, name);
    assert.equal(item.evidence.sdkProbe, 'not-run');
    assert.equal(item.evidence.status, 'unknown');
  }
});

test('SDK probe is separate, explicit, broker-bound and never called by inspect/help/list', async () => {
  const request = { capabilityId: 'clearance.grid', backend: 'mcp', documentIdentity: { docId: 'creation-1' } };
  let calls = 0;
  const evidence = {
    capabilityId: request.capabilityId,
    status: 'unsupported',
    precision: 'unknown',
    coverage: 'partial',
    build: null,
    identity: 'unknown',
    mutation: 'unknown',
    restoration: 'unknown',
    limitations: ['Native implementation was not qualified.'],
  };
  const port = {
    boundary: 'fmcad-broker',
    kind: 'sdk-probe',
    async probe(input) { calls++; assert.deepEqual(input, request); return evidence; },
  };

  core.inspectCapabilities(contracts, { query: 'interference' });
  detail('capabilities', 'inspect');
  mcpTools.filter(entry => entry.name.startsWith('fmcad_cad_'));
  assert.equal(calls, 0);
  await assert.rejects(core.probeCapability({ callTool() { calls++; } }, request), /explicit fmcad broker/);
  assert.equal(calls, 0);

  const result = await core.probeCapability(port, request);
  assert.equal(calls, 1);
  assert.equal(result.source, 'broker-sdk-probe');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.backend, 'mcp');
  await assert.rejects(core.probeCapability(port, {
    ...request,
    documentIdentity: { docId: 'bad pin' },
  }), /valid pinned document identity/);
  assert.equal(calls, 1, 'malformed identity must fail before broker invocation');
  const dispatched = await executeCapability('capabilities.probe', { capabilityId: request.capabilityId },
    { docId: request.documentIdentity.docId }, { backend: request.backend, brokerSdkProbePort: port });
  assert.equal(calls, 2);
  assert.equal(dispatched.success, false);
  assert.equal(dispatched.status, 'unsupported');
  assert.equal(dispatched.result.source, 'broker-sdk-probe');
  assert.equal(executeCapability('capabilities.probe', { capabilityId: 'missing.operation' },
    { docId: request.documentIdentity.docId }, { backend: request.backend, brokerSdkProbePort: port }).status, 'missing');
  assert.equal(executeCapability('capabilities.probe', { capabilityId: 'capabilities.inspect' },
    { docId: request.documentIdentity.docId }, { backend: request.backend, brokerSdkProbePort: port }).status, 'unsupported');
  assert.equal(calls, 2, 'missing/unsupported targets must not call the broker port');
  await assert.rejects(core.probeCapability({ ...port, async probe() {
    calls++;
    return { ...evidence, status: 'pass', capabilityId: 'other.operation' };
  } }, request), /invalid or mismatched evidence/);
  assert.equal(calls, 3);
});

test('CLI and MCP probe dispatch preserve pins and reject a direct backend without the broker port', async () => {
  const request = {
    capabilityId: 'clearance.grid',
    backend: 'mcp',
    documentIdentity: { docFileId: 'file-1' },
  };
  let calls = 0;
  const brokerSdkProbePort = {
    boundary: 'fmcad-broker',
    kind: 'sdk-probe',
    async probe(input) {
      calls++;
      assert.deepEqual(input, request);
      return {
        capabilityId: input.capabilityId,
        status: 'partial',
        precision: 'unknown',
        coverage: 'partial',
        build: 'Fusion build fixture',
        identity: 'verified',
        mutation: 'none',
        restoration: 'not_applicable',
        limitations: ['SDK capability probe only; no geometry validation.'],
      };
    },
  };
  const backend = {
    capabilities: { backend: 'mcp' },
    brokerSdkProbePort,
    async callTool() { assert.fail('Probe must not call direct transport'); },
  };
  const argv = ['capabilities', 'probe', '--doc', 'Model', '--doc-file-id', 'file-1',
    '--data', JSON.stringify({ capabilityId: request.capabilityId }), '--json'];
  const stdout = { value: '', write(text) { this.value += text; } };
  const stderr = { value: '', write(text) { this.value += text; } };
  const brokerConfig = { backend: 'mcp', routing: 'queue', url: 'http://127.0.0.1:1/mcp', headers: {},
    timeoutMs: 1000, tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18',
    queue: { autoStart: false }, controlCenter: { port: 4748 } };
  let started = 0, disposed = 0, admitted = 0;
  const { executeInvocation, invocationFailed } = require('../src/catalog/execute');
  const code = await require('../src/cli').main(argv, {
    loadConfig: () => ({ cfg: brokerConfig }),
    createBackend() { assert.fail('CLI must not construct a direct backend'); },
    createFmcad: options => {
      assert.equal(options.config.routing, 'queue');
      return {
        async start() { started++; },
        async dispose() { disposed++; },
        async execute(value, execution) {
          admitted++;
          assert.equal(value.kind, 'cad-command');
          assert.deepEqual(value.invocation, {
            version: 1, kind: 'cad', operation: 'capabilities.probe',
            data: { capabilityId: request.capabilityId }, doc: 'Model', docFileId: 'file-1', preview: false,
          });
          assert.ok(execution.requestId);
          const result = await executeInvocation(value.invocation, backend);
          return {
            version: 1, requestId: execution.requestId, jobId: 'broker-job', state: 'failed', result,
            output: { stdout: JSON.stringify(result) + '\n', stderr: '' },
            outcome: { version: 1, requestId: null, jobId: null, acceptance: 'accepted', executionOutcome: 'failed',
              mayHaveMutated: false, validation: { status: 'not_checked', source: null, artifactId: null, measurements: {} }, code: 'SDK_PROBE_PARTIAL' },
          };
        },
      };
    },
    stdout, stderr, setExitCode() {},
  });
  assert.equal(code, 1, stderr.value, 'partial SDK availability must not be treated as a pass');
  const cliResult = JSON.parse(stdout.value);
  assert.equal(cliResult.success, false);
  assert.equal(cliResult.status, 'partial');
  assert.equal(cliResult.result.source, 'broker-sdk-probe');
  assert.equal(started, 1); assert.equal(disposed, 1); assert.equal(admitted, 1);

  const tool = mcpTools.find(entry => entry._meta.fmcad.operation === 'capabilities.probe');
  const call = mcpInvocation(tool.name, {
    data: { capabilityId: request.capabilityId }, doc: 'Model', docFileId: 'file-1',
  });
  const mcpResult = await executeInvocation(call.invocation, backend);
  assert.deepEqual(mcpResult, cliResult);
  assert.equal(invocationFailed(mcpResult, 'capabilities.probe'), true);
  assert.equal(calls, 2);

  let directCalls = 0;
  await assert.rejects(executeInvocation(call.invocation, {
    capabilities: { backend: 'mcp' },
    async callTool() { directCalls++; return { text: 'not a broker probe' }; },
  }), /explicit fmcad broker/);
  assert.equal(directCalls, 0);
});

test('shared negative evidence fixtures keep unresolved and contradictory statuses non-passing', () => {
  const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const expected = new Map([
    ['unknown', 'unknown'], ['partial', 'partial'], ['unsupported', 'unsupported'],
    ['missing', 'missing'], ['stale', 'stale'], ['blocked', 'blocked'],
    ['unavailable', 'unavailable'], ['null status', 'unknown'], ['sampled pass', 'partial'],
    ['partial coverage', 'partial'], ['unsupported evidence status', 'unsupported'],
    ['unknown check outcome', 'unknown'], ['unrestored', 'fail'],
    ['unresolved status', 'unknown'], ['sampled coverage', 'partial'],
    ['unsupported precision', 'unsupported'], ['sampled failure', 'fail'],
    ['unsupported flag', 'unsupported'], ['supported false', 'unsupported'],
  ]);
  for (const fixture of fixtures) {
    const output = { success: true, result: fixture.result };
    const decoded = core.decodePublicResult(output);
    assert.equal(decoded.validation.status, expected.get(fixture.name), fixture.name);
    assert.notEqual(decoded.validation.status, 'pass', fixture.name);
    if (['unknown', 'unsupported', 'missing', 'stale', 'blocked', 'unavailable', 'unrestored',
      'unresolved status', 'unsupported precision', 'sampled failure', 'unsupported flag',
      'supported false'].includes(fixture.name))
      assert.equal(core.failedOutcome(output), true, fixture.name);
  }
  for (const status of ['unknown', 'unsupported', 'missing', 'stale', 'blocked']) {
    assert.equal(core.failedOutcome({ success: true, result: { passed: true, status } }), true, status);
  }
  for (const evidence of [
    { passed: true, checkOutcome: 'unknown' },
    { passed: true, evidenceStatus: 'unsupported' },
    { passed: true, coverage: 'unknown' },
  ]) assert.equal(core.failedOutcome({ success: true, result: evidence }), true);
  assert.equal(core.failedOutcome({ success: true, result: { passed: true, status: 'partial' } }), false);
});

test('strict core result codec preserves explicit evidence terminal states', () => {
  for (const status of ['unsupported', 'missing', 'stale', 'blocked']) {
    const result = {
      version: 1,
      requestId: null,
      jobId: null,
      acceptance: 'accepted',
      executionOutcome: 'succeeded',
      mayHaveMutated: false,
      validation: { status, source: 'fixture', artifactId: null, measurements: {} },
      code: null,
    };
    assert.deepEqual(core.decodeResult(JSON.parse(core.encodeResult(result))), result);
    assert.equal(core.failedOutcome(result), true);
  }
});

test('capability search rejects malformed and over-broad paging input before dispatch', () => {
  for (const input of [null, [], { limit: 0 }, { limit: 101 }, { offset: -1 },
    { query: null }, { limit: null }, { offset: null },
    { query: 'x'.repeat(257) }, { query: 'bad\nquery' }, { undocumented: true }]) {
    assert.throws(() => core.inspectCapabilities(contracts, input));
  }
  for (const data of [{ query: 1 }, { limit: 101 }, { offset: -1 }, { unrecognized: true }]) {
    assert.throws(() => catalog.validateCad('capabilities.inspect', data));
  }
});
