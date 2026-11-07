'use strict';

// Native coverage for local pose manifests and their visibility effects. The
// only target is a body in one exact, newly-created unsaved document.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_POSE_TEST_' + randomUUID().replaceAll('-', '_');
const poseA = 'PoseAlternate';
const poseB = 'PoseBaseline';
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:pose-methods:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'pose-methods';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-pose-methods-report.json');
const targets = ['pose.save', 'pose.apply', 'pose.list', 'pose.delete', 'pose.evaluate'];
const report = {
  suite: 'pose-methods', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'One fresh unsaved document, one isolated BRep visibility ref, local manifest-only payloads, exact pose deletion and owned-document close; no native ConfigurationTable, save, cloud or user-document mutation.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;
let body;
let originalVisible;

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

function script(source, readOnly = true) {
  if (!readOnly && uncertain) throw new Error('Mutation stopped after an unknown result.');
  const wrapped = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    source.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: wrapped, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_POSE '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_POSE '.length)); }
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
print('LIVE_POSE ' + json.dumps({"version": app.version, "documents": docs}))`);
}

function visibility() {
  assert.ok(identity?.creationId, 'No verified owned fixture ID.');
  return script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous'
doc = matches[0]
assert doc == app.activeDocument and doc.dataFile is None and not doc.isSaved
body = doc.design.rootComponent.bRepBodies.itemByName('PoseBody')
assert body is not None
print('LIVE_POSE ' + json.dumps({"creationId": doc.creationId, "visible": body.isLightBulbOn}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during pose coverage.');
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
  validateCad(operation, data);
  guard();
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

function check(operation, label, actual, expected) {
  const passed = actual === expected;
  report.assertions.push({ operation, label, actual, expected, status: passed ? 'pass' : 'fail' });
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, label + ': ' + JSON.stringify({ actual, expected }));
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
  const closed = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Saved/cloud fixture; leave open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_POSE ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
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
    body = cad('shape.box', { name: 'PoseBody', width: '10 mm', depth: '12 mm', height: '14 mm' }).bodies[0];
    check('shape.box', 'owned native BRep body ref is available', Boolean(body.token), true);
    validated('shape.box');
    const bodyState = visibility();
    assert.equal(bodyState.creationId, identity.creationId, 'Visibility probe resolved a different document.');
    originalVisible = bodyState.visible;
    report.originalVisible = originalVisible;

    const alternate = !originalVisible;
    const saveA = { schemaVersion: 1, frame: 'component', name: poseA,
      visibility: [{ ref: body, visible: alternate }], fillState: 'EMPTY', springState: 'COCKED',
      routeVariant: 'coverage-route', service: { disconnections: ['coverage-wire'] } };
    const savedA = cad('pose.save', saveA);
    check('pose.save', 'first local manifest revision is one', savedA.revision, 1);
    check('pose.save', 'manifest is explicitly schema v1', savedA.manifest.schema, 'fmcad.pose.manifest.v1');
    check('pose.save', 'manifest captures exact owner document identity', savedA.manifest.document.creationId, identity.creationId);
    check('pose.save', 'fill/spring/route/service are declared manifest fields',
      [savedA.manifest.fillState, savedA.manifest.springState, savedA.manifest.routeVariant,
        savedA.manifest.service.disconnections.join(',')].join('|'), 'EMPTY|COCKED|coverage-route|coverage-wire');
    validated('pose.save');

    const updateA = { ...saveA, onExisting: 'update', confirm: true };
    const updatedA = cad('pose.save', updateA);
    check('pose.save', 'confirmed update increments revision', updatedA.revision, 2);
    validated('pose.save');

    const savedB = cad('pose.save', { schemaVersion: 1, frame: 'component', name: poseB,
      visibility: [{ ref: body, visible: originalVisible }], fillState: 'FULL', routeVariant: 'baseline-route' });
    check('pose.save', 'second manifest starts at revision one', savedB.revision, 1);
    check('pose.save', 'manifest-carried full state remains declared only', savedB.manifest.fillState, 'FULL');
    validated('pose.save');

    const listed = cad('pose.list', { schemaVersion: 1, frame: 'component' });
    check('pose.list', 'both named manifests are indexed', listed.count, 2);
    check('pose.list', 'updated manifest revision is listed', listed.poses.find(pose => pose.name === poseA).revision, 2);
    check('pose.list', 'baseline manifest belongs to the exact fixture document',
      listed.poses.find(pose => pose.name === poseB).document.creationId, identity.creationId);
    validated('pose.list');

    const appliedA = cad('pose.apply', { schemaVersion: 1, frame: 'component', name: poseA });
    check('pose.apply', 'apply intentionally leaves requested state in place', appliedA.leftApplied, true);
    check('pose.apply', 'visibility target is applied', appliedA.after.visibility[body.token], alternate);
    check('pose.apply', 'manifest-only state is reported as carried, not recomputed',
      appliedA.applied.some(item => item.dimension === 'fillState' && item.applied === 'manifest-carried'), true);
    check('pose.apply', 'there are no unapplied native dimensions', appliedA.unapplied.length, 0);
    validated('pose.apply');
    check('pose.apply', 'native body visibility readback matches apply result', visibility().visible, alternate);

    const evaluatedB = cad('pose.evaluate', { schemaVersion: 1, frame: 'component', name: poseB });
    check('pose.evaluate', 'temporary evaluation restores the pre-call state', evaluatedB.restored, true);
    check('pose.evaluate', 'evaluate has no primary or restoration error',
      evaluatedB.primaryError === null && evaluatedB.restoreErrors.length === 0, true);
    check('pose.evaluate', 'temporary before-state is the alternate pose', evaluatedB.before.visibility[body.token], alternate);
    check('pose.evaluate', 'temporary after-state is the baseline pose', evaluatedB.after.visibility[body.token], originalVisible);
    check('pose.evaluate', 'restoration readback equals the alternate pose', evaluatedB.restoration.visibility[body.token], alternate);
    validated('pose.evaluate');
    check('pose.evaluate', 'native visibility is restored after temporary evaluation', visibility().visible, alternate);

    const appliedB = cad('pose.apply', { schemaVersion: 1, frame: 'component', name: poseB });
    check('pose.apply', 'baseline apply leaves the original visibility in place', appliedB.after.visibility[body.token], originalVisible);
    validated('pose.apply');
    check('pose.apply', 'native body visibility returns to its original value', visibility().visible, originalVisible);

    const deletedA = cad('pose.delete', { schemaVersion: 1, frame: 'component', name: poseA, confirm: true });
    check('pose.delete', 'confirmed delete removes the updated pose', deletedA.deleted, true);
    check('pose.delete', 'delete reports the current manifest revision', deletedA.revision, 2);
    validated('pose.delete');
    const deletedB = cad('pose.delete', { schemaVersion: 1, frame: 'component', name: poseB, confirm: true });
    check('pose.delete', 'confirmed delete removes the baseline pose', deletedB.deleted, true);
    validated('pose.delete');
    const empty = cad('pose.list', { schemaVersion: 1, frame: 'component' });
    check('pose.list', 'deleting owned poses empties the local index', empty.count, 0);
    validated('pose.list');
    report.tests = [{ name: 'native-pose-manifest-revision-apply-evaluate-restore-delete', status: 'pass',
      operations: [...targets, 'shape.box'] }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'native-pose-manifest-revision-apply-evaluate-restore-delete',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
      ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  if (!uncertain && !blockedReason && identity) {
    try {
      const after = visibility();
      report.beforeCloseVisibility = after.visible;
      if (typeof originalVisible === 'boolean' && after.visible !== originalVisible) {
        throw new Error('Owned fixture visibility was not restored before close.');
      }
      report.fixtureClosed = closeOwned();
    } catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  if (!uncertain && !blockedReason) {
    try {
      const after = state();
      report.after = after;
      report.remainingOwnedDocuments = after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
      unchangedOthers(after);
      if (report.fixtureClosed) {
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned pose fixture remains open.');
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
    return { operation, canonical: true, test: 'tests/live-pose-methods.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.cleanupError || report.finalAuditError ||
      (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL pose methods: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS pose save/list/apply/evaluate/delete and restoration assertions');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'pose-suite-setup', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
    error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...targets, 'shape.box'].map(operation => ({ operation, canonical: true,
    test: 'tests/live-pose-methods.js', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL pose methods: ' + error.stack);
  process.exitCode = 1;
});
