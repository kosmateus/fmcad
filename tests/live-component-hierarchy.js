'use strict';

// Native coverage for moving root BReps into a component, renaming that
// definition, and reparenting a synthetic occurrence without changing pose.
// Everything stays in one new unsaved document and is removed by exact close.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_COMPONENT_HIERARCHY_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:component-hierarchy:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'component-hierarchy';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-component-hierarchy-report.json');
const targetOperations = ['component.from_bodies', 'component.rename', 'component.reparent', 'assembly.parts', 'assembly.rigid_group',
  'occurrence.duplicate', 'occurrence.align'];
const report = {
  suite: 'component-hierarchy', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'One new unsaved synthetic assembly; no external links, saves, cloud effects, or existing document edits.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
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
  const source = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_COMPONENT '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_COMPONENT '.length)); }
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
print('LIVE_COMPONENT ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during component hierarchy coverage.');
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

function cad(operation, data, scope = 'root') {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  const spec = validateCad(operation, data);
  if (!spec.readOnly) guard();
  const args = [...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--component', scope, '--data', JSON.stringify(data), '--json'];
  const row = cli(args);
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
  const status = output.result?.status;
  report.methodResults.push({ operation, status: status && status !== 'pass' ? status : 'invoked', result: output.result });
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
  const result = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (result) result.assertions = [...(result.assertions || []), label];
  persist();
  assert.ok(passed, label + ': ' + JSON.stringify({ actual, expected, tolerance }));
}

function validated(operation, allInvocations = false) {
  const results = report.methodResults.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(results.length, operation + ' has no native invocation result to validate.');
  for (const result of allInvocations ? results : [results.at(-1)]) result.status = 'pass';
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
print('LIVE_COMPONENT ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
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
    const rootBody = cad('shape.box', { name: 'RootBody', width: '10 mm', depth: '8 mm', height: '4 mm' }).bodies[0];
    const moved = cad('component.from_bodies', { name: 'BodyContainer', bodies: [rootBody], confirm: true });
    check('component.from_bodies', 'one explicit root body moved into the new component', moved.bodies.length, 1);
    check('component.from_bodies', 'move operation reports non-atomic semantics', moved.atomic, false);
    validated('component.from_bodies');

    const renamedName = 'RenamedBodyContainer';
    const renamed = cad('component.rename', { component: moved.component, name: renamedName });
    check('component.rename', 'rename affects all linked instances', renamed.affectsAllInstances, true);
    check('component.rename', 'returned component ref contains the new name', renamed.component.name, renamedName);
    validated('component.rename');
    const componentState = cad('component.inspect', { component: renamed.component });
    check('component.inspect', 'renamed component owns the moved native body', componentState.bodies.length, 1);
    validated('component.inspect');

    const parent = cad('component.create', { name: 'ReparentTarget' });
    const child = cad('component.create', { name: 'ReparentChild', placement: { translation: ['10 mm', '20 mm', '30 mm'] } });
    const childBody = cad('shape.box', { name: 'ReparentChildBody', width: '4 mm', depth: '5 mm', height: '6 mm' }, 'ReparentChild').bodies[0];
    const ungrounded = cad('assembly.unground', { occurrence: child.occurrence });
    check('assembly.unground', 'source occurrence is eligible for reparent', ungrounded.grounded, false);
    validated('assembly.unground');

    const before = cad('measure.bounds', { ref: { ...childBody, occurrence: child.occurrence }, units: 'mm' });
    const reparented = cad('component.reparent', { occurrence: child.occurrence, target: parent.occurrence, confirm: true });
    check('component.reparent', 'native reparent reports world-pose preservation', reparented.worldPosePreserved, true);
    check('component.reparent', 'affected nested path is reported', reparented.affectedPaths.join(','), 'ReparentTarget:1+ReparentChild:1');
    const after = cad('measure.bounds', { ref: { ...childBody, occurrence: reparented.occurrence }, units: 'mm' });
    for (const key of ['min', 'max', 'size']) before[key].forEach((value, i) =>
      check('measure.bounds', 'reparent preserves world ' + key + ' ' + 'xyz'[i], after[key][i], value, 0.001));
    const parentState = cad('component.inspect', { component: parent.component });
    check('component.inspect', 'destination definition owns the reparented child occurrence',
      parentState.occurrences.some(ref => ref.name === 'ReparentChild'), true);
    validated('component.reparent');

    const duplicate = cad('occurrence.duplicate', { occurrence: moved.occurrence, copyMode: 'linked',
      placement: { translation: ['50 mm', '0 mm', '0 mm'] } });
    check('occurrence.duplicate', 'linked duplicate preserves component definition token', duplicate.component.token, renamed.component.token);
    check('occurrence.duplicate', 'copy mode is returned explicitly', duplicate.copyMode, 'linked');
    check('occurrence.duplicate', 'source and duplicate paths are returned', duplicate.affectedPaths.length, 2);
    const originalBodyBounds = cad('measure.bounds', { ref: { ...moved.bodies[0], occurrence: moved.occurrence }, units: 'mm' });
    const duplicateBodyBounds = cad('measure.bounds', { ref: { ...moved.bodies[0], occurrence: duplicate.occurrence }, units: 'mm' });
    check('occurrence.duplicate', 'duplicate body is placed 50 mm from the source',
      duplicateBodyBounds.min[0] - originalBodyBounds.min[0], 50, 0.001);
    validated('occurrence.duplicate');

    const parts = cad('assembly.parts', {});
    const bodyPart = parts.parts.find(row => row.component.name === renamedName);
    const parentPart = parts.parts.find(row => row.component.name === 'ReparentTarget');
    const childPart = parts.parts.find(row => row.component.name === 'ReparentChild');
    assert.ok(bodyPart && parentPart && childPart, 'assembly.parts is missing one of the fixture component definitions.');
    check('assembly.parts', 'renamed component has two linked occurrences', bodyPart.quantity, 2);
    check('assembly.parts', 'renamed component carries the moved BRep body', bodyPart.bodyCount, 1);
    check('assembly.parts', 'parent assembly has one root occurrence', parentPart.quantity, 1);
    check('assembly.parts', 'reparented child remains one occurrence', childPart.quantity, 1);
    check('assembly.parts', 'reparented child reports its native BRep body', childPart.bodyCount, 1);
    check('assembly.parts', 'assembly parts scope is explicit', parts.scope.includes('subassemblies'), true);
    validated('assembly.parts');

    const rigid = cad('assembly.rigid_group', { name: 'RigidFixtureGroup',
      occurrences: [moved.occurrence, parent.occurrence], includeChildren: false });
    check('assembly.rigid_group', 'native rigid group reference is returned',
      typeof rigid.rigidGroup?.token === 'string' && rigid.rigidGroup.token.length > 0, true);
    check('assembly.rigid_group', 'native rigid group preserves the requested name', rigid.rigidGroup.name, 'RigidFixtureGroup');
    validated('assembly.rigid_group');

    const alignTarget = cad('component.create', { name: 'AlignTarget' });
    const alignSource = cad('component.create', { name: 'AlignSource',
      placement: { translation: ['30 mm', '0 mm', '0 mm'] } });
    const alignBody = cad('shape.box', { name: 'AlignBody', width: '4 mm', depth: '5 mm', height: '6 mm' }, 'AlignSource').bodies[0];
    const sourceUnground = cad('assembly.unground', { occurrence: alignSource.occurrence });
    check('assembly.unground', 'alignment source occurrence is ungrounded', sourceUnground.grounded, false);
    const beforeAlign = cad('measure.bounds', { ref: { ...alignBody, occurrence: alignSource.occurrence }, units: 'mm' });
    const aligned = cad('occurrence.align', { occurrence: alignSource.occurrence, target: alignTarget.occurrence });
    check('occurrence.align', 'native root alignment residual is within tolerance', aligned.residual <= 1e-8, true);
    check('occurrence.align', 'aligned origin matches target root transform', aligned.actual[3], 0, 1e-8);
    const afterAlign = cad('measure.bounds', { ref: { ...alignBody, occurrence: aligned.occurrence }, units: 'mm' });
    check('occurrence.align', 'aligned body moves from 30 mm offset to target origin', afterAlign.min[0], 0, 0.001);
    check('occurrence.align', 'alignment preserves body dimensions', afterAlign.size.join(','), beforeAlign.size.join(','));
    validated('occurrence.align');
    validated('component.create', true);
    validated('shape.box', true);
    validated('assembly.unground', true);
    validated('measure.bounds', true);
    validated('component.inspect');
    report.tests = [{ name: 'component-bodies-rename-and-reparent-native-readback', status: 'pass',
      operations: targetOperations }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'component-bodies-rename-and-reparent-native-readback',
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
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned component fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  const covered = new Set([...targetOperations, 'shape.box', 'component.create', 'component.inspect', 'assembly.unground', 'measure.bounds']);
  report.operationCoverage = [...covered].sort().map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-component-hierarchy.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.finalAuditError || (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL component hierarchy: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS native component hierarchy operations');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'component-hierarchy-suite-setup',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...targetOperations, 'shape.box', 'component.create', 'component.inspect', 'assembly.unground', 'measure.bounds'].map(operation => ({ operation, canonical: true, test: 'tests/live-component-hierarchy.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL component hierarchy: ' + error.stack);
  process.exitCode = 1;
});
