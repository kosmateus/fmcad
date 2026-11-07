const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executeSemanticModelState } = require('../src/dist/core/application/semantic-model-state');
const { classifyEvidence } = require('../src/dist/core/domain/evidence');
const { failedOutcome } = require('../src/dist/core/domain/outcome');
const { validateCad } = require('../src/catalog');
const { preparePythonArtifact, pythonValue } = require('../src/python');
const { semanticModelStateModules } = require('../src/dist/python/semantic-model-state-manifest');

const context = { docId: 'scratch-id', docFileId: 'scratch-file' };
const snapshot = { schemaVersion: 2, status: 'partial', coverage: 'partial', precision: 'observational', exactBRepEquivalence: false, scope: { kind: 'explicit-bindings', document: { creationId: 'scratch-id', fileId: 'scratch-file', version: 3 } }, entities: [] };
const request = { operation: 'snapshot.diff_v2', data: { before: snapshot, after: snapshot } };

function prepare(req, ctx) {
  const units = semanticModelStateModules.map(module => ({
    id: module.id, filename: module.path, role: 'runtime',
    source: fs.readFileSync(path.join(__dirname, '..', module.path), 'utf8'),
  }));
  units.push({ id: 'wrapper', filename: '<semantic-test>', role: 'wrapper',
    source: `import json\nresult = _semantic_diff(${pythonValue(req.data.before)}, ${pythonValue(req.data.after)})\nprint('FMCAD_RESULT ' + json.dumps({'success': True, 'result': result}))` });
  return preparePythonArtifact(units, { request: req, context: ctx });
}

function services(overrides = {}) {
  return {
    validate: validateCad,
    prepare: (operation, data, ctx) => prepare({ operation, data }, ctx),
    execution: { async execute(turn) { return { text: spawnSync('python3', ['-B', '-c', turn.artifact.script], { encoding: 'utf8' }).stdout }; } },
    dispatch: () => undefined,
    sketchValidates: () => false,
    failed: failedOutcome,
    ...overrides,
  };
}

test('semantic API uses the shared CAD artifact/execution boundary without a snapshot store', async () => {
  let prepared, calls = 0;
  const result = await executeSemanticModelState(request, context, services({
    prepare(operation, data, ctx) {
      prepared = prepare({ operation, data }, ctx);
      return prepared;
    },
    execution: { async execute(turn) {
    calls++;
    assert.equal(turn.artifact, prepared);
    assert.equal(turn.readOnly, true);
    assert.deepEqual(turn.context, context);
    assert.ok(Object.isFrozen(turn.artifact.bytes));
    const run = spawnSync('python3', ['-B', '-c', turn.artifact.script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const evidence = JSON.parse(run.stdout.split('FMCAD_RESULT ')[1]).result;
    assert.equal(evidence.status, 'pass');
    assert.equal(evidence.exactBRepEquivalence, false);
    assert.equal(classifyEvidence(evidence), 'partial');
    return { text: run.stdout };
    } },
  }));
  assert.equal(calls, 1);
  assert.equal(result.result.precision, 'observational');
});

test('semantic execution refuses unpinned targeting and does not replay unknown outcomes', async () => {
  let calls = 0;
  assert.throws(() => executeSemanticModelState(request, {}, services()), /pinned document identity/);
  await assert.rejects(executeSemanticModelState(request, context, services({ execution: { async execute() {
    calls++;
    throw new Error('unknown SDK outcome');
  } } })), /unknown SDK/);
  assert.equal(calls, 1);
});
