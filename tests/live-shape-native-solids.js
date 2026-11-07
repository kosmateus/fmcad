'use strict';

// Native readback coverage for existing new-body profile and sector solids.
// Every operation is confined to one fresh unsaved document.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_NATIVE_SHAPES_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:shape-native-solids:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'shape-native-solids';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-shape-native-solids-report.json');
const setupOperations = ['sketch.create', 'sketch.geometry', 'sketch.inspect', 'measure.bounds', 'measure.volume', 'entity.inspect'];
const targetOperations = ['shape.rib', 'shape.web', 'shape.annular_segment', 'shape.arc_strip', 'shape.o_ring'];
const report = {
  suite: 'shape-native-solids', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Fresh unsaved fixture; isolated newBody ribs/webs/annular sector/arc strip only; no user-document edits, save, cloud write, or destructive feature operation.',
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
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_SHAPE '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Native fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_SHAPE '.length)); }
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
print('LIVE_SHAPE ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)),
    stable(baseline.documents), 'A non-fixture document changed during native shape coverage.');
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

function validated(operation) {
  const result = report.results.findLast(item => item.operation === operation && item.status === 'invoked');
  assert.ok(result, operation + ' has no native result to validate.');
  result.status = 'pass';
  persist();
}

function profile(sketchName, geometryName, end) {
  const created = cad('sketch.create', { name: sketchName, plane: 'XY' });
  check('sketch.create', 'native sketch reference returned', created.sketch?.kind, 'sketch');
  validated('sketch.create');
  const made = cad('sketch.geometry', { sketch: created.sketch, geometry: [{ type: 'rectangle', name: geometryName,
    start: ['0 mm', '0 mm', '0 mm'], end }] });
  check('sketch.geometry', 'one named rectangle reference returned', Object.keys(made.refs || {}).length, 1);
  validated('sketch.geometry');
  const inspected = cad('sketch.inspect', { sketch: created.sketch });
  check('sketch.inspect', 'closed profile count', inspected.profiles.length, 1);
  validated('sketch.inspect');
  return inspected.profiles[0].ref;
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
print('LIVE_SHAPE ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
  assert.equal(result.closedCreationId, identity.creationId);
  fixture(name);
  return true;
}

function measureBody(operation, body, sizeMm, volumeMm3, boundsTolerance = 0.001, volumeTolerance = 0.001) {
  const inspected = cad('entity.inspect', { ref: body });
  check('entity.inspect', operation + ' produced a solid BRep', inspected.isSolid, true);
  validated('entity.inspect');
  const bounds = cad('measure.bounds', { ref: body, units: 'mm' });
  bounds.size.forEach((value, index) => check('measure.bounds', operation + ' bounds ' + 'xyz'[index] + ' mm', value, sizeMm[index], boundsTolerance));
  validated('measure.bounds');
  const volume = cad('measure.volume', { ref: body, units: 'mm3' });
  check('measure.volume', operation + ' native volume mm3', volume.value, volumeMm3, volumeTolerance);
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
    const ribProfile = profile('RibSection', 'RibProfile', ['10 mm', '2 mm', '0 mm']);
    const rib = cad('shape.rib', { name: 'NativeRib', profile: ribProfile, thickness: '2 mm', operation: 'newBody' });
    check('shape.rib', 'one rib body returned', rib.bodies.length, 1);
    measureBody('shape.rib', rib.bodies[0], [10, 2, 2], 40);
    validated('shape.rib');

    const webProfile = profile('WebSection', 'WebProfile', ['2 mm', '10 mm', '0 mm']);
    const web = cad('shape.web', { name: 'NativeWeb', profile: webProfile, thickness: '1 mm', operation: 'newBody' });
    check('shape.web', 'one web body returned', web.bodies.length, 1);
    measureBody('shape.web', web.bodies[0], [2, 10, 1], 20);
    validated('shape.web');

    const annular = cad('shape.annular_segment', { name: 'NativeAnnularSector', innerRadius: '10 mm',
      outerRadius: '20 mm', start: '0 deg', sweep: '120 deg', height: '5 mm', operation: 'newBody' });
    check('shape.annular_segment', 'one annular-sector body returned', annular.bodies.length, 1);
    const annularVolume = Math.PI * (120 / 360) * (20 ** 2 - 10 ** 2) * 5;
    measureBody('shape.annular_segment', annular.bodies[0], [30, 20 * Math.sin(2 * Math.PI / 3), 5], annularVolume, 0.001, 0.01);
    check('shape.annular_segment', 'radial dimensions and sweep are retained in the result',
      annular.diameters.inner + '|' + annular.diameters.outer + '|' + annular.diameters.sweep, '10 mm|20 mm|120 deg');
    validated('shape.annular_segment');

    const arcStrip = cad('shape.arc_strip', { name: 'NativeArcStrip', centerline: {
      radius: '30 mm', start: '10 deg', sweep: '80 deg' }, thickness: '2 mm', height: '20 mm', operation: 'newBody' });
    check('shape.arc_strip', 'one curved-strip body returned', arcStrip.bodies.length, 1);
    const arcStripVolume = Math.PI * (80 / 360) * (31 ** 2 - 29 ** 2) * 20;
    const arcStripBounds = [31 * Math.cos(Math.PI / 18), 31 - 29 * Math.sin(Math.PI / 18), 20];
    measureBody('shape.arc_strip', arcStrip.bodies[0], arcStripBounds, arcStripVolume, 0.002, 0.01);
    check('shape.arc_strip', 'normal-offset radii encode the declared strip thickness',
      arcStrip.centerline.outerRadius.includes('2 mm') && arcStrip.centerline.innerRadius.includes('2 mm'), true);
    validated('shape.arc_strip');

    const oRing = cad('shape.o_ring', { schemaVersion: 1, frame: 'component', name: 'NativeORing', id: '10 mm', cs: '2 mm' });
    check('shape.o_ring', 'one free-torus BRep body returned', oRing.bodies.length, 1);
    check('shape.o_ring', 'method identifies a free torus, not an installed seal', oRing.free && oRing.torus, true);
    check('shape.o_ring', 'declared inner and cross-section diameters are returned',
      oRing.innerDiameter.value + '|' + oRing.cs.value, '10|2');
    const oRingVolume = 2 * Math.PI ** 2 * 6 * 1 ** 2;
    measureBody('shape.o_ring', oRing.bodies[0], [14, 14, 2], oRingVolume, 0.001, 0.01);
    check('shape.o_ring', 'reported recipe volume matches the torus volume formula', oRing.volume.value, oRingVolume, 0.01);
    validated('shape.o_ring');

    report.tests = [{ name: 'profile-and-sector-shapes-native-readback', status: 'pass',
      operations: [...setupOperations, ...targetOperations] }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'profile-and-sector-shapes-native-readback',
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
      assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned native-shape fixture remains open.');
      const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
      const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
      assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
    }
  } catch (error) { failure ||= error; report.finalAuditError = error.message; }

  const covered = [...setupOperations, ...targetOperations];
  report.operationCoverage = [...new Set(covered)].map(operation => ({ operation, canonical: true,
    test: 'tests/live-shape-native-solids.js', status: report.results.some(row => row.operation === operation && row.status === 'pass')
      ? 'pass' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.finalAuditError || !report.fixtureClosed) {
    console.error('FAIL native shape solids: ' + (failure?.message || report.finalAuditError || 'test did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS rib/web/sector/arc-strip native readbacks');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'profile-and-sector-shapes-suite-setup',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...setupOperations, ...targetOperations].map(operation => ({
    operation, canonical: true, test: 'tests/live-shape-native-solids.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL native shape solids: ' + error.stack);
  process.exitCode = 1;
});
