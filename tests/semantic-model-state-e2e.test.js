const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const {
  catalog,
  contracts,
  cliContracts,
  mcpInvocation,
  mcpTools,
  validateCad,
  validateInvocation,
} = require('../src/catalog');
const { commands, findCommand } = require('../src/commands');
const { detail } = require('../src/help');
const { executeInvocation } = require('../src/catalog/execute');
const { fromParsedCommand } = require('../src/cad-service');
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require('../packages/node-adapters/dist/python/bundle');
const {
  semanticModelStateBundleManifest,
  withSemanticModelState,
} = require('../packages/node-adapters/dist/python/semantic-model-state-manifest');
const { pythonLiteral } = require('../packages/node-adapters/dist/python/artifact');
const { classifyEvidence } = require('../packages/core/dist/domain/evidence');

const target = { doc: 'SemanticScratch', docId: 'creation-semantic-1', docFileId: 'file-semantic-1' };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scope = {
  kind: 'explicit-bindings',
  document: { creationId: target.docId, fileId: target.docFileId, version: 3 },
};
const snapshot = {
  schemaVersion: 2,
  status: 'partial',
  coverage: 'partial',
  precision: 'observational',
  exactBRepEquivalence: false,
  scope,
  entities: [],
};
const inputs = {
  'frame.context_audit': {
    ref: { kind: 'body', name: 'Housing' },
    sourceId: 'housing-definition-v3',
    instance: ['Root:1', 'Housing:2'],
    datumToRoot: identity,
    datumSource: { kind: 'fixture-analytic-placement', version: 1 },
  },
  'snapshot.capture_v2': {
    scope,
    bindings: [{ role: 'housing', sourceId: 'housing-definition-v3', ref: 'Housing', instance: ['Root:1', 'Housing:2'] }],
  },
  'snapshot.diff_v2': {
    before: snapshot,
    after: snapshot,
    allowedMovedSubtrees: [['Root:1', 'Housing:2']],
    tolerances: { pose: 1e-8 },
  },
};

function python(script, input = '') {
  const result = spawnSync('python3', ['-B', '-c', script], {
    input,
    encoding: 'utf8',
    cwd: '/tmp/opencode',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

test('canonical manifest inserts owned semantic handlers without changing other bundle families', () => {
  const units = cadBundleUnits(root, 'full', cadBundleManifest);
  const base = cadBundleManifest.filter((item) => !item.id.startsWith('semantic-model-state-'));
  const baseline = cadBundleUnits(root, 'full', base);
  const family = units.filter((unit) => unit.id.startsWith('semantic-model-state-'));
  assert.deepEqual(family.map((unit) => unit.id), semanticModelStateBundleManifest.map((unit) => unit.id));
  assert.ok(units.findIndex((unit) => unit.id === 'entity') < units.findIndex((unit) => unit.id === 'semantic-model-state-fusion'));
  assert.deepEqual(
    units.filter((unit) => !unit.id.startsWith('semantic-model-state-')).map((unit) => unit.id),
    baseline.map((unit) => unit.id),
  );
  assert.deepEqual(withSemanticModelState(base).map((unit) => unit.id), cadBundleManifest.map((unit) => unit.id));
  assert.throws(() => withSemanticModelState(cadBundleManifest), /already present/);
  assert.throws(() => orderBundle([...cadBundleManifest, ...semanticModelStateBundleManifest], ['semantic-model-state-application']), /duplicate/);

  const script = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
data = json.loads(sys.stdin.read())
base = {}
exec(compile(data['base'], '<base>', 'exec'), base)
full = {}
exec(compile(data['full'], '<full>', 'exec'), full)
expected = {'frame.context_audit', 'snapshot.capture_v2', 'snapshot.diff_v2'}
registry = full['CAD_HANDLERS']
assert set(registry) - set(base['CAD_HANDLERS']) == expected
assert {registry.owners[name] for name in expected} == {'semantic-model-state'}
for name in expected:
    assert callable(registry[name])
print('registered')
`;
  assert.equal(python(script, JSON.stringify({
    base: baseline.map((unit) => unit.source).join('\n\n'),
    full: units.map((unit) => unit.source).join('\n\n'),
  })), 'registered');
});

test('typed catalog exposes pinned CLI/MCP/helper/help contracts with strict semantic validation', () => {
  assert.ok(catalog.snapshot);
  assert.ok(catalog.diff);
  assert.doesNotThrow(() => validateCad('diff', {
    before: { schema: 'fmcad.measure.snapshot.v1', document: { name: 'LegacySnapshot' } },
  }));
  assert.ok(contracts.diff);
  const operations = Object.keys(inputs);
  for (const operation of operations) {
    const contract = contracts[operation];
    assert.ok(catalog[operation]);
    assert.equal(contract.service.kind, 'python');
    assert.equal(contract.service.handler, operation);
    assert.equal(contract.declaration.documentPin, true);
    assert.equal(contract.requirements.document, true);
    assert.equal(contract.readOnlyRequested, true);
    assert.equal(cliContracts([])[operation].operation, operation);
    assert.ok(mcpTools.some((tool) => tool._meta.fmcad.operation === operation));
    assert.ok(findCommand(operation.split('.')));
    const name = 'fmcad_cad_' + operation.replaceAll('.', '_');
    assert.equal(mcpInvocation(name, { ...target, data: inputs[operation] }).operation, operation);
  }
  assert.deepEqual(
    require('../packages/core/dist/catalog/capabilities').CAD_V1_HELPERS
      .filter((helper) => helper.id.endsWith('_v2') || helper.id === 'frame_context_audit')
      .map((helper) => helper.method),
    ['FMCAD.frame_context_audit', 'FMCAD.snapshot_capture_v2', 'FMCAD.snapshot_diff_v2'],
  );
  const helperSource = require('node:fs').readFileSync(path.join(root, 'assets/cad/helpers.py'), 'utf8');
  const helperOutput = python(`import json, types, sys
from pathlib import Path
source = json.loads(sys.stdin.read())
allowed = {'frame.context_audit', 'snapshot.capture_v2', 'snapshot.diff_v2'}
class Context:
    component = None
    read_only_operations = allowed
    def resolve(self, ref, kind=None): return ref
    def call(self, operation, data): return {'operation': operation, 'data': data}
ns = {}
exec(compile(source, 'assets/cad/helpers.py', 'exec'), ns)
facade = ns['FMCAD'](Context(), readonly=True)
inputs = {'ref': 'body'}
results = [facade.frame_context_audit(inputs), facade.snapshot_capture_v2(inputs), facade.snapshot_diff_v2(inputs)]
assert [row['operation'] for row in results] == sorted(allowed)
assert [row['operation'] for row in facade.calls] == sorted(allowed)
print('helper-ok')
`, JSON.stringify(helperSource));
  assert.equal(helperOutput, 'helper-ok');
  for (const operation of Object.keys(inputs))
    assert.match(detail(...operation.split('.')), /Python helper|FMCAD\./i);

  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'snapshot.diff_v2', doc: target.doc, data: inputs['snapshot.diff_v2'] }), /doc-id or --doc-file-id/);
  assert.throws(() => validateCad('frame.context_audit', { ...inputs['frame.context_audit'], extra: true }), /Unknown CAD inputs/);
  assert.throws(() => validateCad('frame.context_audit', { ...inputs['frame.context_audit'], datumToRoot: [1, 2] }), /16 numbers/);
  assert.throws(() => validateCad('snapshot.capture_v2', { ...inputs['snapshot.capture_v2'], bindings: Array(257).fill(inputs['snapshot.capture_v2'].bindings[0]) }), /at most 256/);
  assert.throws(() => validateCad('snapshot.diff_v2', { ...inputs['snapshot.diff_v2'], before: { ...snapshot, success: true } }), /unsupported fields/);
  assert.throws(() => validateCad('snapshot.diff_v2', { ...inputs['snapshot.diff_v2'], after: { ...snapshot, coverage: 'complete' } }), /partial observation/);
  assert.throws(() => validateInvocation({
    version: 1, kind: 'cad', operation: 'snapshot.capture_v2', doc: target.doc,
    docId: 'another-creation', data: inputs['snapshot.capture_v2'],
  }), /match the pinned document identity/);
  assert.throws(() => validateCad('snapshot.diff_v2', { ...inputs['snapshot.diff_v2'], tolerances: { pose: 0 } }), /positive and finite/);
  assert.throws(() => validateCad('snapshot.diff_v2', { ...inputs['snapshot.diff_v2'], allowedMovedSubtrees: [[]] }), /nonempty root-qualified/);
  const manual = require('../src/help-manual').manuals;
  for (const operation of Object.keys(inputs)) assert.ok(manual[operation]);
});

test('public CLI and MCP use the common immutable artifact path once per pinned read-only operation', async (t) => {
  const calls = [];
  const backend = {
    async callTool(request) {
      assert.equal(request.featureType, 'script');
      assert.equal(request.object.readOnly, true);
      const script = request.object.script;
      assert.match(script, /_semantic_register_handlers/);
      assert.match(script, /def _semantic_frame_audit/);
      assert.match(script, /def _semantic_diff/);
      assert.match(script, /_FMCAD_REQUEST: "_FMCADRequest" = \{/);
      const operation = Object.keys(inputs).find((item) =>
        script.includes(`"operation": ${pythonLiteral(item)}`),
      );
      assert.ok(operation, "prepared worker artifact carries the validated invocation");
      assert.ok(script.includes(`"data": ${pythonLiteral(inputs[operation])}`));
      assert.ok(Object.hasOwn(inputs, operation));
      calls.push({ operation, script });
      const result = operation === 'frame.context_audit'
        ? { schemaVersion: 2, operation, status: 'pass', precision: 'sampled', exactBRepEquivalence: false, failures: [], witnessCount: 2 }
        : operation === 'snapshot.capture_v2'
          ? { ...snapshot, scope: inputs[operation].scope, entities: [], operation }
          : { schemaVersion: 2, operation, status: 'pass', precision: 'observational', coverage: 'partial', exactBRepEquivalence: false, changes: [], duplicates: { before: [], after: [] }, missingObservations: [] };
      return { failed: false, text: 'FMCAD_RESULT ' + JSON.stringify(result) };
    },
  };

  const invocation = (operation) => ({
    version: 1,
    kind: 'cad',
    operation,
    data: inputs[operation],
    ...target,
  });
  const direct = await executeInvocation(invocation('snapshot.diff_v2'), backend);
  assert.equal(direct.operation, 'snapshot.diff_v2');
  assert.equal(direct.coverage, 'partial');
  assert.equal(classifyEvidence(direct), 'partial');
  const parsed = fromParsedCommand({
    kind: 'cad', operation: 'snapshot.capture_v2', data: inputs['snapshot.capture_v2'],
    context: target, json: true,
  });
  assert.equal(parsed.payload.invocation.operation, 'snapshot.capture_v2');

  const { main: cliMain } = require('../src/cli');
  const oldCwd = process.cwd();
  process.chdir('/tmp/opencode');
  t.after(() => process.chdir(oldCwd));
  let stdout = '', stderr = '';
  const cliCode = await cliMain([
    'frame', 'context_audit', '--doc', target.doc, '--doc-id', target.docId,
    '--data', JSON.stringify(inputs['frame.context_audit']), '--json',
  ], {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    loadConfig: () => ({ cfg: { routing: 'queue', backend: 'mcp', timeoutMs: 5000, headers: {} } }),
    createFmcad: () => ({
      async start() {},
      async execute(payload, options) {
        const result = await executeInvocation(payload.kind === 'cad-command' ? payload.invocation : payload, backend);
        return { version: 1, requestId: options.requestId, jobId: null, state: 'succeeded', result,
          outcome: { acceptance: 'accepted', executionOutcome: 'succeeded', validation: { status: 'not_checked' } } };
      },
      async dispose() {},
    }),
    setExitCode() {},
  });
  assert.equal(cliCode, 0, stderr);
  assert.equal(JSON.parse(stdout).operation, 'frame.context_audit');

  const { createMcpApplication } = require('../src/dist/entrypoints/mcp');
  const mcp = createMcpApplication({ queueTools: [], compatibility() { assert.fail('catalog tool must use typed worker path'); }, services() {
    return {
      async start() {},
      async execute(payload, options) {
        const result = await executeInvocation(payload.kind === 'cad-command' ? payload.invocation : payload, backend);
        return { version: 1, requestId: options.requestId, jobId: null, state: 'succeeded', result,
          outcome: { acceptance: 'accepted', executionOutcome: 'succeeded', validation: { status: 'not_checked' } } };
      },
    };
  } });
  const response = JSON.parse((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'fmcad_cad_snapshot_diff_v2', arguments: { ...target, data: inputs['snapshot.diff_v2'] },
    _meta: { fmcad: { requestId: 'semantic-model-state-mcp' } },
  } })).raw);
  assert.equal(response.result.structuredContent.operation, 'snapshot.diff_v2');
  assert.equal(response.result.structuredContent.coverage, 'partial');
  assert.deepEqual(calls.map((call) => call.operation), [
    'snapshot.diff_v2', 'frame.context_audit', 'snapshot.diff_v2',
  ]);
  assert.equal(new Set(calls.map((call) => call.script)).size, 2);
  for (const call of calls) assert.match(call.script, /def _semantic_frame_audit/);
});
