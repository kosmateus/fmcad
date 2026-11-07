'use strict';

// Native file-export coverage for existing STEP, STL and multi-part operations.
// Every output is uniquely named in Fusion's temp directory and removed before
// closing the newly-created unsaved fixture.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_FILE_EXPORTS_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:file-exports:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'file-exports';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-file-exports-report.json');
const targets = ['export.step', 'export.mesh', 'export.parts', 'export.verify'];
const report = {
  suite: 'file-exports', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Fresh unsaved test model; unique STEP/STL outputs are created only in Fusion temp and exact test-owned files are removed.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], ownedFiles: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;

function persist() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }

function unknownIn(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.status === 'unknown' || value.executionOutcome === 'unknown' || value.completed === false ||
      ['started', 'running', 'pending'].includes(value.status)) return true;
  return Object.values(value).some(unknownIn);
}

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '60000'], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const row = { args, exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error?.message, status: 'not-validated' };
  report.commands.push(row);
  const text = row.stdout + row.stderr.split(/\r?\n/)
    .filter(line => !line.startsWith('FMCAD_QUEUE_') && !line.startsWith('QUEUE ')).join('\n');
  if (result.error || result.signal || result.status === null || !text.trim() ||
      /empty response|timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|MCP_ERROR|HTTP [45]\d\d/i.test(text)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Indeterminate broker result; stop and inspect before retry.');
  }
  if (/EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(text)) {
    blockedReason = text.trim();
    row.status = 'blocked';
    persist();
    throw new Error('Client/epoch preflight blocked before Fusion SDK execution.');
  }
  row.status = result.status === 0 ? 'transport-returned' : 'command-failed';
  persist();
  return row;
}

function script(body, readOnly = true) {
  if (!readOnly && uncertain) throw new Error('Mutation stopped after an unknown result.');
  const source = 'import adsk.core, adsk.fusion, json, os, tempfile, hashlib\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_EXPORT '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_EXPORT '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned malformed JSON.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  if (unknownIn(value)) {
    uncertain = true;
    row.status = 'unknown';
    row.parsed = value;
    persist();
    throw new Error('Fixture probe is unknown/pending; do not replay.');
  }
  row.parsed = value;
  row.status = 'validated';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents]
print('LIVE_EXPORT ' + json.dumps({"version": app.version, "tempDir": tempfile.gettempdir(), "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during file export coverage.');
}

function guard() {
  assert.ok(identity?.creationId, 'No verified owned fixture ID.');
  const current = state();
  unchangedOthers(current);
  const matches = current.documents.filter(doc => doc.name === name);
  assert.equal(matches.length, 1, 'Fixture name is ambiguous or missing.');
  assert.equal(matches[0].creationId, identity.creationId, 'Fixture name now refers to another document.');
  assert.equal(matches[0].fileId, null, 'Fixture unexpectedly has a cloud file ID.');
  assert.equal(matches[0].saved, false, 'Fixture unexpectedly saved.');
  assert.equal(matches[0].active, true, 'Fixture is not active.');
}

function cad(operation, data) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  const spec = validateCad(operation, data);
  if (!spec.readOnly) guard();
  const row = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--component', 'root', '--data', JSON.stringify(data), '--json']);
  let output;
  try { output = JSON.parse(row.stdout); }
  catch {
    if (row.exitCode !== 0) throw new Error(operation + ': ' + (row.stderr || row.stdout));
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned no valid JSON.');
  }
  row.parsed = output;
  if (unknownIn(output)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned unknown/pending; do not replay.');
  }
  const methodStatus = output.result?.status;
  report.methodResults.push({ operation, status: methodStatus && methodStatus !== 'pass' ? methodStatus : 'invoked', result: output.result });
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  assert.equal(output.success, true, row.stdout);
  assert.equal(output.operation, operation);
  assert.equal(output.document, name);
  assert.ok(output.result && typeof output.result === 'object' && Object.keys(output.result).length,
    operation + ' returned no native result object.');
  row.status = 'native-result';
  persist();
  return output.result;
}

function check(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  report.assertions.push({ operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' });
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, label + ': ' + JSON.stringify({ actual, expected, tolerance }));
}

function validated(operation) {
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  assert.ok(method, operation + ' has no native invocation result to validate.');
  method.status = 'pass';
  persist();
}

function closeOwned() {
  if (!identity || uncertain || blockedReason) return false;
  guard();
  const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Saved/cloud fixture; leave open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_EXPORT ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
  assert.equal(result.closedCreationId, identity.creationId);
  fixture(name);
  return true;
}

async function main() {
  persist();
  await require('./run-live').prepareBroker();
  fixture(name);
  baseline = state();
  report.fusionVersion = baseline.version;
  report.before = baseline;
  assert.ok(path.win32.isAbsolute(baseline.tempDir), 'Fusion temp directory must be an absolute native path.');
  assert.ok(!baseline.documents.some(doc => doc.name === name), 'Fixture name already exists.');

  const created = cli(['doc', 'new', '--name', name, '--json']);
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);
  const afterCreate = state();
  const added = afterCreate.documents.filter(doc => !baseline.documents.some(old => old.creationId === doc.creationId));
  assert.equal(added.length, 1, 'Document creation did not create exactly one fixture.');
  assert.equal(added[0].name, name);
  assert.equal(added[0].fileId, null);
  assert.equal(added[0].saved, false);
  identity = { name, creationId: added[0].creationId };
  fixture(name, identity.creationId);
  report.ownedDocuments.push(identity);
  persist();

  const extensions = { step: '.step', stl: '.stl', partsStep: '_parts.step', partsStl: '_parts.stl' };
  const paths = Object.fromEntries(Object.entries(extensions).map(([key, suffix]) =>
    [key, path.win32.join(baseline.tempDir, name + suffix)]));
  report.ownedFiles = Object.values(paths);
  const fileFailure = error => {
    failure ||= error;
    report.tests.push({ name: 'fusion-file-export-and-readback', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
      operations: targets, error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) });
  };

  try {
    guard();
    const box = cad('shape.box', { name: 'ExportBody', width: '10 mm', depth: '20 mm', height: '30 mm' });
    check('shape.box', 'one native export fixture body created', box.bodies.length, 1);
    validated('shape.box');
    const body = box.bodies[0];

    const preflight = script(`targets = ${JSON.stringify(Object.values(paths))}
existing = [filename for filename in targets if os.path.lexists(filename)]
print('LIVE_EXPORT ' + json.dumps({"targets": targets, "existing": existing}))`);
    assert.deepEqual(preflight.existing, [], 'A unique owned export path already exists.');

    const step = cad('export.step', { path: paths.step, ref: 'root' });
    check('export.step', 'native STEP export reports a nonempty file', step.exists && step.bytes > 0, true);
    check('export.step', 'native STEP output path is exact', path.win32.normalize(step.path), path.win32.normalize(paths.step));
    validated('export.step');

    const verifiedStep = cad('export.verify', { path: paths.step, reimport: true, ref: 'root', lengthTolerance: '0.001 mm' });
    check('export.verify', 'STEP reimport verification completes', verifiedStep.reimported, true);
    check('export.verify', 'STEP BRep bounds are within native tolerance', verifiedStep.comparison.withinTolerance, true);
    validated('export.verify');

    const mesh = cad('export.mesh', { path: paths.stl, ref: body, units: 'mm', surfaceDeviation: '0.1 mm' });
    check('export.mesh', 'native STL export reports a nonempty file', mesh.exists && mesh.bytes > 84, true);
    check('export.mesh', 'STL units are explicit', mesh.tessellation.surfaceDeviation, '0.1 mm');
    validated('export.mesh');

    const parts = cad('export.parts', { parts: [
      { ref: 'root', format: 'step', path: paths.partsStep },
      { ref: body, format: 'mesh', path: paths.partsStl, units: 'mm' },
    ] });
    check('export.parts', 'two explicit part files returned', parts.files.length, 2);
    check('export.parts', 'STEP part is nonempty', parts.files[0].exists && parts.files[0].bytes > 0, true);
    check('export.parts', 'STL part is nonempty', parts.files[1].exists && parts.files[1].bytes > 84, true);
    check('export.parts', 'parts exporter reports non-atomic semantics', parts.atomic, false);
    validated('export.parts');

    validated('export.verify');
    validated('export.verify', true);

    const proof = script(`paths = ${JSON.stringify(Object.values(paths))}
rows = []
for filename in paths:
    assert os.path.isfile(filename)
    with open(filename, 'rb') as stream:
        content = stream.read()
    rows.append(dict(path=filename, bytes=len(content), sha256=hashlib.sha256(content).hexdigest(), prefix=content[:16].hex()))
step = next(row for row in rows if row['path'] == ${JSON.stringify(paths.step)})
assert bytes.fromhex(step['prefix']).startswith(b'ISO-10303-21;')
print('LIVE_EXPORT ' + json.dumps({"files": rows}))`);
    report.fileReadback = proof.files;
    check('export.step', 'STEP ISO-10303 header read back', proof.files.find(row => row.path === paths.step).prefix.startsWith('49534f2d31303330332d32313b'), true);
    report.tests = [{ name: 'fusion-file-export-and-readback', status: 'pass', operations: [...targets, 'shape.box'] }];
  } catch (error) { fileFailure(error); }

  if (!uncertain && !blockedReason && identity) {
    try {
      const cleanup = script(`owned = ${JSON.stringify(Object.values(paths))}
root = os.path.abspath(${JSON.stringify(baseline.tempDir)})
for filename in owned:
    assert os.path.dirname(os.path.abspath(filename)) == root
    assert os.path.basename(filename).startswith(${JSON.stringify(name)})
    if os.path.lexists(filename):
        assert os.path.isfile(filename) and not os.path.islink(filename), 'Owned output is not a regular file'
        os.remove(filename)
remaining = [filename for filename in owned if os.path.lexists(filename)]
assert not remaining
print('LIVE_EXPORT ' + json.dumps({"removed": owned, "remaining": remaining}))`, false);
      report.fileCleanup = cleanup;
    } catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  if (!uncertain && !blockedReason && identity) {
    try { report.fixtureClosed = closeOwned(); }
    catch (error) { failure ||= error; report.documentCleanupError = error.message; }
  }
  if (!uncertain && !blockedReason) {
    try {
      const after = state();
      report.after = after;
      report.remainingOwnedDocuments = after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
      unchangedOthers(after);
      if (report.fixtureClosed) {
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned file-export fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  report.operationCoverage = [...targets, 'shape.box'].map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-file-exports.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.cleanupError || report.documentCleanupError ||
      report.finalAuditError || (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL file exports: ' + (failure?.message || report.finalAuditError || 'exports or cleanup did not complete'));
    process.exitCode = 1;
  } else console.log('PASS STEP/STL/parts export and native readback');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'file-export-suite-setup', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
    error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...targets, 'shape.box'].map(operation => ({ operation, canonical: true,
    test: 'tests/live-file-exports.js', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL file exports: ' + error.stack);
  process.exitCode = 1;
});
