'use strict';

// Native coverage for existing tabular threads plus the explicitly declared
// custom-profile recipe mode. No user model or saved document is used.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_THREAD_TEST_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:thread-method:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'thread-method';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-thread-method-report.json');
const targetOperations = ['thread.catalog', 'thread.custom-profile', 'thread.pair-check', 'model.thread'];
const report = {
  suite: 'thread-method', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Fresh unsaved document; native cosmetic ThreadFeature is tested when the installed table accepts the exact selector, and custom profile is explicitly checked as recipe-only/no geometry.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;
let body;
let currentCase = 'thread-fixture-setup';

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
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_THREAD '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_THREAD '.length)); }
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
print('LIVE_THREAD ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during thread method coverage.');
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
print('LIVE_THREAD ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
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
    const cylinder = cad('shape.cylinder', { name: 'ThreadCylinder', radius: '5 mm', height: '20 mm' });
    check('shape.cylinder', 'one cylindrical fixture body returned', cylinder.bodies.length, 1);
    validated('shape.cylinder');
    body = cylinder.bodies[0];
    const face = cad('entity.find', { kind: 'face', filters: { geometry: 'cylinder', radius: '5 mm' }, unique: true });
    check('entity.find', 'one exact outer cylindrical face selected', face.kind, 'face');
    validated('entity.find');

    const volumeBefore = cad('measure.volume', { ref: body, units: 'mm3' });
    validated('measure.volume');
    const featuresBefore = cad('entity.list', { kind: 'feature' });
    validated('entity.list');

    currentCase = 'thread-catalog-custom-profile-and-pair-check';
    const catalogResult = cad('thread.catalog', { schemaVersion: 1, frame: 'component',
      system: 'iso-metric-coarse', query: 'M10x1.5', starts: 2 });
    check('thread.catalog', 'curated query returns exactly M10x1.5', catalogResult.entries.length, 1);
    check('thread.catalog', 'catalog result identifies the curated ISO subset', catalogResult.curated, true);
    check('thread.catalog', 'multi-start lead equals two starts times 1.5 mm pitch', catalogResult.entries[0].lead.value, 3, 1e-9);
    validated('thread.catalog');

    const custom = cad('thread.custom-profile', { schemaVersion: 1, frame: 'component', majorDiameter: '10 mm',
      minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 2, hand: 'left', flankAngle: '60 deg',
      rootShape: 'rounded', length: '12 mm', runout: '0.5 mm', clearance: '0.1 mm' });
    check('thread.custom-profile', 'custom profile is explicitly a recipe', custom.representation, 'recipe');
    check('thread.custom-profile', 'custom profile lead is 3 mm', custom.profile.lead.value, 3, 1e-9);
    check('thread.custom-profile', 'custom profile has 0.92 mm radial depth', custom.profile.depth.value, 0.92, 1e-9);
    check('thread.custom-profile', 'custom profile retains left hand and rounded root',
      custom.profile.hand + '|' + custom.profile.rootShape, 'left|rounded');
    check('thread.custom-profile', 'turns-per-length is separate from lead', custom.profile.turnsPerLength.value, 1 / 3, 1e-9);
    validated('thread.custom-profile');

    const pair = cad('thread.pair-check', { schemaVersion: 1, frame: 'component',
      external: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 1, hand: 'right' },
      internal: { majorDiameter: '10 mm', minorDiameter: '8.38 mm', pitch: '1.5 mm', starts: 1, hand: 'right' } });
    check('thread.pair-check', 'matching ISO-style thread pair fits', pair.pairFit, 'pass');
    check('thread.pair-check', 'hand, lead, starts, radial fit and engagement checks pass',
      pair.checks.every(item => item.status === 'pass'), true);
    check('thread.pair-check', 'radial engagement depth is 0.81 mm', pair.engagementDepth.value, 0.81, 1e-9);
    check('thread.pair-check', '60-degree profile is identified as ISO-style V', pair.crossSection.type, 'ISO-style 60-degree V');
    validated('thread.pair-check');
    report.tests.push({ name: currentCase, status: 'pass', operations: targetOperations.slice(0, 3) });

    currentCase = 'custom-thread-profile-recipe-no-geometry';
    const beforeRecipe = cad('entity.list', { kind: 'feature' });
    const recipe = cad('model.thread', { name: 'ThreadRecipe', faces: [face], internal: false,
      profile: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 2, hand: 'left',
        flankAngle: '60 deg', rootShape: 'rounded', runout: '0.5 mm', clearance: '0.1 mm' }, length: '12 mm' });
    check('model.thread', 'custom-profile branch returns recipe representation', recipe.representation, 'recipe');
    check('model.thread', 'custom-profile branch does not claim a native feature', recipe.feature, null);
    check('model.thread', 'custom-profile recipe lead equals starts × pitch', recipe.lead.value, 3, 1e-8);
    check('model.thread', 'custom-profile recipe preserves left hand', recipe.hand, 'left');
    check('model.thread', 'custom-profile depth equals half major-minus-minor diameter', recipe.profile.depth.value, 0.92, 1e-8);
    check('model.thread', 'custom-profile length is returned in mm', recipe.length.value, 12, 1e-8);
    check('model.thread', 'custom-profile notes the native helical-tooth limitation',
      recipe.note.includes('no persistent Coil/helical-path API'), true);
    validated('model.thread');
    const afterRecipe = cad('entity.list', { kind: 'feature' });
    check('entity.list', 'recipe branch creates no additional native feature', afterRecipe.entities.length, beforeRecipe.entities.length);
    validated('entity.list');
    const recipeVolume = cad('measure.volume', { ref: body, units: 'mm3' });
    check('measure.volume', 'recipe branch leaves native cylinder volume unchanged', recipeVolume.value, volumeBefore.value, 0.001);
    validated('measure.volume');
    report.tests.push({ name: 'custom-thread-profile-recipe-no-geometry', status: 'pass', operations: ['model.thread'] });

    currentCase = 'native-tabular-cosmetic-thread';
    const tabular = cad('model.thread', { name: 'TabularM10', faces: [face], internal: false,
      threadType: 'ISO Metric profile', designation: 'M10x1.5', class: '6g', modeled: false, rightHanded: true });
    check('model.thread', 'tabular thread returns a feature reference', tabular.feature?.kind, 'feature');
    validated('model.thread');
    const featureReadback = cad('entity.list', { kind: 'feature' });
    check('entity.list', 'tabular thread adds one feature to the timeline', featureReadback.entities.length, featuresBefore.entities.length + 1);
    check('entity.list', 'cosmetic tabular thread is present in feature history',
      featureReadback.entities.some(item => item.name === 'TabularM10'), true);
    validated('entity.list');
    const volumeAfter = cad('measure.volume', { ref: body, units: 'mm3' });
    check('measure.volume', 'cosmetic thread preserves BRep volume', volumeAfter.value, volumeBefore.value, 0.001);
    validated('measure.volume');
    report.tests.push({ name: 'native-tabular-cosmetic-thread', status: 'pass', operations: ['model.thread'] });
  } catch (error) {
    failure ||= error;
    report.tests.push({ name: currentCase, status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
      operations: ['model.thread'], error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) });
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
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned thread fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  report.operationCoverage = [...targetOperations, 'shape.cylinder', 'entity.find', 'measure.volume', 'entity.list'].map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-thread-method.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests.some(row => row.status !== 'pass') || report.finalAuditError ||
      (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL model.thread: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS model.thread tabular and custom recipe assertions');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'thread-suite-setup', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
    error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...targetOperations, 'shape.cylinder', 'entity.find', 'measure.volume', 'entity.list'].map(operation => ({
    operation, canonical: true, test: 'tests/live-thread-method.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL model.thread: ' + error.stack);
  process.exitCode = 1;
});
