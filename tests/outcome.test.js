const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { failedOutcome } = require('../src/outcome');
const { catalog, buildCadScript, executeCad } = require('../src/cad');
const { runBatch } = require('../src/batch');

const context = { doc: 'Offline outcome fixture', component: 'root', projectId: 'offline-project', preview: false };
const metadata = { status: 'fail', passed: false, sampledPassed: false, checkOutcome: 'fail', nested: { restored: false } };
// Tuple fields: operation, unchanged evidence, application failure, optional
// legacy Python failure. The application must reject unknown evidence even when
// an older synchronous envelope reports transport success. Omitted legacy flags
// mean both layers already agree; this is not permission to replay a mutation.
const cases = [
  ['assembly.motion_check', { sampledPassed: false, continuousMotionVerified: false,
    context: { space: 'assembly', component: { kind: 'component', name: 'root' } },
    samples: [{ index: 0, translation: { xyz: [0, 0, 0], units: 'mm' }, passed: false,
      checks: [{ clearancePassed: false, distance: { value: 0, units: 'mm', dimension: 'length' } }] }],
    obstacles: [{ kind: 'body', token: 'offline-only', occurrence: { path: 'Fixture:1' } }], limitations: ['Sampled only'] }, true],
  ['assembly.motion_check', { sampledPassed: true, continuousMotionVerified: false, samples: [], limitations: ['Sampled only'] }, false],
  ['report', { checkOutcome: 'fail', status: { acceptance: 'notEvaluated' },
    checks: [{ passed: false, status: 'fail', actual: { value: 10, units: 'mm' }, source: metadata }],
    userMetadata: metadata, metadataVerified: false, limitations: ['Supplied checks only'] }, true],
  ['report', { checkOutcome: 'pass', checks: [{ passed: true, status: 'pass', id: metadata, source: metadata }],
    userMetadata: metadata, metadataVerified: false }, false],
  ['report', { checkOutcome: 'pass', status: { acceptance: 'notEvaluated' },
    checks: [{ passed: true, status: 'pass', id: metadata, source: metadata }],
    userMetadata: metadata, metadataVerified: false }, true, false],
  ['report', { checkOutcome: 'notEvaluated', checks: [], status: { acceptance: 'notEvaluated' },
    userMetadata: metadata, metadataVerified: false }, true, false],
  ['status', { changed: false, visible: false, isSolid: false, metadata, userMetadata: metadata,
    status: { status: 'fail' }, rows: [metadata] }, true, false],
  ...[{ passed: false }, { restored: false }, { status: 'fail' }, { status: 'failed' }, { status: 'blocked' }]
    .map(result => ['status', result, true]),
  ['status', { sampledPassed: 0, checkOutcome: false, passed: null, restored: 'false' }, true, false],
];

test('shared evidence policy determines application failure without changing evidence', () => {
  for (const [operation, result, failed, legacyFailed = failed] of cases) {
    const output = { success: true, operation, result, metadata };
    const before = structuredClone(output);
    assert.equal(failedOutcome(output), failed, JSON.stringify(result));
    assert.deepEqual(output, before);
    if (failed && !legacyFailed) {
      assert.equal(require('../src/dist/core').decodePublicResult(output).validation.status, 'unknown');
    }
  }
  for (const output of [null, { success: false }, ...['fail', 'failed', 'blocked', 'unknown', 'missing', 'stale'].map(status => ({ status }))]) {
    assert.equal(failedOutcome(output), true);
  }
  assert.equal(failedOutcome({ success: true, sampledPassed: false, checkOutcome: 'fail', result: {} }), false);
});

test('unknown and unresolved acceptance evidence defeats a success wrapper', () => {
  for (const status of ['unknown', 'missing', 'stale']) {
    assert.equal(failedOutcome({ success: true, result: { status } }), true);
  }
});

// Exercise the actual historical envelope and the application policy separately;
// a synchronous Python success must not erase unknown/invalid quality evidence.
test('generated Python retains evidence and the application rejects unresolved legacy success', async () => {
  for (const [operation, result, failed, legacyFailed = failed] of cases) {
    const program = `import sys, types, json
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
payload = json.load(sys.stdin)
exec(payload['script'])
class Context(CadContext):
    def __init__(self, doc, component, project, doc_id=None, doc_file_id=None):
        assert [doc, component, project] == payload['scope']
        self.doc_id, self.doc_file_id = doc_id, doc_file_id
        self.doc = types.SimpleNamespace(name=doc)
        self.app = types.SimpleNamespace(activeDocument=self.doc)
        self.created = payload['created']
    def call(self, operation, data):
        assert operation == payload['operation']
        return payload['result']
CadContext = Context
run('')
`;
    const created = [{ token: 'offline-envelope-evidence', metadata }];
    const out = spawnSync('python3', ['-B', '-c', program], { encoding: 'utf8', timeout: 2000,
      input: JSON.stringify({ script: buildCadScript(operation, catalog[operation].example, context),
        scope: [context.doc, context.component, context.projectId], operation, result, created }) });
    assert.ifError(out.error);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const envelope = JSON.parse(out.stdout.split('\n').find(line => line.startsWith('FMCAD_RESULT ')).slice(13));
    assert.deepEqual(envelope, { success: !legacyFailed, operation, document: context.doc, result, created });
    // Also normalize a legacy envelope claiming success, independently of Python's predicate.
    for (const success of [envelope.success, true]) {
      const client = { callTool: async () => ({ text: 'FMCAD_RESULT ' + JSON.stringify({ ...envelope, success }) }) };
      assert.deepEqual(await executeCad(client, operation, catalog[operation].example, context), { ...envelope, success: !failed });
    }
  }
});

test('actual batch execution stops failures, preserves scopes/results, and gates replay without retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-outcome-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [index, [operation, evidence, failed]] of cases.entries()) {
    const data = { runId: 'outcome', atomic: false, reportPath: path.join(dir, String(index)), operations: [
      { id: 'gate', operation, data: catalog[operation].example, component: 'Scoped fixture', onExisting: 'reuse' },
      { id: 'later', operation: 'status', data: {}, onExisting: 'reuse' },
    ] };
    let calls = 0;
    const client = { callTool: async () => {
      calls++;
      return { text: 'FMCAD_RESULT ' + JSON.stringify({ success: true, operation,
        document: context.doc, result: evidence, created: [], metadata }) };
    } };
    const output = await executeCad(client, 'batch.run', data, context);
    assert.equal(calls, failed ? 1 : 2);
    assert.equal(output.success, !failed);
    assert.deepEqual(output.steps.map(step => step.status), failed ? ['failed', 'skipped'] : ['success', 'success']);
    assert.deepEqual(output.context, context);
    assert.deepEqual(output.steps[0].request.context, { ...context, component: 'Scoped fixture' });
    assert.deepEqual(output.steps[0].output, { success: !failed, operation, document: context.doc,
      result: evidence, created: [], metadata });
    const files = (await fs.readdir(data.reportPath)).filter(name => name.endsWith('.json')).sort();
    const latest = path.join(data.reportPath, files.at(-1));
    assert.deepEqual(JSON.parse(await fs.readFile(latest, 'utf8')), output);
    const forbidden = () => assert.fail('Replay must never execute or retry');
    if (failed) {
      await assert.rejects(runBatch(null, data, context, forbidden, catalog), /operator inspection.*no automatic retry/);
      // Old reports may have incorrectly persisted success. Replay must inspect explicit evidence too.
      const legacy = structuredClone(output);
      legacy.success = true;
      legacy.status = 'success';
      for (const step of legacy.steps) {
        step.status = 'success';
        step.output = { success: true, result: evidence };
      }
      await fs.writeFile(latest, JSON.stringify(legacy));
      await assert.rejects(runBatch(null, data, context, forbidden, catalog), /operator inspection.*no automatic retry/);
    } else {
      const replay = await runBatch(null, data, context, forbidden, catalog);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.steps, output.steps);
      for (const scope of [{ doc: 'other' }, { component: 'other' }, { projectId: 'other' }]) {
        await assert.rejects(runBatch(null, data, { ...context, ...scope }, forbidden, catalog), /hash differs/);
      }
    }
  }
});
