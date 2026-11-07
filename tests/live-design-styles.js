'use strict';

// Native coverage for existing design-local physical/visual style copy and edit.
// Uses a new unsaved document and copies library resources into that document;
// never changes a library or saves/publishes the fixture.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_STYLE_EDIT_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:design-style-edit:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'design-style-edit';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-design-styles-report.json');
const sourceCommit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const report = {
  suite: 'design-style-edit', sourceCommit, backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  name, broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT }, startedAt: new Date().toISOString(),
  scope: 'New unsaved synthetic document; library styles are copied before edit; no library mutation, save, cloud write, or user-document edit.',
  commands: [], results: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;

function persist() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }

function containsUnknown(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.status === 'unknown' || value.executionOutcome === 'unknown' || value.completed === false ||
      ['started', 'running', 'pending'].includes(value.status)) return true;
  return Object.values(value).some(containsUnknown);
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
    throw new Error('Indeterminate broker outcome; stop mutations and inspect before any retry.');
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
  if (!readOnly && uncertain) throw new Error('Mutation stopped after an unknown outcome.');
  const source = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_STYLE '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Lifecycle script returned no unambiguous native result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_STYLE '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Lifecycle script returned malformed JSON.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  if (containsUnknown(value)) {
    uncertain = true;
    row.status = 'unknown';
    row.parsed = value;
    persist();
    throw new Error('Native lifecycle result is unknown/pending; do not replay.');
  }
  row.parsed = value;
  row.status = 'validated';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents if _fmcad_live_visible(d)]
print('LIVE_STYLE ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)),
    stable(baseline.documents), 'A non-fixture document changed during design-style edit coverage.');
}

function guard() {
  assert.ok(identity?.creationId, 'No verified owned creationId.');
  const current = state();
  unchangedOthers(current);
  const matches = current.documents.filter(doc => doc.name === name);
  assert.equal(matches.length, 1, 'Fixture name is ambiguous or missing.');
  assert.equal(matches[0].creationId, identity.creationId, 'Fixture name now refers to a different document.');
  assert.equal(matches[0].fileId, null, 'Synthetic fixture unexpectedly has a cloud file ID.');
  assert.equal(matches[0].saved, false, 'Synthetic fixture unexpectedly saved.');
  assert.equal(matches[0].active, true, 'Synthetic fixture is not the active document.');
}

function cad(operation, data, mutating = !catalog[operation]?.readOnly, allowBlocked = false) {
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
  if (containsUnknown(output)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned an unknown/pending result; do not replay.');
  }
  const expectedBlocked = allowBlocked && output.success === false && output.result?.status === 'blocked';
  assert.equal(row.exitCode, expectedBlocked ? 1 : 0, row.stderr || row.stdout);
  assert.equal(output.success, !expectedBlocked, row.stdout);
  assert.equal(output.operation, operation);
  assert.equal(output.document, name);
  assert.ok(output.result && typeof output.result === 'object' && Object.keys(output.result).length,
    operation + ' returned no native result object.');
  row.status = expectedBlocked ? 'blocked' : 'native-result';
  report.results.push({ operation, status: expectedBlocked ? 'blocked' : 'invoked', result: output.result });
  persist();
  return output.result;
}

function expectRejected(operation, data, pattern) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  validateCad(operation, data);
  guard();
  const row = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--data', JSON.stringify(data), '--json']);
  assert.notEqual(row.exitCode, 0, operation + ' unexpectedly accepted a duplicate design-local name.');
  assert.match(row.stdout + '\n' + row.stderr, pattern);
  report.results.push({ operation, status: 'expected-rejection' });
  report.assertions.push({ operation, label: 'duplicate material name refused before mutation', status: 'pass' });
  persist();
}

function check(operation, label, actual, expected) {
  const passed = actual === expected;
  const row = { operation, label, actual, expected, status: passed ? 'pass' : 'fail' };
  report.assertions.push(row);
  const method = report.results.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, JSON.stringify(row));
}

function validated(operation, allInvocations = false) {
  const rows = report.results.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(rows.length, operation + ' has no native result to validate.');
  for (const row of allInvocations ? rows : [rows.at(-1)]) row.status = 'pass';
  persist();
}

function closeOwned() {
  if (!identity || uncertain) return false;
  guard();
  const closed = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave it open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Unexpected saved/cloud document; leave it open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_STYLE ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
  assert.equal(closed.closedCreationId, identity.creationId);
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
    const local = cad('material.list', {}, false);
    check('material.list', 'design material list is an array', Array.isArray(local.items), true);
    check('material.list', 'loaded material libraries are an array', Array.isArray(local.libraries), true);
    validated('material.list');

    let source;
    for (const library of local.libraries) {
      if (!library?.id) continue;
      const result = cad('material.list', { library: library.id }, false);
      const item = result.items.find(value => typeof value.id === 'string' && value.id &&
        !local.items.some(localItem => localItem.id === value.id || localItem.name === value.name));
      if (item) { source = { ...item, library: library.id }; break; }
    }
    if (!source) {
      blockedReason = 'No loaded library has a physical material to copy in this Fusion session.';
      throw new Error('Material edit test has no safe source material; no edit was attempted.');
    }

    const originalName = 'FMCAD_Material_' + randomUUID().replaceAll('-', '_');
    const copy = cad('material.create', { id: source.id, library: source.library, name: originalName });
    const localId = copy.id || copy.created?.id;
    assert.ok(typeof localId === 'string' && localId.length, 'material.create returned no actual design-local ID.');
    check('material.create', 'copied material ID is design-local', copy.id, localId);
    check('material.create', 'copied from exact library item', copy.copiedFrom, source.id);

    const editedName = originalName + '_Edited';
    const edit = cad('material.edit', { id: localId, name: editedName });
    check('material.edit', 'native material edit reports same ID', edit.after.id, localId);
    check('material.edit', 'native material name changed', edit.after.name, editedName);
    check('material.edit', 'native material edit reports a change', edit.changed, true);
    assert.ok(edit.changedFields.includes('name'), 'material.edit did not report the name field.');

    const collisionName = originalName + '_Collision';
    const secondCopy = cad('material.create', { id: source.id, library: source.library, name: collisionName });
    const secondId = secondCopy.id || secondCopy.created?.id;
    assert.ok(typeof secondId === 'string' && secondId.length, 'Second native copy returned no design-local ID.');
    check('material.create', 'second copy returned its actual ID', secondCopy.id, secondId);
    expectRejected('material.edit', { id: localId, name: collisionName }, /material name already exists in the Design/i);

    const after = cad('material.list', {}, false);
    const items = new Map(after.items.map(value => [value.id, value]));
    const readback = items.get(localId), secondReadback = items.get(secondId);
    assert.ok(readback && secondReadback, 'A copied design-local material is missing from native list readback.');
    check('material.list', 'native list readback contains edited name', readback.name, editedName);
    check('material.list', 'rejected duplicate edit leaves the second copy unchanged', secondReadback.name, collisionName);
    validated('material.list');
    validated('material.create', true);
    validated('material.edit');

    const localAppearances = cad('appearance.list', {}, false);
    check('appearance.list', 'design-local appearance list is an array', Array.isArray(localAppearances.items), true);
    check('appearance.list', 'loaded appearance libraries are an array', Array.isArray(localAppearances.libraries), true);
    let appearanceSource;
    for (const library of localAppearances.libraries) {
      if (!library?.id) continue;
      const result = cad('appearance.list', { library: library.id }, false);
      const item = result.items.find(value => typeof value.id === 'string' && value.id &&
        !localAppearances.items.some(localItem => localItem.id === value.id));
      if (item) { appearanceSource = { ...item, library: library.id }; break; }
    }
    if (!appearanceSource) {
      blockedReason = 'No loaded library appearance with a non-colliding design-local ID is available.';
      throw new Error('Appearance edit test has no safe source appearance; no visual style mutation was attempted.');
    }
    validated('appearance.list', true);

    const appearanceName = 'FMCAD_Appearance_' + randomUUID().replaceAll('-', '_');
    const appearanceCopy = cad('appearance.create', {
      id: appearanceSource.id, library: appearanceSource.library, name: appearanceName,
    });
    const appearanceId = appearanceCopy.id;
    assert.ok(typeof appearanceId === 'string' && appearanceId.length,
      'appearance.create returned no actual design-local ID.');
    check('appearance.create', 'actual copy ID is returned', appearanceCopy.id, appearanceId);
    check('appearance.create', 'source library ID is preserved in copiedFrom', appearanceCopy.copiedFrom, appearanceSource.id);

    const editedAppearanceName = appearanceName + '_Edited';
    const appearanceEdit = cad('appearance.edit', { id: appearanceId, name: editedAppearanceName });
    check('appearance.edit', 'native appearance edit preserves actual ID', appearanceEdit.after.id, appearanceId);
    check('appearance.edit', 'native appearance rename is returned', appearanceEdit.after.name, editedAppearanceName);
    check('appearance.edit', 'native appearance edit reports a change', appearanceEdit.changed, true);
    assert.ok(appearanceEdit.changedFields.includes('name'), 'appearance.edit omitted the changed name field.');

    guard();
    const projection = cad('appearance.projection', { id: appearanceId }, false);
    check('appearance.projection', 'projection read uses the exact design-local appearance ID', projection.id, appearanceId);
    check('appearance.projection', 'projection read is non-mutating', projection.changed, false);
    check('appearance.projection', 'projection read returns a nullable current property',
      projection.projection === null || typeof projection.projection === 'string' ||
        typeof projection.projection === 'number' || typeof projection.projection === 'object', true);

    const texture = cad('appearance.texture', { id: appearanceId, channel: 'color' }, false, true);
    if (texture.status === 'blocked') {
      check('appearance.texture', 'unavailable preview texture API is reported blocked, not substituted', texture.status, 'blocked');
      check('appearance.texture', 'blocked read-only texture probe reports no affected entities', texture.affected.length, 0);
      const blockedTexture = report.results.findLast(result => result.operation === 'appearance.texture');
      blockedTexture.assertions = ['installed SDK returned explicit blocked status; no texture setter was requested'];
    } else {
      check('appearance.texture', 'read-only color texture probe status', texture.status, 'pass');
      check('appearance.texture', 'texture probe uses the exact local appearance', texture.id, appearanceId);
      check('appearance.texture', 'texture channel is preserved', texture.channel, 'color');
      check('appearance.texture', 'no texture property was changed', texture.changed.length, 0);
      check('appearance.texture', 'texture readback is stable', texture.before.image, texture.after.image);
      validated('appearance.texture');
    }

    const box = cad('shape.box', { name: 'StyleAppearanceFixture', width: '4 mm', depth: '5 mm', height: '6 mm' });
    check('shape.box', 'one isolated assignment target body is created', box.bodies.length, 1);
    const body = box.bodies[0];
    const assigned = cad('appearance.assign', { refs: [body], id: appearanceId });
    check('appearance.assign', 'one body receives the design-local appearance', assigned.count, 1);
    check('appearance.assign', 'assignment returns the copied appearance ID', assigned.id, appearanceId);
    const assignmentMap = cad('appearance.assign-map', { refs: [body] });
    check('appearance.assign-map', 'one native body is mapped', assignmentMap.count, 1);
    check('appearance.assign-map', 'assignment map reports no mismatches', assignmentMap.mismatchCount, 0);
    check('appearance.assign-map', 'native body readback resolves the edited local appearance',
      assignmentMap.assignments[0].assigned.id, appearanceId);

    const assignedMaterial = cad('material.assign', { refs: [body], id: localId });
    check('material.assign', 'one native body receives the copied physical material', assignedMaterial.count, 1);
    check('material.assign', 'physical assignment returns the copied material ID', assignedMaterial.id, localId);
    const materialMap = cad('material.assign-map', { refs: [body] });
    check('material.assign-map', 'one native body is mapped for physical material', materialMap.count, 1);
    check('material.assign-map', 'physical assignment map reports no mismatches', materialMap.mismatchCount, 0);
    check('material.assign-map', 'native body readback resolves the copied material ID',
      materialMap.assignments[0].assigned.id, localId);

    const appearanceReadback = cad('appearance.list', {}, false);
    const appearanceReadbackItem = appearanceReadback.items.find(value => value.id === appearanceId);
    assert.ok(appearanceReadbackItem, 'Edited appearance is missing from design-local list readback.');
    check('appearance.list', 'native list readback contains edited appearance name',
      appearanceReadbackItem.name, editedAppearanceName);

    validated('appearance.list', true);
    validated('appearance.create');
    validated('appearance.edit');
    validated('appearance.projection');
    validated('shape.box');
    validated('appearance.assign');
    validated('appearance.assign-map');
    validated('material.assign');
    validated('material.assign-map');
    const blockedOperations = report.results.filter(result => result.status === 'blocked').map(result => result.operation);
    report.tests = [{ name: 'design-local-style-copy-edit-and-assignment-readback',
      status: blockedOperations.length ? 'partial-blocked' : 'pass', blockedOperations,
      operations: ['material.list', 'material.create', 'material.edit', 'appearance.list', 'appearance.create',
        'appearance.edit', 'appearance.projection', 'appearance.texture', 'shape.box', 'appearance.assign', 'appearance.assign-map',
        'material.assign', 'material.assign-map'] }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'design-local-style-copy-edit-and-assignment-readback',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
      ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  if (!uncertain && !blockedReason && identity) {
    try { report.fixtureClosed = closeOwned(); }
    catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  if (!uncertain && !blockedReason) {
    try {
      const after = state();
      report.after = after;
      report.remainingOwnedDocuments = after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
      unchangedOthers(after);
      if (report.fixtureClosed) {
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned style fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  const covered = ['material.list', 'material.create', 'material.edit', 'appearance.list', 'appearance.create',
    'appearance.edit', 'appearance.projection', 'appearance.texture', 'shape.box', 'appearance.assign', 'appearance.assign-map',
    'material.assign', 'material.assign-map'];
  report.operationCoverage = covered.map(operation => {
    const outcomes = report.results.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-design-styles.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('blocked') ? 'blocked' :
        uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || !['pass', 'partial-blocked'].includes(report.tests?.[0]?.status) || report.finalAuditError || !report.fixtureClosed) {
    console.error('FAIL live design styles: ' + (failure?.message || report.finalAuditError || 'test did not complete and clean up'));
    process.exitCode = 1;
  } else if (report.tests[0].status === 'partial-blocked') console.log('PARTIAL live design styles; one installed-SDK method is explicitly blocked');
  else console.log('PASS design-local style copy/edit/assignment readbacks');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'design-local-style-copy-edit-and-assignment-readback',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = ['material.list', 'material.create', 'material.edit', 'appearance.list', 'appearance.create',
    'appearance.edit', 'appearance.projection', 'appearance.texture', 'shape.box', 'appearance.assign', 'appearance.assign-map',
    'material.assign', 'material.assign-map'].map(operation => ({
    operation, canonical: true, test: 'tests/live-design-styles.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL live design styles: ' + error.stack);
  process.exitCode = 1;
});
