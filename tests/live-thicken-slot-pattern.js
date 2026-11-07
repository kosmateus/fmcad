'use strict';

// Native readback coverage for two existing feature operations that had no
// live-suite case: model.thicken and shape.slot_pattern. All bodies live only
// in one new unsaved document and are removed by closing that exact fixture.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_THICKEN_PATTERN_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:thicken-pattern:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'thicken-pattern';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-thicken-slot-pattern-report.json');
const setupOperations = ['shape.box', 'entity.find', 'shape.slot', 'entity.list', 'entity.inspect', 'measure.bounds', 'measure.volume'];
const targetOperations = ['model.thicken', 'shape.slot_pattern'];
const report = {
  suite: 'thicken-slot-pattern', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Synthetic unsaved document; newBody-only thickening/pattern features; no save, cloud write, or user-document edit.',
  commands: [], results: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
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
    throw new Error('Indeterminate broker result; stop mutations and inspect before retry.');
  }
  if (/EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(text)) {
    blockedReason = text.trim();
    row.status = 'blocked';
    persist();
    throw new Error('Client/epoch preflight blocked before a native method ran.');
  }
  row.status = result.status === 0 ? 'transport-returned' : 'command-failed';
  persist();
  return row;
}

function script(body, readOnly = true) {
  const source = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_TP '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Native fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_TP '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Native fixture probe returned malformed JSON.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  if (unknownIn(value)) {
    uncertain = true;
    row.status = 'unknown';
    row.parsed = value;
    persist();
    throw new Error('Native fixture probe is unknown/pending; do not replay.');
  }
  row.parsed = value;
  row.status = 'validated';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents if _fmcad_live_visible(d)]
print('LIVE_TP ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)),
    stable(baseline.documents), 'A non-fixture document changed during feature coverage.');
}

function guard() {
  assert.ok(identity?.creationId, 'No verified owned creationId.');
  const current = state();
  unchangedOthers(current);
  const matches = current.documents.filter(doc => doc.name === name);
  assert.equal(matches.length, 1, 'Fixture name is ambiguous or missing.');
  assert.equal(matches[0].creationId, identity.creationId, 'Fixture name now refers to another document.');
  assert.equal(matches[0].fileId, null, 'Fixture unexpectedly has a cloud file ID.');
  assert.equal(matches[0].saved, false, 'Fixture unexpectedly saved.');
  assert.equal(matches[0].active, true, 'Fixture is not active.');
}

function cad(operation, data, mutating = !catalog[operation]?.readOnly) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  validateCad(operation, data);
  if (mutating) guard();
  const row = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--data', JSON.stringify(data), '--json']);
  let output;
  try { output = JSON.parse(row.stdout); }
  catch {
    if (row.exitCode !== 0) throw new Error(operation + ': ' + (row.stderr || row.stdout));
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned no valid JSON result.');
  }
  row.parsed = output;
  if (unknownIn(output)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned unknown/pending; do not replay.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  assert.equal(output.success, true, row.stdout);
  assert.equal(output.operation, operation);
  assert.equal(output.document, name);
  assert.ok(output.result && typeof output.result === 'object' && Object.keys(output.result).length,
    operation + ' returned no native result object.');
  row.status = 'native-result';
  report.results.push({ operation, status: 'invoked', result: output.result });
  persist();
  return output.result;
}

function check(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  const row = { operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' };
  report.assertions.push(row);
  const result = report.results.findLast(item => item.operation === operation && item.status === 'invoked');
  if (result) result.assertions = [...(result.assertions || []), label];
  persist();
  assert.ok(passed, JSON.stringify(row));
}

function validated(operation, allInvocations = false) {
  const results = report.results.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(results.length, operation + ' has no native result to validate.');
  for (const result of allInvocations ? results : [results.at(-1)]) result.status = 'pass';
  persist();
}

function closeOwned() {
  if (!identity || uncertain) return false;
  guard();
  const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave it open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Saved/cloud fixture; leave it open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_TP ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
  assert.equal(result.closedCreationId, identity.creationId);
  fixture(name);
  return true;
}

function measureSolid(operation, body, size, volume) {
  const inspected = cad('entity.inspect', { ref: body });
  check('entity.inspect', operation + ' returned a solid body', inspected.isSolid, true);
  validated('entity.inspect');
  const bounds = cad('measure.bounds', { ref: body, units: 'mm' });
  bounds.size.forEach((value, index) => check('measure.bounds', operation + ' bounds ' + 'xyz'[index], value, size[index], 0.001));
  validated('measure.bounds');
  const measured = cad('measure.volume', { ref: body, units: 'mm3' });
  check('measure.volume', operation + ' body volume mm3', measured.value, volume, Math.max(0.001, volume * 0.00001));
  validated('measure.volume');
}

async function main() {
  persist();
  await require('./run-live').prepareBroker();
  fixture(name);
  baseline = state();
  report.fusionVersion = baseline.version;
  report.before = baseline;
  assert.ok(!baseline.documents.some(doc => doc.name === name), 'Fixture name already exists.');

  const created = cli(['doc', 'new', '--name', name]);
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

  try {
    guard();
    const base = cad('shape.box', { name: 'ThickenBase', width: '10 mm', depth: '8 mm', height: '2 mm' });
    check('shape.box', 'thicken fixture body', base.bodies.length, 1);
    validated('shape.box');
    const faceResult = cad('entity.find', { kind: 'face', filters: {
      geometry: 'plane', axis: [0, 0, 1], position: ['0 mm', '0 mm', '2 mm'],
    }, expect: 1 }, false);
    check('entity.find', 'one top planar face selected', faceResult.entities.length, 1);
    validated('entity.find');
    const thickened = cad('model.thicken', { name: 'ThickenedTop', entities: [faceResult.entities[0]],
      thickness: '1 mm', operation: 'newBody', symmetric: false, tangentChain: false });
    check('model.thicken', 'one new thickened body returned', thickened.bodies.length, 1);
    measureSolid('model.thicken', thickened.bodies[0], [10, 8, 1], 80);
    validated('model.thicken');

    const beforePattern = cad('entity.list', { kind: 'body' }, false);
    const seed = cad('shape.slot', { name: 'PatternSeed', length: '10 mm', width: '4 mm',
      position: ['20 mm', '0 mm', '0 mm'], thickness: '2 mm', operation: 'newBody' });
    check('shape.slot', 'newBody seed slot returned one body', seed.bodies.length, 1);
    validated('shape.slot');
    const seedVolume = cad('measure.volume', { ref: seed.bodies[0], units: 'mm3' }, false);
    check('measure.volume', 'native slot seed has positive volume', seedVolume.value > 0, true);
    validated('measure.volume');
    const pattern = cad('shape.slot_pattern', { name: 'TwoSlots', entities: [seed.feature],
      direction: 'X', quantity: 2, distance: '20 mm', distanceType: 'spacing' });
    check('shape.slot_pattern', 'pattern feature returned', pattern.feature?.kind, 'feature');
    const afterPattern = cad('entity.list', { kind: 'body' }, false);
    check('entity.list', 'pattern adds one seed copy body', afterPattern.entities.length, beforePattern.entities.length + 2);
    const idsBefore = new Set(beforePattern.entities.map(entity => entity.token));
    const slotBodies = afterPattern.entities.filter(entity => !idsBefore.has(entity.token));
    check('entity.list', 'two isolated slot bodies exist', slotBodies.length, 2);
    validated('entity.list', true);
    const volumes = [];
    for (const [index, body] of slotBodies.entries()) {
      const measured = cad('measure.volume', { ref: body, units: 'mm3' }, false);
      volumes.push(measured.value);
      check('measure.volume', 'pattern body ' + index + ' volume matches seed', measured.value, seedVolume.value, 0.001);
    }
    validated('measure.volume', true);
    check('shape.slot_pattern', 'patterned slots have equal native volume', volumes[0], volumes[1], 0.001);
    check('shape.slot_pattern', 'patterned slot volume matches seed', volumes[0], seedVolume.value, 0.001);
    validated('shape.slot_pattern');
    report.tests = [{ name: 'native-thicken-and-slot-pattern-readback', status: 'pass',
      operations: [...setupOperations, ...targetOperations, 'shape.slot'] }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'native-thicken-and-slot-pattern-readback',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
      ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  if (!uncertain && identity) {
    try { report.fixtureClosed = closeOwned(); }
    catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  try {
    const after = state();
    report.after = after;
    report.remainingOwnedDocuments = after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
    unchangedOthers(after);
    if (report.fixtureClosed) {
      assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned feature fixture remains open.');
      const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
      const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
      assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
    }
  } catch (error) { failure ||= error; report.finalAuditError = error.message; }

  const covered = [...setupOperations, ...targetOperations, 'shape.slot'];
  report.operationCoverage = [...new Set(covered)].map(operation => ({ operation, canonical: true,
    test: 'tests/live-thicken-slot-pattern.js', status: report.results.some(row => row.operation === operation && row.status === 'pass')
      ? 'pass' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.finalAuditError || !report.fixtureClosed) {
    console.error('FAIL live thicken/slot pattern: ' + (failure?.message || report.finalAuditError || 'test did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS model.thicken and shape.slot_pattern native readbacks');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'native-thicken-and-slot-pattern-readback',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...setupOperations, ...targetOperations, 'shape.slot'].map(operation => ({
    operation, canonical: true, test: 'tests/live-thicken-slot-pattern.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL live thicken/slot pattern: ' + error.stack);
  process.exitCode = 1;
});
