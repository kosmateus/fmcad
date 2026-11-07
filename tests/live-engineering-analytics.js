'use strict';

// Native-path measurements and declared analytic checks in one new unsaved
// fixture. No user document, cloud file, or saved model is read or changed.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_ANALYTICS_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:engineering-analytics:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'engineering-analytics';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-engineering-analytics-report.json');
const targetOperations = ['entity.stats', 'measure.area', 'measure.angle', 'measure.distance', 'measure.length',
  'measure.draft', 'measure.region', 'measure.corridor', 'measure.wall-map', 'cam.profile', 'cam.evaluate', 'cam.cycle-check',
  'assembly.sequence', 'service.path-check', 'tool.access', 'fixture.access', 'snapshot', 'diff', 'status', 'report',
  'audit', 'check', 'assembly.motion_check', 'frame.context_audit', 'seal.profile', 'seal.gland', 'seal.evaluate',
  'dock.sequence-check', 'shape.helix', 'optics.frustum', 'optics.coverage', 'optics.occlusion', 'sensor.alignment-check',
  'mount.check', 'fastener.stack', 'fastener.check', 'fastener.schedule', 'bearing.stack-check', 'shaft.interface',
  'retention.bayonet', 'snap.define', 'snap.evaluate', 'gear.pair-check', 'datum.frame', 'datum.transform',
  'datum.plane-on-path', 'motion.envelope', 'clearance.grid', 'connector.mate-check', 'keepout.check',
  'feature.dependencies', 'pack.cross-section', 'port.define', 'undercut.check'];
const report = {
  suite: 'engineering-analytics', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Fresh unsaved document with synthetic BRep boxes; BRep measurements/snapshot readbacks and temporary motion samples are native, while declared DFM/occupancy/cam/service/access profiles remain explicitly analytic.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;
let body;

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
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_MEASURE '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_MEASURE '.length)); }
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
print('LIVE_MEASURE ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during measurement coverage.');
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

function cad(operation, data, mutating = !catalog[operation]?.readOnly, component = 'root') {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  validateCad(operation, data);
  if (mutating) guard();
  const row = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--component', component, '--data', JSON.stringify(data), '--json']);
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

function validated(operation, allInvocations = false) {
  const methods = report.methodResults.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(methods.length, operation + ' has no native invocation to validate.');
  for (const method of allInvocations ? methods : [methods.at(-1)]) method.status = 'pass';
  persist();
}

function runCase(name, operations, fn, requiresBody = true) {
  if ((requiresBody && !body) || uncertain || blockedReason) {
    report.tests.push({ name, status: uncertain ? 'unknown' : 'not-run', operations,
      reason: blockedReason || (uncertain ? 'Earlier operation outcome is uncertain; stop without replay.' : 'Native BRep fixture creation failed.') });
    persist();
    return;
  }
  try {
    fn();
    report.tests.push({ name, status: 'pass', operations });
  } catch (error) {
    failure ||= error;
    report.tests.push({ name, status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
      operations, error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) });
  }
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
print('LIVE_MEASURE ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
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
    const made = cad('shape.box', { name: 'MeasurementBlock', width: '10 mm', depth: '20 mm', height: '30 mm' });
    check('shape.box', 'one isolated measurement body created', made.bodies.length, 1);
    validated('shape.box');
    body = made.bodies[0];
    report.tests.push({ name: 'isolated-measurement-fixture', status: 'pass', operations: ['shape.box'] });
    persist();
  } catch (error) {
    failure = error;
    report.tests.push({ name: 'isolated-measurement-fixture', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
      operations: ['shape.box'], error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) });
  }

  runCase('native-face-area', ['entity.find', 'measure.area'], () => {
    const top = cad('entity.find', { kind: 'face', filters: { geometry: 'plane', axis: [0, 0, 1],
      position: ['0 mm', '0 mm', '30 mm'] }, unique: true });
    check('entity.find', 'top planar face resolved', top.kind, 'face');
    validated('entity.find');
    const area = cad('measure.area', { ref: top, units: 'mm2' });
    check('measure.area', '10×20 mm top-face area', area.value, 200, 0.001);
    check('measure.area', 'area units are mm2', area.units, 'mm2');
    validated('measure.area');
  });

  runCase('native-topology-statistics', ['entity.stats'], () => {
    const stats = cad('entity.stats', { kind: 'face', filters: { geometry: 'plane' }, expect: 6, groupBy: ['geometry'] });
    check('entity.stats', 'six planar BRep faces are counted', stats.count, 6);
    check('entity.stats', 'declared face-count expectation passes', stats.expect.passed, true);
    check('entity.stats', 'all six face areas are measured', stats.statistics.area.count, 6);
    check('entity.stats', 'native box total surface area in cm2', stats.statistics.area.sum, 22, 1e-7);
    check('entity.stats', 'all planar face area results are present', stats.statistics.area.missing, 0);
    check('entity.stats', 'geometry grouping returns one plane group with six members',
      stats.groups.length === 1 && stats.groups[0].count === 6, true);
    validated('entity.stats');
  });

  runCase('native-model-parameter-dependency-readback', ['feature.dependencies'], () => {
    const dependencies = cad('feature.dependencies', {});
    check('feature.dependencies', 'coverage is explicitly partial, not a complete feature DAG', dependencies.coverage, 'partial');
    check('feature.dependencies', 'native box model parameters are enumerated', dependencies.parameters.length > 0, true);
    check('feature.dependencies', 'every returned row identifies expression and unavailable-or-read dependency lists',
      dependencies.parameters.every(row => typeof row.name === 'string' && typeof row.expression === 'string' &&
        (Array.isArray(row.dependsOn) || row.dependsOn === null) &&
        (Array.isArray(row.usedByParameters) || row.usedByParameters === null)), true);
    check('feature.dependencies', 'known limitations explain partial dependency coverage',
      dependencies.limitations.some(item => item.includes('not every feature')), true);
    validated('feature.dependencies');
  });

  runCase('snapshot-diff-status-audit-and-check-report', ['snapshot', 'diff', 'status', 'audit', 'check', 'report'], () => {
    const before = cad('snapshot', {});
    check('snapshot', 'snapshot uses the documented v1 schema', before.schema, 'fmcad.measure.snapshot.v1');
    check('snapshot', 'initial snapshot includes the native fixture body', before.counts.bodyDefinitions, 1);
    validated('snapshot');

    const audit = cad('audit', {});
    check('audit', 'audit reports the same native body-definition count', audit.counts.bodyDefinitions, 1);
    check('audit', 'audit returns a full versioned observation', audit.schema, 'fmcad.measure.snapshot.v1');
    validated('audit');

    const status = cad('status', {});
    check('status', 'observed status never claims acceptance', status.acceptance, 'notEvaluated');
    check('status', 'status body-definition count matches the snapshot', status.counts.bodyDefinitions, 1);
    validated('status');

    const checked = cad('check', { id: 'box-volume', source: 'declared-analytic-fixture',
      measurement: { operation: 'measure.volume', data: { ref: body, units: 'mm3' } },
      expected: '6000 mm3', tolerance: '0.01 mm3' });
    check('check', 'scalar volume check passes the exact 10×20×30 mm body', checked.passed, true);
    check('check', 'check returns its caller requirement ID and evidence label',
      checked.id + '|' + checked.source, 'box-volume|declared-analytic-fixture');
    check('check', 'nested measured value is 6000 mm3', checked.actual.value, 6000, 0.01);
    validated('check');

    const reportResult = cad('report', { checks: [{ measurement: { operation: 'measure.volume', data: { ref: body, units: 'mm3' } },
      min: '5999 mm3' }], metadata: { reviewer: 'coverage-test' } });
    check('report', 'report evaluates the supplied scalar check', reportResult.checkOutcome, 'pass');
    check('report', 'reported observed status remains not-evaluated', reportResult.status.acceptance, 'notEvaluated');
    check('report', 'user metadata is preserved but not treated as verified', reportResult.metadataVerified, false);
    check('report', 'user metadata is returned verbatim', reportResult.userMetadata.reviewer, 'coverage-test');
    validated('report');

    cad('shape.box', { name: 'SnapshotSecondBody', width: '2 mm', depth: '3 mm', height: '4 mm' });
    validated('shape.box');
    const after = cad('snapshot', {});
    check('snapshot', 'second native snapshot observes the added body', after.counts.bodyDefinitions, 2);
    validated('snapshot');
    const difference = cad('diff', { before, after });
    check('diff', 'structural snapshot diff detects the body addition', difference.changed, true);
    check('diff', 'diff identifies an added BRep body entry',
      difference.changes.some(item => item.path.includes('/bodies') && item.change === 'added'), true);
    validated('diff');
  });

  runCase('native-finite-edge-length', ['entity.find', 'measure.length'], () => {
    const edges = cad('entity.find', { kind: 'edge', filters: { geometry: 'line', axis: [1, 0, 0], length: '10 mm' }, expect: 4 });
    check('entity.find', 'four horizontal 10 mm BRep edges found', edges.entities.length, 4);
    validated('entity.find');
    const length = cad('measure.length', { ref: edges.entities[0], units: 'mm' });
    check('measure.length', 'native finite edge length', length.value, 10, 0.001);
    check('measure.length', 'length units are mm', length.units, 'mm');
    validated('measure.length');
  });

  runCase('native-angle-and-distance-modes', ['measure.angle', 'entity.find', 'measure.distance'], () => {
    const angle = cad('measure.angle', { a: 'X', b: 'Y', units: 'deg' });
    check('measure.angle', 'Fusion angle between root X and Y axes', angle.value, 90, 0.001);
    check('measure.angle', 'angle units are degrees', angle.units, 'deg');
    validated('measure.angle');

    const bottom = cad('entity.find', { kind: 'face', filters: { geometry: 'plane', axis: [0, 0, 1],
      position: ['0 mm', '0 mm', '0 mm'] }, unique: true });
    check('entity.find', 'bottom planar face resolved', bottom.kind, 'face');
    const top = cad('entity.find', { kind: 'face', filters: { geometry: 'plane', axis: [0, 0, 1],
      position: ['0 mm', '0 mm', '30 mm'] }, unique: true });
    check('entity.find', 'top planar face resolved', top.kind, 'face');
    validated('entity.find', true);
    const minimum = cad('measure.distance', { a: bottom, b: top, mode: 'minimum', units: 'mm' });
    check('measure.distance', 'minimum distance between parallel box faces', minimum.value, 30, 0.001);
    const projected = cad('measure.distance', { a: ['1 mm', '2 mm', '0 mm'], b: ['4 mm', '6 mm', '0 mm'],
      mode: 'projected', direction: [0, 1, 0], space: 'component local', units: 'mm' });
    check('measure.distance', 'unsigned Y-projected point separation', projected.value, 4, 0.001);
    const axial = cad('measure.distance', { a: ['4 mm', '6 mm', '0 mm'], b: ['1 mm', '2 mm', '0 mm'],
      mode: 'axial', direction: [1, 0, 0], space: 'component local', units: 'mm' });
    check('measure.distance', 'signed reversed X-axial separation', axial.value, -3, 0.001);
    validated('measure.distance', true);
  });

  runCase('declared-analytic-draft-region-corridor-and-wall-map',
    ['measure.draft', 'measure.region', 'measure.corridor', 'measure.wall-map'], () => {
      const radians = 5 * Math.PI / 180;
      const draft = cad('measure.draft', { schemaVersion: 1,
        faces: [
          { name: 'five-degree-wall', point: ['0 mm', '0 mm', '0 mm'], normal: [Math.cos(radians), 0, Math.sin(radians)] },
          { name: 'zero-draft-wall', point: ['0 mm', '0 mm', '0 mm'], normal: [1, 0, 0] },
        ], pullDirections: [{ name: 'eject', axis: [0, 0, 1] }], minDraft: '4 deg', pullWallWindow: '10 deg' });
      check('measure.draft', 'five-degree sample is preserved', draft.draftMap[0].signedDraft, 5, 1e-6);
      check('measure.draft', 'zero-draft pull wall is flagged', draft.draftMap[1].draftViolation, true);
      check('measure.draft', 'analytic violation count', draft.violationCount, 1);
      check('measure.draft', 'demoldability summary reflects draft violation', draft.demoldableByDraft, false);
      validated('measure.draft');

      const region = cad('measure.region', { schemaVersion: 1,
        region: { type: 'box', min: ['0 mm', '0 mm', '0 mm'], max: ['10 mm', '10 mm', '10 mm'] },
        occupants: [
          { name: 'inside-sphere', point: ['5 mm', '5 mm', '5 mm'], radius: '2 mm' },
          { name: 'outside-sphere', point: ['12 mm', '5 mm', '5 mm'], radius: '1 mm' },
        ], sections: [{ z: '5 mm' }], samplingBudget: 20000 });
      check('measure.region', 'occupant count', region.occupantCount, 2);
      check('measure.region', 'only the centered sphere is inside the box', region.occupiedCount, 1);
      check('measure.region', 'outside signed distance is −0.2 cm', region.occupancy[1].signedDistance, -0.2, 1e-9);
      check('measure.region', 'section includes the in-box sphere', region.sections[0].occupantCount, 1);
      check('measure.region', 'deterministic section area estimates one radius-0.2 cm disk',
        region.sections[0].occupiedUnionArea > 0.10 && region.sections[0].occupiedUnionArea < 0.15, true);
      validated('measure.region');

      const corridor = cad('measure.corridor', { schemaVersion: 1,
        path: [['0 mm', '0 mm', '0 mm'], ['20 mm', '0 mm', '0 mm']], radius: '2 mm',
        obstacles: [{ name: 'near', point: ['3 mm', '0 mm', '0 mm'] }, { name: 'clear', point: ['10 mm', '5 mm', '0 mm'] }],
        minimumClearance: '1.5 mm', sections: [{ station: '10 mm' }] });
      check('measure.corridor', 'centerline arc length in cm', corridor.arcLength, 2, 1e-9);
      check('measure.corridor', 'one obstacle intrudes minimum clearance', corridor.intrusions, 1);
      check('measure.corridor', 'near-obstacle clearance in cm', corridor.occupancy[0].clearance, 0.1, 1e-9);
      check('measure.corridor', 'clear obstacle is not an intrusion', corridor.occupancy[1].intrudes, false);
      check('measure.corridor', 'section position at 10 mm station in cm', corridor.sections[0].position[0], 1, 1e-9);
      validated('measure.corridor');

      const wall = cad('measure.wall-map', { schemaVersion: 1,
        samples: [
          { name: 'solid', point: ['0 mm', '0 mm', '0 mm'], thickness: '2 mm', continuity: 'solid' },
          { name: 'thin', point: ['0 mm', '0 mm', '0 mm'], thickness: '0.5 mm', continuity: 'solid' },
          { name: 'void-backed', point: ['0 mm', '0 mm', '0 mm'], thickness: '8 mm', continuity: 'void' },
        ], minThickness: '1 mm', maxThickness: '4 mm' });
      check('measure.wall-map', 'three declared wall samples returned', wall.wallMap.length, 3);
      check('measure.wall-map', 'one solid sample is below the minimum thickness', wall.thinWallViolations.length, 1);
      check('measure.wall-map', 'void-backed sample is reported separately', wall.voidBackedSamples.length, 1);
      check('measure.wall-map', 'void-backed sample is not treated as thick material', wall.thickWallViolations.length, 0);
      check('measure.wall-map', 'solid material continuity is explicit', wall.materialContinuityChecked, true);
      validated('measure.wall-map');
    });

  runCase('analytic-cam-profile-and-limit-evaluation', ['cam.profile', 'cam.evaluate'], () => {
    const rise = { law: 'halfCosine', lift: '10 mm', angle: '240 deg' };
    const profile = cad('cam.profile', { schemaVersion: 1, frame: 'component', baseRadius: '15 mm',
      rollerRadius: '5 mm', rise, followerLine: [0, 1, 0], phase: '0 deg', direction: 'ccw' });
    check('cam.profile', 'normal-offset working profile contains 2001 native-frame samples', profile.pitchProfile.length, 2001);
    check('cam.profile', 'pitch-profile starts at the 15 mm base radius', profile.pitchProfile[0][0], 15, 1e-8);
    check('cam.profile', 'roller working profile returns the declared normal offset', profile.normalOffset.value, 5, 1e-8);
    check('cam.profile', 'release remains explicitly unresolved for rise-only input',
      profile.unresolvedIntervals.some(item => item.interval === 'release'), true);
    validated('cam.profile');

    const evaluated = cad('cam.evaluate', { schemaVersion: 1, frame: 'component', baseRadius: '15 mm',
      rollerRadius: '5 mm', rise, minimumCurvatureRadius: '0.1 mm', maximumPressureAngle: '89 deg' });
    check('cam.evaluate', 'curvature and pressure-angle limits both pass',
      evaluated.checks.every(item => item.status === 'pass'), true);
    check('cam.evaluate', 'maximum pressure angle is within the declared 89 deg limit',
      evaluated.maxPressureAngle.value <= 89, true);
    check('cam.evaluate', 'minimum pitch curvature meets the declared 0.1 mm limit',
      evaluated.minPitchCurvatureRadius.value >= 0.1, true);
    validated('cam.evaluate');
  }, false);

  runCase('explicit-cam-cycle-resolution', ['cam.cycle-check'], () => {
    const cycle = cad('cam.cycle-check', { schemaVersion: 1, frame: 'component',
      rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' }, dwell: '0 deg',
      returnLaw: 'spring-return', followerCoupling: 'spring-return' });
    check('cam.cycle-check', 'explicit rise/dwell/release intervals resolve', cycle.resolvedIntervals.join(','), 'rise,dwell,release');
    check('cam.cycle-check', 'cycle status passes after intervals are declared', cycle.cycleStatus, 'pass');
    check('cam.cycle-check', 'no declared interval remains unresolved', cycle.unresolvedIntervals.length, 0);
    check('cam.cycle-check', 'drop-edge dynamics remain explicitly blocked',
      cycle.dropEdgeDynamics, 'blocked (no proper definition or evidence)');
    validated('cam.cycle-check');
  }, false);

  runCase('assembly-sequence-dependency-and-service-order', ['assembly.sequence'], () => {
    const sequence = cad('assembly.sequence', { schemaVersion: 1,
      parts: ['base', 'connector', 'shaft', 'housing'],
      dependencies: [['base', 'connector'], ['connector', 'shaft'], ['shaft', 'housing']],
      removedParts: ['connector'],
      disconnectedMedia: [{ name: 'flexible-wire', connects: ['connector', 'shaft'] }],
      serviceStates: [{ part: 'connector', requires: [{ media: 'flexible-wire', state: 'disconnected' }] }],
      phases: [{ name: 'foundation', parts: ['base', 'connector'] }, { name: 'drive', parts: ['shaft', 'housing'] }] });
    check('assembly.sequence', 'topological assembly order', sequence.order.join(','), 'base,connector,shaft,housing');
    check('assembly.sequence', 'disassembly reverses the dependency order', sequence.disassemblyOrder.join(','), 'housing,shaft,connector,base');
    check('assembly.sequence', 'removed connector identifies its downstream blocker',
      sequence.removals[0].removeBlockers.join(','), 'shaft');
    check('assembly.sequence', 'flexible cable is a disconnection prerequisite, never rigidized',
      sequence.mediaRigidized, false);
    check('assembly.sequence', 'service prerequisites are retained',
      sequence.removals[0].servicePrerequisites.length, 1);
    check('assembly.sequence', 'part phase is retained', sequence.phaseAssignments.base, 'foundation');
    validated('assembly.sequence');
  }, false);

  runCase('sampled-service-withdrawal-clearance', ['service.path-check'], () => {
    const pathCheck = cad('service.path-check', { schemaVersion: 1,
      part: { name: 'bracket', outline: [['-10 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '20 mm'], ['-10 mm', '20 mm']] },
      direction: [0, 1], distance: '30 mm', minimumClearance: '4 mm', samples: 6,
      obstacles: [{ name: 'wall', outline: [['15 mm', '0 mm'], ['30 mm', '0 mm'], ['30 mm', '50 mm'], ['15 mm', '50 mm']] }] });
    check('service.path-check', 'sampled withdrawal is feasible with 4 mm minimum', pathCheck.feasible, true);
    check('service.path-check', 'the declared wall is not a blocker', pathCheck.blockers.length, 0);
    check('service.path-check', 'sampled minimum wall clearance in cm', pathCheck.minClearance, 0.5, 1e-9);
    check('service.path-check', 'swept bounds include translated part endpoint', pathCheck.sweptBounds.max[1], 5, 1e-9);
    validated('service.path-check');
  }, false);

  runCase('sampled-native-solid-motion-check', ['assembly.motion_check'], () => {
    const obstacle = cad('shape.box', { name: 'MotionObstacle', width: '1 mm', depth: '1 mm', height: '1 mm' }).bodies[0];
    validated('shape.box');
    const motion = cad('assembly.motion_check', { moving: body, obstacles: [obstacle], minimum: '1 mm',
      translations: [['0 mm', '0 mm', '0 mm'], ['0 mm', '0 mm', '40 mm']] });
    check('assembly.motion_check', 'two independently sampled translations are returned', motion.samples.length, 2);
    check('assembly.motion_check', 'initial pose detects positive-volume interference', motion.samples[0].checks[0].interferes, true);
    check('assembly.motion_check', '40 mm Z translation clears the obstacle', motion.samples[1].checks[0].clearancePassed, true);
    check('assembly.motion_check', 'motion output does not claim continuous collision proof', motion.continuousMotionVerified, false);
    check('assembly.motion_check', 'temporary samples do not change the live occurrence transform',
      motion.samples[1].translation.xyz[2], 40, 1e-9);
    validated('assembly.motion_check');
  });

  runCase('declared-bounds-motion-envelope', ['motion.envelope'], () => {
    const envelope = cad('motion.envelope', { schemaVersion: 1, frame: 'component',
      motion: { type: 'translation', axis: [1, 0, 0], from: '0 mm', to: '20 mm' },
      bounds: { min: ['0 mm', '0 mm', '0 mm'], max: ['10 mm', '20 mm', '30 mm'] },
      samples: 3, representation: 'conservative' });
    check('motion.envelope', 'translation envelope uses the conservative representation', envelope.representation, 'conservative');
    check('motion.envelope', 'three requested positions are sampled', envelope.sampleCount, 3);
    check('motion.envelope', 'conservative swept bounds extend to x=3 cm', envelope.conservativeEnvelope.max[0], 3, 1e-9);
    check('motion.envelope', 'unmoved extents remain y=0..2 cm and z=0..3 cm',
      envelope.conservativeEnvelope.max[1] + '|' + envelope.conservativeEnvelope.max[2], '2|3');
    check('motion.envelope', 'AABB envelope is not misreported as continuous body proof', envelope.continuousVerified, false);
    validated('motion.envelope');
  }, false);

  runCase('native-clearance-grid-expected-contact', ['clearance.grid'], () => {
    const left = cad('component.create', { name: 'GridLeft', placement: { translation: ['0 mm', '0 mm', '0 mm'] } });
    const right = cad('component.create', { name: 'GridRight', placement: { translation: ['12 mm', '0 mm', '0 mm'] } });
    validated('component.create', true);
    const leftBox = cad('shape.box', { name: 'GridLeftBody', width: '10 mm', depth: '10 mm', height: '10 mm' }, true, 'GridLeft');
    const rightBox = cad('shape.box', { name: 'GridRightBody', width: '10 mm', depth: '10 mm', height: '10 mm' }, true, 'GridRight');
    validated('shape.box', true);
    const a = { ...leftBox.bodies[0], occurrence: left.occurrence };
    const b = { ...rightBox.bodies[0], occurrence: right.occurrence };
    const grid = cad('clearance.grid', { schemaVersion: 1, frame: 'component',
      pairs: [{ a, b }], minimum: '1 mm', volumeTolerance: '0 mm3', budget: { maxChecks: 1 },
      expectedContacts: [{ a, b, cause: 'declared two-millimeter assembly gap', clearance: { min: '1.9 mm', max: '2.1 mm' } }] }, false);
    check('clearance.grid', 'one explicit body-instance pair is measured', grid.coverage.total, 1);
    check('clearance.grid', 'expected contact/readback passes its independent range',
      grid.results[0].expected && grid.results[0].passed && grid.results[0].status === 'tested', true);
    check('clearance.grid', 'native unsigned minimum gap is 2 mm', grid.results[0].distance.value, 2, 0.001);
    check('clearance.grid', 'separated bodies have zero positive-volume interference', grid.results[0].interferes, false);
    check('clearance.grid', 'grid reports sampled, not continuous, coverage', grid.coverage.continuousVerified, false);
    validated('clearance.grid');
  });

  runCase('declared-connector-keying-and-keepout', ['connector.mate-check', 'keepout.check'], () => {
    const mates = cad('connector.mate-check', { schemaVersion: 1,
      connectors: [
        { name: 'POWER_M', gender: 'male', pinCount: 4, key: 'power-key' },
        { name: 'POWER_F', gender: 'female', pinCount: 4, key: 'power-key' },
        { name: 'DATA_F', gender: 'female', pinCount: 4, key: 'data-key' },
      ], intendedPairs: [['POWER_M', 'POWER_F']], forbiddenPairs: [['POWER_M', 'DATA_F']] });
    check('connector.mate-check', 'intended complementary keyed pair mates', mates.intended[0].mates, true);
    check('connector.mate-check', 'different forbidden key cannot reach seating orientation',
      mates.forbidden[0].canReachSeating, false);
    check('connector.mate-check', 'declared poka-yoke set passes', mates.passed, true);
    validated('connector.mate-check');

    const keepout = cad('keepout.check', { schemaVersion: 1,
      board: { outline: [['0 mm', '0 mm'], ['20 mm', '0 mm'], ['20 mm', '20 mm'], ['0 mm', '20 mm']] },
      keepouts: [{ name: 'K1', outline: [['2 mm', '2 mm'], ['8 mm', '2 mm'], ['8 mm', '8 mm'], ['2 mm', '8 mm']] }] });
    check('keepout.check', 'fully contained copper keepout passes board geometry check', keepout.passed, true);
    check('keepout.check', 'no declared keepout violations are present', keepout.violations.length, 0);
    validated('keepout.check');
  }, false);

  runCase('declared-pcb-packing-port-and-undercut', ['pack.cross-section', 'port.define', 'undercut.check'], () => {
    const pack = cad('pack.cross-section', { schemaVersion: 1,
      cavity: [['0 mm', '0 mm'], ['10 mm', '0 mm'], ['10 mm', '10 mm'], ['0 mm', '10 mm']],
      items: [{ center: ['5 mm', '5 mm', '0 mm'], radius: '2 mm' }], reserve: 0.3, samplingBudget: 10000 });
    check('pack.cross-section', 'centered circular part fits the declared square cavity', pack.passed, true);
    check('pack.cross-section', 'reserve denominator is the cavity area', pack.reserve.denominator, 'cavity area');
    check('pack.cross-section', 'grid union area approximates the radius-2 mm disk',
      pack.occupiedUnionArea > 0.12 && pack.occupiedUnionArea < 0.13, true);
    check('pack.cross-section', 'required 30 percent reserve remains available', pack.reserve.actual >= 0.3, true);
    validated('pack.cross-section');

    const port = cad('port.define', { schemaVersion: 1, name: 'AnalyticsPort',
      frame: { origin: ['1 mm', '2 mm', '3 mm'], normal: [0, 0, 2], pin1: ['3 mm', '2 mm', '3 mm'] },
      key: 'PWR-A', matingStroke: '5 mm', supportZones: [{ name: 'body-support' }] });
    check('port.define', 'caller port name and key are preserved', port.name + '|' + port.key, 'AnalyticsPort|PWR-A');
    [0.1, 0.2, 0.3].forEach((value, index) => check('port.define', 'origin cm coordinate ' + index, port.origin[index], value, 1e-9));
    [0, 0, 1].forEach((value, index) => check('port.define', 'normalized direction component ' + index, port.normal[index], value, 1e-9));
    check('port.define', 'mating stroke is returned in centimeters', port.matingStroke, 0.5, 1e-9);
    validated('port.define');

    const undercut = cad('undercut.check', { schemaVersion: 1,
      faces: [{ name: 'draftable-side', point: ['0 mm', '0 mm', '5 mm'], normal: [0, 0, 1] }],
      pullDirections: [{ name: 'eject', axis: [0, 0, 1] }], undercutThreshold: '3 deg' });
    check('undercut.check', 'face normal aligned with pull has no undercut', undercut.passed, true);
    check('undercut.check', 'no undercut records are returned', undercut.undercutCount, 0);
    check('undercut.check', 'directional method does not claim broader draft certification', undercut.demoldableIsNotDraftAlone, true);
    validated('undercut.check');
  }, false);

  runCase('root-body-context-audit-with-independent-datum', ['frame.context_audit'], () => {
    const audit = cad('frame.context_audit', { ref: body, sourceId: 'measurement-block-v1', instance: [],
      datumToRoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      datumSource: { kind: 'independent-analytic-placement', version: 1 } });
    check('frame.context_audit', 'root body datum, native-chain and proxy transforms agree', audit.status, 'pass');
    check('frame.context_audit', 'no frame or sampled point mismatch is reported', audit.failures.length, 0);
    check('frame.context_audit', 'independent root BRep vertex witnesses were compared', audit.witnessCount > 0, true);
    check('frame.context_audit', 'sampled witness check does not claim exact BRep equivalence', audit.exactBRepEquivalence, false);
    check('frame.context_audit', 'caller-owned source identity is returned', audit.observation.source.id, 'measurement-block-v1');
    check('frame.context_audit', 'independent provenance is returned',
      audit.observation.datumSource.kind + '|' + audit.observation.datumSource.version, 'independent-analytic-placement|1');
    validated('frame.context_audit');
  }, false);

  runCase('declared-seal-profile-gland-evaluation-and-dock-order',
    ['seal.profile', 'seal.gland', 'seal.evaluate', 'dock.sequence-check'], () => {
      const profile = cad('seal.profile', { schemaVersion: 1, frame: 'component', layout: 'gasket',
        crossSection: { shape: 'custom', points: [['0 mm', '0 mm'], ['2 mm', '0 mm'], ['2 mm', '1.5 mm'],
          ['0 mm', '1.5 mm'], ['0 mm', '0 mm']] }, path: { closed: true, length: '80 mm' } });
      check('seal.profile', 'closed custom gasket is not mislabeled as a plain O-ring',
        profile.crossSection.isPlainORing, false);
      check('seal.profile', 'closed cross-section and sweep path are explicitly observed',
        profile.crossSection.continuity.closed && profile.envelope.closed, true);
      check('seal.profile', 'declared gasket path length is 80 mm', profile.envelope.length.value, 80, 1e-9);
      validated('seal.profile');

      const gland = cad('seal.gland', { schemaVersion: 1, frame: 'component', type: 'radial',
        oRing: { id: '10 mm', cs: '2 mm' }, squeeze: 0.15, hardStop: { clearance: '0.05 mm' } });
      check('seal.gland', 'nominal target squeeze is 15 percent', gland.squeeze.nominal, 0.15, 1e-9);
      check('seal.gland', 'default width targets 75 percent nominal fill', gland.fill.nominal, 0.75, 1e-9);
      check('seal.gland', 'squeeze, fill and hard-stop checks pass', gland.checks.every(item => item.status === 'pass'), true);
      check('seal.gland', 'positive metallic hard stop is reported engaged', gland.hardStop.engaged, true);
      validated('seal.gland');

      const evaluated = cad('seal.evaluate', { schemaVersion: 1, frame: 'component', type: 'radial',
        oRing: { id: '10 mm', cs: '2 mm' }, gland: { depth: '1.7 mm', width: '2.4 mm' },
        gap: '0.1 mm', extrusionGapLimit: '0.2 mm', hardStop: { clearance: '0.05 mm' } });
      check('seal.evaluate', 'installed squeeze equals 15 percent', evaluated.squeeze, 0.15, 1e-9);
      check('seal.evaluate', 'explicit extrusion-gap limit passes',
        evaluated.checks.find(item => item.check === 'extrusion-gap').status, 'pass');
      check('seal.evaluate', 'gland-volume and hard-stop checks pass',
        evaluated.checks.filter(item => ['gland-volume', 'hard-stop'].includes(item.check)).every(item => item.status === 'pass'), true);
      check('seal.evaluate', 'evaluation remains geometric, not a sealing certification',
        evaluated.installedEnvelope.includes('no material/sealing solution'), true);
      validated('seal.evaluate');

      const dock = cad('dock.sequence-check', { schemaVersion: 1, frame: 'component',
        connect: [{ event: 'lead-in', at: '0 mm' }, { event: 'locator-engage', at: '2 mm' },
          { event: 'seal-contact', at: '4 mm' }, { event: 'valve-open', at: '4.6 mm' },
          { event: 'both-valve-open', at: '5 mm' }],
        disconnect: [{ event: 'valve-close', at: '0 mm' }, { event: 'both-valves-closed', at: '0.2 mm' },
          { event: 'seal-contact', at: '1 mm' }, { event: 'locator-release', at: '2 mm' },
          { event: 'lead-out', at: '3 mm' }],
        axialTolerance: '0.05 mm', float: '0.1 mm', locatorTolerance: '0.05 mm', minimumSealBeforeOpen: '0.4 mm' });
      check('dock.sequence-check', 'worst-case seal-before-open margin meets 0.4 mm', dock.worstCaseMargin.value, 0.4, 1e-9);
      check('dock.sequence-check', 'second valve-open evidence is present',
        dock.checks.find(item => item.check === 'both-valve-open').status, 'pass');
      check('dock.sequence-check', 'disconnect retains the seal until after valve closure',
        dock.checks.find(item => item.check === 'seal-after-close').margin.value, 1, 1e-9);
      validated('dock.sequence-check');
    }, false);

  runCase('sampled-helix-recipe-without-native-coil', ['shape.helix', 'snapshot'], () => {
    const before = cad('snapshot', {});
    validated('snapshot');
    const helix = cad('shape.helix', { schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm',
      turns: 8, hand: 'right', startPhase: '0 deg', tolerance: '0.01 mm' });
    check('shape.helix', 'generated helix is explicitly a sampled recipe', helix.representation, 'recipe');
    check('shape.helix', 'recipe does not claim a native Coil', helix.nativeCoil, false);
    check('shape.helix', 'sample count matches the returned point count', helix.sampleCount, helix.samplePoints.length);
    const first = helix.samplePoints[0];
    const firstRadius = Math.hypot(first[0].value, first[1].value);
    check('shape.helix', 'first sample lies at the declared 4 mm radius', firstRadius, 4, 1e-8);
    check('shape.helix', 'last sample reaches the declared 46 mm axial height',
      helix.samplePoints.at(-1)[2].value, 46, 1e-8);
    validated('shape.helix');
    const after = cad('snapshot', {});
    check('snapshot', 'recipe-only helix creates no persistent BRep body',
      after.counts.bodyDefinitions, before.counts.bodyDefinitions);
    validated('snapshot');
  }, false);

  runCase('declared-optical-frustum-coverage-and-occlusion',
    ['optics.frustum', 'optics.coverage', 'optics.occlusion', 'sensor.alignment-check'], () => {
      const frustum = cad('optics.frustum', { schemaVersion: 1,
        pupil: { origin: ['0 mm', '0 mm', '0 mm'], direction: [0, 0, 1], up: [0, 1, 0] },
        fov: { horizontal: '60 deg', vertical: '40 deg' }, ranges: { near: '10 mm', far: '100 mm' },
        window: { distance: '50 mm', width: '20 mm', height: '20 mm' } });
      check('optics.frustum', 'declared rectangular aperture limits the frustum', frustum.windowLimited, true);
      check('optics.frustum', 'window-limited horizontal half-angle is atan(0.2)',
        frustum.effectiveHalfAngles.horizontal, Math.atan(0.2), 1e-9);
      check('optics.frustum', 'window-limited vertical half-angle is atan(0.2)',
        frustum.effectiveHalfAngles.vertical, Math.atan(0.2), 1e-9);
      check('optics.frustum', 'near/far clip distances return in centimeters',
        frustum.ranges.near + '|' + frustum.ranges.far, '1|10');
      check('optics.frustum', 'clipped far half-width returns 2 mm in cm',
        frustum.clippedCorners.far[0][0], 0.2, 1e-9);
      validated('optics.frustum');

      const coverage = cad('optics.coverage', { schemaVersion: 1, samplingBudget: 400,
        sensors: [{ name: 'overhead', pupil: { origin: ['0 mm', '0 mm', '30 mm'], direction: [0, 0, -1], up: [0, 1, 0] },
          fov: { horizontal: '90 deg', vertical: '90 deg' }, ranges: { near: '1 mm', far: '100 mm' } }],
        targets: [{ name: 'board', origin: ['0 mm', '0 mm', '0 mm'], normal: [0, 0, 1], u: [1, 0, 0],
          outline: [['-10 mm', '-10 mm'], ['10 mm', '-10 mm'], ['10 mm', '10 mm'], ['-10 mm', '10 mm']] }] });
      check('optics.coverage', 'one declared sensor covers the full small planar target',
        coverage.targets[0].coveredFraction, 1);
      check('optics.coverage', 'grid-estimated target area is 4 cm2', coverage.targets[0].outlineArea, 4, 1e-9);
      check('optics.coverage', 'all 400 target-grid samples are classified', coverage.targets[0].samples, 400);
      check('optics.coverage', 'coverage output remains explicitly deterministic-grid based',
        coverage.samplingBudget, 400);
      validated('optics.coverage');

      const occlusion = cad('optics.occlusion', { schemaVersion: 1,
        pupil: { origin: ['0 mm', '0 mm', '0 mm'] },
        rays: [{ target: ['0 mm', '0 mm', '50 mm'] }, { target: ['10 mm', '0 mm', '50 mm'] }],
        obstacles: [
          { name: 'baffle', kind: 'baffle', shape: { type: 'disk', origin: ['0 mm', '0 mm', '25 mm'], normal: [0, 0, 1], radius: '4 mm' } },
          { name: 'declared-window', kind: 'window', transmittance: 0.9,
            shape: { type: 'disk', origin: ['5 mm', '0 mm', '25 mm'], normal: [0, 0, 1], radius: '4 mm' } },
        ] });
      check('optics.occlusion', 'center ray is blocked by the opaque baffle', occlusion.rays[0].result, 'blocked');
      check('optics.occlusion', 'off-axis ray passes the declared transparent window', occlusion.rays[1].result, 'window');
      check('optics.occlusion', 'window transmittance is preserved', occlusion.rays[1].transmittance, 0.9);
      check('optics.occlusion', 'blocked/window/clear ray counts are explicit',
        [occlusion.blockedCount, occlusion.transparentCount, occlusion.clearCount].join('|'), '1|1|0');
      validated('optics.occlusion');

      const alignment = cad('sensor.alignment-check', { schemaVersion: 1,
        sensor: { name: 'sensor', origin: ['0 mm', '0 mm', '1 mm'], axis: [0, 0, 1] },
        reference: { name: 'datum', origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1] },
        limits: { angle: '1 deg', offset: '0.1 mm', gap: { min: '0 mm', max: '2 mm' } } });
      check('sensor.alignment-check', 'coaxial sensor axis passes declared limits', alignment.aligned, true);
      check('sensor.alignment-check', 'axis angle deviation is zero', alignment.angleDeviation, 0, 1e-9);
      check('sensor.alignment-check', 'lateral offset is zero', alignment.lateralOffset, 0, 1e-9);
      check('sensor.alignment-check', 'axial gap returns 0.1 cm', alignment.axialGap, 0.1, 1e-9);
      check('sensor.alignment-check', 'no forbidden-zone violations are returned', alignment.violations.length, 0);
      validated('sensor.alignment-check');
    }, false);

  runCase('declared-fastener-bearing-mount-and-shaft-analytics',
    ['mount.check', 'fastener.stack', 'fastener.check', 'fastener.schedule', 'bearing.stack-check',
      'shaft.interface', 'retention.bayonet', 'snap.define', 'snap.evaluate'], () => {
      const mount = cad('mount.check', { schemaVersion: 1, frame: 'component', scheme: 'pin-slot',
        holes: [{ diameter: '3 mm', clearance: '0.5 mm' }, { diameter: '3 mm', clearance: '0.5 mm' }],
        connector: { supported: true, supportPresent: true } });
      check('mount.check', 'pin-slot mount is not over-constrained', mount.overConstrained, false);
      check('mount.check', 'declared locating and connector-support checks pass',
        mount.checks.every(item => item.status === 'pass'), true);
      validated('mount.check');

      const stackInput = { schemaVersion: 1, frame: 'component',
        screw: { length: '12 mm', threadLength: '10 mm', headDiameter: '6 mm' },
        stack: [{ id: 'bracket', thickness: '4 mm' }, { id: 'pcb', thickness: '1.6 mm' }],
        receptacle: { kind: 'insert', depth: '8 mm' }, torque: '0.5 N*m', tool: { diameter: '5 mm' } };
      const stack = cad('fastener.stack', stackInput);
      check('fastener.stack', 'result status passes for a positive engagement stack', stack.status, 'pass');
      check('fastener.stack', 'clamped stack length is 5.6 mm', stack.clampedLength.value, 5.6, 1e-9);
      check('fastener.stack', 'thread engagement is 4.4 mm', stack.engagement.value, 4.4, 1e-9);
      check('fastener.stack', 'torque is reported as declared, not derived', stack.torqueStatus, 'declared');
      check('fastener.stack', 'insert bottoming clearance is 1.6 mm', stack.bottoming.clearance.value, 1.6, 1e-9);
      validated('fastener.stack');

      const checked = cad('fastener.check', { ...stackInput, minimumEngagement: '4 mm',
        receptacle: { kind: 'insert', depth: '8 mm' }, tool: { diameter: '4 mm', recess: '5 mm' } });
      check('fastener.check', 'declared fastener checks all pass',
        checked.checks.every(item => item.status === 'pass'), true);
      check('fastener.check', 'each requested fastener check reports pass',
        checked.checks.filter(item => ['engagement', 'bottoming', 'access'].includes(item.check)).every(item => item.status === 'pass'), true);
      validated('fastener.check');

      const schedule = cad('fastener.schedule', { schemaVersion: 1, frame: 'component', fasteners: [
        { id: 'M3-A', torque: '0.5 N*m', process: 'torque wrench', material: 'A2-70', vendor: 'VENDOR-A' },
        { id: 'M3-B', torque: '0.5 N*m', process: 'torque wrench', material: 'A2-70', vendor: 'VENDOR-A' },
      ] });
      check('fastener.schedule', 'two complete fasteners produce a passing schedule', schedule.status, 'pass');
      check('fastener.schedule', 'complete declared rows have no missing data', schedule.missingData.length, 0);
      validated('fastener.schedule');

      const bearing = cad('bearing.stack-check', { schemaVersion: 1, frame: 'component',
        rings: { inner: { bore: '10 mm' }, outer: { od: '26 mm' } }, journal: '10 mm', seat: '26 mm',
        shaftClearance: '0.005 mm', housingClearance: '0 mm', shoulder: { inner: true },
        arrangement: 'fixed-floating' });
      check('bearing.stack-check', 'inner ring is the declared fixed ring', bearing.fixedRing, 'inner');
      check('bearing.stack-check', 'no preload is fabricated', bearing.preload, 'none declared');
      check('bearing.stack-check', 'fixed-floating arrangement is preserved', bearing.arrangement, 'fixed-floating');
      validated('bearing.stack-check');

      const shaft = cad('shaft.interface', { schemaVersion: 1, frame: 'component',
        shaft: { type: 'D-flat', d: '6 mm', flat: { depth: '0.5 mm' } },
        hub: { bore: '6 mm', boreType: 'D-flat', splitClampGap: '0.8 mm', shoulders: [{}] } });
      check('shaft.interface', 'matching D-flat shaft and bore mate passes',
        shaft.checks.every(item => item.status === 'pass'), true);
      check('shaft.interface', 'D-flat mate is reported explicitly',
        shaft.matedFeatures.some(item => String(item).toLowerCase().includes('d-flat')), true);
      validated('shaft.interface');

      const bayonet = cad('retention.bayonet', { schemaVersion: 1, frame: 'component',
        lugs: { count: 3, width: '4 mm', height: '2 mm' }, stroke: '6 mm', rotation: '30 deg',
        capture: { depth: '1.5 mm' }, clearances: { radial: '0.2 mm' } });
      check('retention.bayonet', 'captured three-lug bayonet returns the declared path',
        bayonet.assemblyPath, 'insert -> rotate -> capture');
      check('retention.bayonet', 'capture depth is 1.5 mm', bayonet.checks.find(item => item.check === 'axial-capture').captureDepth.value, 1.5, 1e-9);
      validated('retention.bayonet');

      const snapInput = { schemaVersion: 1, frame: 'component',
        geometry: { length: '10 mm', width: '4 mm', thickness: '1 mm', engagementDepth: '0.6 mm', deflection: '0.6 mm' },
        material: { name: 'ABS', modulus: '2.1 GPa', yieldStrength: '40 MPa' }, support: { condition: 'cantilever' } };
      const definition = cad('snap.define', { ...snapInput, geometry: { ...snapInput.geometry } });
      check('snap.define', 'snap definition records its cantilever geometry', definition.shape,
        'cantilever beam snap with rectangular section');
      check('snap.define', 'material is caller-declared with no implicit default', definition.material.name, 'ABS');
      validated('snap.define');
      const snap = cad('snap.evaluate', snapInput);
      check('snap.evaluate', 'cantilever stiffness is 2.1 N/mm', snap.stiffness.value, 2.1, 1e-6);
      check('snap.evaluate', 'engagement force is 1.26 N', snap.engagementForce.value, 1.26, 1e-6);
      check('snap.evaluate', 'linear beam stress is 18.9 MPa', snap.stress.value, 18.9, 1e-6);
      check('snap.evaluate', 'declared yield-strength check passes',
        snap.checks.find(item => item.check === 'strain').status, 'pass');
      validated('snap.evaluate');
    }, false);

  runCase('declared-involute-gear-pair-check', ['gear.pair-check'], () => {
    const external = cad('gear.pair-check', { schemaVersion: 1,
      gear1: { module: '2 mm', teeth: 20, pressureAngle: '20 deg', backlashAllocation: '0.05 mm' },
      gear2: { module: '2 mm', teeth: 40, pressureAngle: '20 deg', toothThicknessReduction: '0.05 mm' },
      external: true, phase: 0.25 });
    check('gear.pair-check', 'external pair signed speed ratio is +2', external.ratio, 2, 1e-9);
    check('gear.pair-check', 'external nominal center distance is 6 cm', external.nominalCenterDistance, 6, 1e-9);
    check('gear.pair-check', 'external working angle is the declared 20 degrees', external.workingAngle, 20 * Math.PI / 180, 1e-9);
    check('gear.pair-check', 'backlash sums both declared allocations in cm', external.backlash, 0.01, 1e-9);
    check('gear.pair-check', 'independent tooth counts are returned', external.teeth.join(','), '20,40');
    validated('gear.pair-check');

    const internal = cad('gear.pair-check', { schemaVersion: 1,
      gear1: { module: '2 mm', teeth: 40, pressureAngle: '20 deg' },
      gear2: { module: '2 mm', teeth: 20, pressureAngle: '20 deg' },
      external: false, centerDistance: '20 mm' });
    check('gear.pair-check', 'internal pair signed speed ratio is −0.5', internal.ratio, -0.5, 1e-9);
    check('gear.pair-check', 'internal nominal center distance is 2 cm', internal.nominalCenterDistance, 2, 1e-9);
    check('gear.pair-check', 'internal center input is returned as 2 cm', internal.centerDistance, 2, 1e-9);
    check('gear.pair-check', 'internal working angle is derived from base diameters',
      internal.workingAngle, 20 * Math.PI / 180, 1e-9);
    validated('gear.pair-check');
  }, false);

  runCase('named-datum-frame-and-root-transform', ['datum.frame', 'datum.transform'], () => {
    const input = { name: 'AnalyticsFrame', origin: ['10 mm', '-20 mm', '30 mm'],
      xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
    const frame = cad('datum.frame', input);
    check('datum.frame', 'metadata frame kind is returned', frame.kind, 'frame');
    check('datum.frame', 'signed frame origin x is stored in cm', frame.matrix[3], 1, 1e-10);
    check('datum.frame', 'signed frame origin y is stored in cm', frame.matrix[7], -2, 1e-10);
    check('datum.frame', 'frame origin z is stored in cm', frame.matrix[11], 3, 1e-10);
    check('datum.frame', 'frame is explicitly a snapshot, not a native coordinate system', frame.associativity, 'snapshot');
    check('datum.frame', 'first metadata call creates the named frame', frame.changed, true);
    validated('datum.frame');

    const reused = cad('datum.frame', { ...input, onExisting: 'reuse' });
    check('datum.frame', 'identical reuse is an idempotent no-op', reused.changed, false);
    check('datum.frame', 'reuse returns the original frame matrix', reused.matrix.join(','), frame.matrix.join(','));
    validated('datum.frame');

    const transformed = cad('datum.transform', { from: 'root', to: 'root',
      points: [['10 mm', '-2 mm', '0 mm']], vectors: [[2, 0, 0], [0, -1, 0], [0, 0, 0]],
      differences: [{ from: ['1 mm', '2 mm', '3 mm'], to: ['4 mm', '6 mm', '8 mm'] }] });
    check('datum.transform', 'root-to-root matrix is 4×4', transformed.matrix.length, 16);
    transformed.matrix.forEach((value, index) => check('datum.transform', 'identity matrix element ' + index,
      value, index % 5 === 0 ? 1 : 0, 1e-10));
    [1, -0.2, 0].forEach((expected, index) => check('datum.transform', 'point coordinate converted to cm ' + index,
      transformed.points[0][index], expected, 1e-10));
    [2, 0, 0].forEach((expected, index) => check('datum.transform', 'non-unit vector component preserved ' + index,
      transformed.vectors[0][index], expected, 1e-10));
    [0, 0, 0].forEach((expected, index) => check('datum.transform', 'zero vector component remains zero ' + index,
      transformed.vectors[2][index], expected, 1e-10));
    check('datum.transform', 'directed difference is to-minus-from in cm', transformed.differences[0].join(','), '0.3,0.4,0.5', 1e-10);
    validated('datum.transform');
  }, false);

  runCase('native-plane-on-sketch-path-readback', ['sketch.create', 'sketch.geometry', 'datum.plane-on-path'], () => {
    const sketch = cad('sketch.create', { name: 'AnalyticsPathSketch', plane: 'XY' });
    check('sketch.create', 'native path sketch reference returned', sketch.sketch.kind, 'sketch');
    validated('sketch.create');
    const geometry = cad('sketch.geometry', { sketch: sketch.sketch, geometry: [{ type: 'line', name: 'AnalyticsRail',
      start: ['0 mm', '0 mm', '0 mm'], end: ['40 mm', '0 mm', '0 mm'] }] });
    const rail = geometry.entities.find(entity => entity.name === 'AnalyticsRail') || geometry.refs?.AnalyticsRail;
    check('sketch.geometry', 'one native path-curve reference returned', Boolean(rail), true);
    validated('sketch.geometry');
    const section = cad('datum.plane-on-path', { name: 'AnalyticsPathSection', path: { curves: [rail], chain: 'none' },
      position: { mode: 'proportional', value: '0.5' }, orientation: { direction: [0, 0, 1], frame: 'root' },
      representation: 'native' });
    check('datum.plane-on-path', 'native path plane creation passes', section.status, 'pass');
    check('datum.plane-on-path', '40 mm native path length returns 4 cm', section.pathLength, 4, 1e-8);
    check('datum.plane-on-path', 'path midpoint x coordinate is 2 cm', section.expectedPoint[0], 2, 1e-8);
    check('datum.plane-on-path', 'plane normal aligns with path tangent', Math.abs(section.normalDotTangent), 1, 1e-8);
    check('datum.plane-on-path', 'plane placement residual is within kernel tolerance', section.distanceResidual <= 1e-6, true);
    check('datum.plane-on-path', 'orientation supplies snapshot section-frame metadata', section.sectionFrame.associativity, 'snapshot');
    validated('datum.plane-on-path');
    const listed = cad('entity.list', { kind: 'constructionPlane' });
    check('entity.list', 'native named construction plane appears in entity readback',
      listed.entities.some(entity => entity.name === 'AnalyticsPathSection'), true);
    validated('entity.list');
  });

  runCase('cylindrical-tool-access-and-fixture-seating', ['tool.access', 'fixture.access'], () => {
    const access = cad('tool.access', { schemaVersion: 1, tool: { diameter: '6 mm', length: '40 mm' },
      target: { origin: ['0 mm', '0 mm', '0 mm'], axis: [0, 0, 1], engagementDepth: '4 mm' },
      entry: { origin: ['0 mm', '0 mm', '30 mm'], direction: [0, 0, -1] }, samples: 5 });
    check('tool.access', 'tool reaches the engagement point', access.reachable, true);
    check('tool.access', 'approach axis is aligned', access.axisAligned, true);
    check('tool.access', 'required reach is 2.6 cm', access.reach, 2.6, 1e-9);
    check('tool.access', 'declared tool length is sufficient', access.lengthSufficient, true);
    validated('tool.access');

    const seating = cad('fixture.access', { schemaVersion: 1,
      part: { name: 'plate', features: [{ name: 'pin', kind: 'pin', origin: ['0 mm', '0 mm', '0 mm'],
        direction: [0, 0, 1], diameter: '2 mm' }] },
      fixture: { name: 'jig', approach: { direction: [0, 0, 1] }, features: [{ name: 'hole', kind: 'hole',
        origin: ['0 mm', '0 mm', '0 mm'], direction: [0, 0, 1], diameter: '2.1 mm' }] },
      pairs: [['pin', 'hole']], clearance: '0.05 mm', tolerance: '0.01 mm', angleTolerance: '1 deg' });
    check('fixture.access', 'pin fits the declared hole with required clearance', seating.seatPossible, true);
    check('fixture.access', 'paired pin and hole have zero lateral offset', seating.pairs[0].lateralOffset, 0, 1e-9);
    check('fixture.access', 'mating axes agree', seating.pairs[0].angle, 0, 1e-9);
    check('fixture.access', 'no seating blockers are reported', seating.blockers.length, 0);
    validated('fixture.access');
  }, false);

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
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned measurement fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  const covered = new Set([...targetOperations, 'shape.box', 'entity.find']);
  report.operationCoverage = [...covered].sort().map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-engineering-analytics.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests.some(row => row.status !== 'pass') || report.finalAuditError ||
      (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL engineering analytics: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS native measurement and declared analytic method assertions');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'engineering-analytics-suite-setup',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = [...targetOperations, 'shape.box', 'entity.find'].map(operation => ({
    operation, canonical: true, test: 'tests/live-engineering-analytics.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL engineering analytics: ' + error.stack);
  process.exitCode = 1;
});
