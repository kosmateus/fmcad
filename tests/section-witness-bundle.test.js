const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cadBundleManifest, cadBundleUnits, orderBundle } = require('../packages/node-adapters/dist/python/bundle');
const { preparePythonArtifact, pythonLiteral } = require('../packages/node-adapters/dist/python/artifact');
const { sectionWitnessBundleManifest, sectionWitnessHandlers, withSectionWitnessModules } = require('../packages/node-adapters/dist/python/section-witness-manifest');
const root = path.resolve(__dirname, '..');

test('isolated canonical family manifest preserves inventory and dependency ordering', () => {
  const manifest = cadBundleManifest;
  const units = cadBundleUnits(root, 'full', manifest);
  const family = units.filter(unit => unit.id.startsWith('section-witness'));
  assert.deepEqual(family.map(unit => unit.id), sectionWitnessBundleManifest.map(unit => unit.id));
  assert.ok(units.findIndex(unit => unit.id === 'measure') < units.findIndex(unit => unit.id === 'section-witness-fusion'));
  assert.deepEqual(cadBundleUnits(root, 'document-status', manifest).map(unit => unit.id), cadBundleUnits(root, 'document-status').map(unit => unit.id));
  const baseManifest = manifest.filter(unit => !unit.id.startsWith('section-witness'));
  assert.deepEqual(withSectionWitnessModules(baseManifest).map(unit => unit.id), manifest.map(unit => unit.id));
  assert.throws(() => withSectionWitnessModules(manifest), /already present/);
  assert.throws(() => orderBundle([...manifest, ...sectionWitnessBundleManifest], ['section-witness']), /duplicate/);
  assert.throws(() => orderBundle(sectionWitnessBundleManifest, ['section-witness']), /Incomplete.*core/);
  for (const item of sectionWitnessBundleManifest) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.dependencies));
  }
});

test('real prepared bundle loads isolated family once without checkout access and exports owned handlers', () => {
  const units = cadBundleUnits(root, 'full', cadBundleManifest);
  const artifact = preparePythonArtifact(units);
  const baseManifest = cadBundleManifest.filter(unit => !unit.id.startsWith('section-witness'));
  const baseline = preparePythonArtifact(cadBundleUnits(root, 'full', baseManifest));
  const source = units.map(unit => unit.source).join('\n\n');
  // Use the actual artifact source, not a hand-written family concatenation.
  assert.equal(artifact.script, source);
  assert.notEqual(artifact.sha256, baseline.sha256);
  const script = `import sys, types, builtins, pathlib, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
payload = json.loads(sys.stdin.read())
def denied(*args, **kwargs):
    raise AssertionError('runtime attempted filesystem loading')
builtins.open = denied
pathlib.Path.read_text = denied
pathlib.Path.is_file = denied
baseline = {}
exec(compile(payload['baseline'], '<baseline-bundle>', 'exec'), baseline)
ns = {}
exec(compile(payload['family'], '<section-witness-bundle>', 'exec'), ns)
registry = ns['CAD_HANDLERS']
expected = ${JSON.stringify(sectionWitnessHandlers)}
assert set(registry) - set(baseline['CAD_HANDLERS']) == set(expected)
for name in expected:
    assert callable(registry[name])
    assert registry.owners[name] == 'section-witness'
assert registry['measure.section-series'] is ns['_measure_section_series']
assert registry['measure.witness-check'] is ns['_measure_witness_check']
# Execute policy through the registered handler: malformed fields are rejected
# before any SDK call rather than silently routed to a sampled implementation.
try:
    registry['measure.witness-check'](None, {'points': [[0, 0, 0]]})
except ValueError:
    pass
else:
    raise AssertionError('sample-only witness request accepted')
print(len(registry))
`;
  const result = spawnSync('python3', ['-B', '-c', script], {
    input: JSON.stringify({ baseline: baseline.script, family: artifact.script }),
    encoding: 'utf8', cwd: '/tmp/opencode', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Number(result.stdout.trim()) > 250);
});

test('typed CLI and MCP execute section and witness through one fake broker artifact path', async (t) => {
  const { main: cliMain } = require('../src/cli');
  const { executeInvocation } = require('../src/catalog/execute');
  const { createMcpApplication } = require('../src/dist/entrypoints/mcp');
  const { mcpTools, contracts, cliContracts, validateInvocation } = require('../src/catalog');
  const { classifyEvidence } = require('../packages/core/dist/domain/evidence');
  const calls = [];
  const broker = {
    async callTool(request) {
      assert.equal(request.featureType, 'script');
      assert.equal(request.object.readOnly, true);
      const script = request.object.script;
      assert.match(script, /_measure_section_series/);
      assert.match(script, /_measure_witness_check/);
      assert.match(script, /_FMCAD_REQUEST: "_FMCADRequest" = \{/);
      const operation = ["measure.section-series", "measure.witness-check"].find((item) =>
        script.includes(`"operation": ${pythonLiteral(item)}`),
      );
      assert.ok(operation, "prepared artifact must carry the typed catalog invocation");
      const data = operation === "measure.section-series" ? sectionData : witnessData;
      assert.ok(script.includes(`"data": ${pythonLiteral(data)}`));
      calls.push(operation);
      const result = operation === 'measure.section-series'
        ? { schemaVersion: 1, operation, status: 'complete', coverage: 'partial', coverageDetail: { continuous: false, requested: 1, complete: 1 }, stations: [{ status: 'complete', area: 1, loops: [{ role: 'outer', closed: true, area: 1 }] }] }
        : { schemaVersion: 1, operation, status: 'pass', passed: true, expect: 'material', coverage: 'pass', coverageDetail: { kind: 'finite solid Boolean', sampled: false }, residualVolume: 0, precision: 'kernel', precisionDetail: { exact: false } };
      assert.equal(classifyEvidence(result), operation === 'measure.section-series' ? 'partial' : 'pass');
      return { failed: false, text: 'FMCAD_RESULT ' + JSON.stringify(result) };
    },
  };
  const sectionData = { body: 'BodyA', frame: { space: 'component local', component: 'root' }, origin: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, 1], stations: ['2 mm'] };
  const witnessData = { body: 'BodyA', witness: 'Witness', frame: { space: 'assembly', component: 'root' }, expect: 'material', volumeTolerance: '0.001 mm^3' };
  for (const [operation, data] of [['measure.section-series', sectionData], ['measure.witness-check', witnessData]]) {
    const contract = contracts[operation];
    assert.equal(contract.service.kind, 'python');
    assert.equal(contract.service.handler, operation);
    assert.equal(contract.requirements.sdk, 'required');
    assert.equal(cliContracts([])[operation].operation, operation);
    assert.ok(mcpTools.some(tool => tool._meta.fmcad.operation === operation));
  }
  assert.equal(classifyEvidence({ status: 'unknown', passed: null, coverage: 'unknown' }), 'unknown');
  assert.equal(classifyEvidence({ status: 'fail', passed: false, coverage: 'pass' }), 'fail');
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.section-series', doc: 'Synthetic', data: { ...sectionData, stations: [] } }), /stations/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.witness-check', doc: 'Synthetic', data: { ...witnessData, expect: 'sampled' } }), /expect/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.witness-check', doc: 'Synthetic', data: { ...witnessData, extra: true } }), /Unknown CAD inputs/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.section-series', doc: 'Synthetic', data: { ...sectionData, normal: [Number.MAX_VALUE, Number.MAX_VALUE, 0] } }), /magnitude/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.section-series', doc: 'Synthetic', data: { ...sectionData, stations: ['1 mm', '2 mm'], limits: { stations: 1 } } }), /station limit/);
  assert.throws(() => validateInvocation({ version: 1, kind: 'cad', operation: 'measure.witness-check', doc: 'Synthetic', data: { ...witnessData, limits: { stations: 2 } } }), /unsupported fields/);

  const previous = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-section-witness-cli-'));
  process.chdir(temp);
  t.after(() => { process.chdir(previous); fs.rmSync(temp, { recursive: true, force: true }); });
  let stdout = '', stderr = '';
  const code = await cliMain(['measure', 'section-series', '--doc', 'Synthetic', '--data', JSON.stringify(sectionData), '--json'], {
    stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } },
    loadConfig: () => ({ cfg: { routing: 'queue', backend: 'mcp', timeoutMs: 5000, headers: {} } }),
    createFmcad: () => ({
      async start() {},
      async execute(payload, options) {
        const invocation = payload.kind === 'cad-command' ? payload.invocation : payload;
        const output = await executeInvocation(invocation, broker);
        return { version: 1, requestId: options.requestId, jobId: null, state: 'succeeded', result: output,
          outcome: { acceptance: 'accepted', executionOutcome: 'succeeded', validation: { status: 'not_checked' } } };
      },
      async dispose() {},
    }),
    setExitCode() {},
  });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).operation, 'measure.section-series');
  assert.match(stderr, /^FMCAD_QUEUE_REQUEST /);

  const application = createMcpApplication({ queueTools: [], compatibility() { assert.fail('must use typed catalog'); }, services() {
    return {
      async start() {},
      async execute(payload, options) {
        const invocation = payload.kind === 'cad-command' ? payload.invocation : payload;
        const output = await executeInvocation(invocation, broker);
        return { version: 1, requestId: options.requestId, jobId: null, state: 'succeeded', result: output,
          outcome: { acceptance: 'accepted', executionOutcome: 'succeeded', validation: { status: 'not_checked' } } };
      },
    };
  } });
  const response = JSON.parse((await application({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'fmcad_cad_measure_witness_check', arguments: { doc: 'Synthetic', data: witnessData },
    _meta: { fmcad: { requestId: 'section-witness-mcp' } },
  } })).raw);
  assert.equal(response.result.structuredContent.operation, 'measure.witness-check');
  assert.equal(response.result.structuredContent.status, 'pass');
  assert.deepEqual(calls, ['measure.section-series', 'measure.witness-check']);
  const { manualHelp } = require('../src/help-manual');
  const { commands } = require('../src/commands');
  assert.match(manualHelp(commands.find(command => command.target === 'measure.section-series')), /discrete stations/);
  assert.match(manualHelp(commands.find(command => command.target === 'measure.witness-check')), /point samples/);
});
