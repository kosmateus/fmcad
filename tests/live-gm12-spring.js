'use strict';

// Opt-in GM12 live coverage through one source-pinned cad-v1 run on the exact
// owner scratch. Helix/spring outputs are recipes, not native BRep geometry.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertFixedMethodResults, isExecutionUnknown } = require('./helpers/gm12-fixed-result');

const root = path.resolve(__dirname, '..');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_SUITE = 'gm12-spring';

const { catalog, validateCad } = require('../src/cad');
const { contracts } = require('../src/catalog');
const reportPath = path.join(__dirname, 'live-gm12-spring-report.json');
const operations = ['curve.helix', 'shape.spring', 'spring.evaluate', 'spring.configure'];
const report = {
  suite: 'gm12-spring',
  sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  startedAt: new Date().toISOString(),
  scope: 'One exact owner-bound unsaved scratch document; no document creation, save, cloud writes, existing-document edits, or preference changes.',
  geometryContract: 'curve.helix and shape.spring return sampled recipe geometry; no native Coil or persistent 3D path is claimed.',
  commands: [],
  methodResults: [],
  assertions: [],
  ownedDocuments: [],
  remainingOwnedDocuments: 'not applicable: this suite creates no document and preserves the owner scratch',
  limitations: ['Recipe samples are checked against the helix equations; they are not a native BRep or manufacturing certificate.'],
};
let identity;
let nativeProgram;
let uncertain = false;
let blockedReason;
let failure;

function persist() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function requiredEnv(name) {
  const value = process.env[name];
  assert.ok(typeof value === 'string' && value.trim(), name + ' must be supplied for the exact owner-scoped run.');
  return value;
}

function runFixedProgram() {
  assert.ok(process.argv.includes('--run'), 'Explicit --run required; run exclusively');
  const clientId = requiredEnv('FMCAD_LIVE_CLIENT');
  const runtimeRoot = fs.realpathSync(requiredEnv('FMCAD_LIVE_RUNTIME_ROOT'));
  identity = {
    name: requiredEnv('FMCAD_LIVE_DOC_NAME'),
    creationId: requiredEnv('FMCAD_LIVE_DOC_ID'),
  };
  const fusionVersion = requiredEnv('FMCAD_LIVE_FUSION_VERSION');
  assert.match(identity.creationId, /^[0-9a-f-]{36}$/i, 'An exact Fusion creationId is required.');
  const runtime = require(path.join(runtimeRoot, 'dist/src/queue-instance.js'));
  const { fixtureContract } = require(path.join(runtimeRoot, 'dist/src/queue-native-fixture-grant.js'));
  const fixture = fixtureContract('gm12-spring-program-v1');
  assert.equal(fixture.kind, 'fixed-run-v1');
  assert.equal(fixture.helperVersion, 'cad-v1');
  const scriptPath = path.join(runtimeRoot, 'dist', fixture.script);
  const cliPath = path.join(runtimeRoot, 'dist/bin/fmcad.js');
  assert.equal(fs.realpathSync(scriptPath), scriptPath, 'The fixed source must resolve from the selected installed runtime.');
  assert.equal(fs.realpathSync(cliPath), cliPath, 'The CLI must resolve from the selected installed runtime.');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
  assert.equal(sourceHash, fixture.scriptSha256, 'Installed fixed source hash differs from its manifest.');
  const buildHash = runtime.buildHash();
  assert.equal(buildHash, JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'dist/runtime-build.json'), 'utf8')).fingerprint,
    'Selected runtime build hash differs from its installed identity.');

  const requestId = 'gm12-spring-' + crypto.randomUUID();
  const args = {
    approved: true,
    creationId: identity.creationId,
    expectedFusionVersion: fusionVersion,
    fixturePrefix: 'NQGM12SPR01',
  };
  const command = [
    cliPath, 'run', scriptPath,
    '--helpers', 'cad-v1',
    '--args', JSON.stringify(args),
    '--doc', identity.name,
    '--doc-id', identity.creationId,
    '--request-id', requestId,
    '--timeout', '180000',
  ];
  const result = childProcess.spawnSync(process.execPath, command, {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FMCAD_ROUTING: 'queue', FMCAD_CLIENT: clientId },
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const jobLines = stderr.split(/\r?\n/).filter(line => line.startsWith('FMCAD_QUEUE_JOB '));
  const terminalLines = stderr.split(/\r?\n/).filter(line => line.startsWith('FMCAD_QUEUE_RESULT '));
  const row = {
    requestId,
    clientId,
    runtimeRoot,
    buildHash,
    fixtureId: fixture.fixtureId,
    manifestSha256: fixture.manifestSha256,
    scriptSha256: fixture.scriptSha256,
    exitCode: result.status,
    signal: result.signal || undefined,
    error: result.error?.message,
    stdout,
    stderr,
    status: 'not-validated',
  };
  report.commands.push(row);
  persist();
  if (result.error || result.signal || result.status === null || jobLines.length > 0 && terminalLines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Broker outcome is indeterminate; stop and inspect the exact owner scratch. Never replay this run.');
  }
  if (terminalLines.length !== 1) {
    if (/NATIVE_FIXTURE_SCOPE_REQUIRED|EPOCH_CLIENT_NOT_GRANTED|BUILD_CHANGED|NATIVE_FIXTURE_CHANGED/.test(stderr)) {
      blockedReason = stderr.trim();
      row.status = 'blocked-before-native';
      persist();
      throw new Error('Fixed-run admission did not accept the exact source scope.');
    }
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('No terminal broker receipt was returned; stop without retry.');
  }

  let queueResult;
  try { queueResult = JSON.parse(terminalLines[0].slice('FMCAD_QUEUE_RESULT '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Malformed terminal queue receipt; stop without retry.');
  }
  row.jobId = jobLines.length === 1 ? JSON.parse(jobLines[0].slice('FMCAD_QUEUE_JOB '.length)).jobId : null;
  row.queueResult = queueResult;
  if (isExecutionUnknown(queueResult)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Queue returned a nonterminal/unknown outcome; stop without replay.');
  }
  assert.equal(queueResult.state, 'succeeded', stderr || stdout);
  const markers = stdout.split(/\r?\n/).filter(line => line.startsWith('FMCAD_RESULT '));
  if (markers.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('The accepted fixed run returned no unambiguous result marker; stop without replay.');
  }
  const envelope = JSON.parse(markers[0].slice('FMCAD_RESULT '.length));
  if (isExecutionUnknown(envelope)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixed-run result is pending/unknown; stop without replay.');
  }
  assert.equal(result.status, 0, stderr || stdout);
  assert.equal(envelope.success, true, stdout);
  assert.deepEqual(envelope.helperCallsOnly.map(call => call.operation), [
    'document.status', ...operations, 'document.status',
  ]);
  assert.ok(envelope.helperCallsOnly.every(call => call.status === 'completed' && call.effects === 'observed'));
  assert.ok(envelope.result && typeof envelope.result === 'object');
  const payload = envelope.result;
  assertFixedMethodResults(payload, operations, identity.creationId);
  assert.equal(payload.version, 1);
  assert.equal(payload.document.name, identity.name);
  assert.equal(payload.document.creationId, identity.creationId);
  assert.equal(payload.fusionVersion, fusionVersion);
  assert.deepEqual(payload.operations, operations);
  assert.equal(payload.modelUnchanged, true);
  assert.equal(payload.nativeGeometry, false);
  assert.deepEqual(payload.designBefore, payload.designAfter);
  assert.deepEqual(payload.document.before, payload.document.after);
  report.nativeRun = {
    requestId,
    jobId: row.jobId,
    queueState: queueResult.state,
    buildHash,
    fixtureId: fixture.fixtureId,
    manifestSha256: fixture.manifestSha256,
    scriptSha256: fixture.scriptSha256,
    helperOperations: envelope.helperCallsOnly,
  };
  row.status = 'native-fixed-run-complete';
  row.parsed = envelope;
  nativeProgram = payload;
  persist();
  return payload;
}

function check(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  const row = { operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' };
  report.assertions.push(row);
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, JSON.stringify(row));
}

function near(operation, label, actual, expected, tolerance = 1e-8) {
  check(operation, label, actual, expected, tolerance);
}

function validated(operation, evidence) {
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  assert.ok(method, operation + ' has no fixed-run invocation result to validate.');
  method.status = 'pass';
  if (evidence) method.evidence = evidence;
  persist();
}

function cad(operation, data) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  const contract = contracts[operation];
  assert.ok(contract, 'No public operation contract: ' + operation);
  assert.equal(contract.service.kind, 'python', operation + ' must execute through the Fusion Python service.');
  assert.equal(contract.requirements.sdk, 'required', operation + ' must not be treated as local/node-only.');
  assert.equal(contract.requirements.document, true, operation + ' must be pinned to a document.');
  validateCad(operation, data);
  assert.deepEqual(nativeProgram.inputs[operation], data, operation + ' fixed input differs from the retained GM12 test case.');
  const result = nativeProgram.results[operation];
  assert.ok(result && typeof result === 'object', operation + ' returned no individual method result.');
  assert.equal(result.documentIdentity?.creationId, identity.creationId,
    operation + ' did not identify the exact owner scratch.');
  report.methodResults.push({ operation, status: 'invoked', service: contract.service.kind, sdk: contract.requirements.sdk,
    result, evidence: 'shared-broker fixed-run helper call and exact document identity' });
  persist();
  return result;
}

function helixValues(result, operation = result.operation) {
  const points = result.samplePoints;
  assert.ok(Array.isArray(points) && points.length >= 5, 'Helix recipe returned too few sample points.');
  const radius = result.radius.value;
  const pitch = result.pitch.value;
  const turns = result.turns;
  const phase = result.startPhase.value;
  const count = points.length - 1;
  const direction = result.hand === 'right' ? 1 : -1;
  let maxCoordinateError = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    assert.equal(point.length, 3, 'Helix point must contain x/y/z coordinates.');
    const actual = point.map(coordinate => {
      assert.equal(coordinate.units, 'mm');
      assert.ok(Number.isFinite(coordinate.value));
      return coordinate.value;
    });
    const t = turns * i / count;
    const angle = phase + direction * 2 * Math.PI * t;
    const expected = [radius * Math.cos(angle), radius * Math.sin(angle), pitch * t];
    for (let axis = 0; axis < 3; axis++) maxCoordinateError = Math.max(maxCoordinateError, Math.abs(actual[axis] - expected[axis]));
  }
  const passed = maxCoordinateError <= 1e-8;
  const row = { operation, label: 'all sampled helix xyz coordinates match analytic readback',
    pointCount: points.length, maxCoordinateErrorMm: maxCoordinateError, toleranceMm: 1e-8,
    status: passed ? 'pass' : 'fail' };
  report.assertions.push(row);
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), row.label];
  persist();
  assert.ok(passed, JSON.stringify(row));
  return { pointCount: points.length, maxCoordinateErrorMm: maxCoordinateError };
}

function checkHelix(operation, result, expected) {
  check(operation, 'schema version', result.schemaVersion, 1);
  check(operation, 'method operation', result.operation, 'curve.helix');
  check(operation, 'recipe status', result.status, 'pass');
  check(operation, 'recipe success', result.success, true);
  check(operation, 'recipe representation', result.representation, 'recipe');
  check(operation, 'no native Coil claimed', result.nativeCoil, false);
  check(operation, 'component frame readback', result.frame.space, 'component');
  check(operation, 'recipe regeneration contract', result.associativity, 'recipeRegeneration');
  check(operation, 'handedness readback', result.hand, expected.hand);
  check(operation, 'length unit readback', result.radius.units, 'mm');
  check(operation, 'pitch unit readback', result.pitch.units, 'mm');
  check(operation, 'height unit readback', result.height.units, 'mm');
  near(operation, 'radius readback (mm)', result.radius.value, expected.radius);
  near(operation, 'pitch readback (mm)', result.pitch.value, expected.pitch);
  near(operation, 'turn count readback', result.turns, expected.turns);
  near(operation, 'height readback (mm)', result.height.value, expected.pitch * expected.turns);
  near(operation, 'start phase readback (rad)', result.startPhase.value, expected.startPhase ?? 0);
  const turnLength = Math.hypot(expected.pitch, 2 * Math.PI * expected.radius);
  near(operation, 'analytic turn length (mm)', result.turnLength.value, turnLength);
  near(operation, 'analytic arc length (mm)', result.arcLength.value, expected.turns * turnLength);
  const curvature = expected.radius / (expected.radius ** 2 + (expected.pitch / (2 * Math.PI)) ** 2);
  near(operation, 'analytic curvature (1/mm)', result.curvature.value, curvature);
  near(operation, 'curvature radius (mm)', result.curvatureRadius.value, 1 / curvature);
  near(operation, 'tolerance readback (mm)', result.tolerance.value, expected.tolerance ?? 0.01);
  const readback = helixValues(result, operation);
  check(operation, 'reported sample count matches actual points', result.sampleCount, readback.pointCount);
  check(operation, 'default 16-points-per-turn sampling', result.sampleCount,
    Math.max(4, Math.round(expected.turns * 16)) + 1);
  return readback;
}

function runMethods() {
  const helixInput = { schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', turns: 8,
    hand: 'right', startPhase: '30 deg', tolerance: '0.01 mm' };
  const helix = cad('curve.helix', helixInput);
  const helixReadback = checkHelix('curve.helix', helix,
    { radius: 4, pitch: 5.75, turns: 8, hand: 'right', startPhase: Math.PI / 6, tolerance: 0.01 });
  const helixMethod = report.methodResults.findLast(item => item.operation === 'curve.helix' && item.status === 'invoked');
  helixMethod.nativeGeometry = false;
  helixMethod.geometryReadback = helixReadback;
  validated('curve.helix', 'Fusion recipe result; all sampled coordinates and analytic parameters read back; no BRep claimed');

  const springInput = { schemaVersion: 1, frame: 'component', name: 'GM12_Spring',
    wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    shearModulus: '77000 N/mm^2', density: '7850 kg/m^3', endStyle: 'ground', hand: 'right' };
  const spring = cad('shape.spring', springInput);
  check('shape.spring', 'recipe status', spring.status, 'pass');
  check('shape.spring', 'recipe success', spring.success, true);
  check('shape.spring', 'method operation', spring.operation, 'shape.spring');
  const stiffness = 77000 * 0.5 ** 4 / (8 * 8 ** 3 * 6);
  const pitch = (35 - 0.5) / 6;
  const wireLength = 8 * Math.hypot(pitch, 2 * Math.PI * 4);
  const volume = wireLength * Math.PI * 0.5 ** 2 / 4;
  const mass = volume * 7850 * 1e-9;
  near('shape.spring', 'outer diameter readback (mm)', spring.outerDiameter.value, 8.5);
  near('shape.spring', 'inner diameter readback (mm)', spring.innerDiameter.value, 7.5);
  near('shape.spring', 'solid height readback (mm)', spring.solidHeight.value, 4);
  near('shape.spring', 'solid height margin readback (mm)', spring.solidHeightMargin.value, 31);
  near('shape.spring', 'pitch readback (mm)', spring.pitch.value, pitch);
  near('shape.spring', 'stiffness readback (N/mm)', spring.stiffness.value, stiffness);
  near('shape.spring', 'wire length readback (mm)', spring.wireLength.value, wireLength);
  near('shape.spring', 'mass readback (kg)', spring.mass.value, mass);
  near('shape.spring', 'wire volume readback (mm^3)', spring.volume.value, volume);
  check('shape.spring', 'recipe representation', spring.representation, 'recipe');
  check('shape.spring', 'no native Coil claimed', spring.nativeCoil, false);
  check('shape.spring', 'end style readback', spring.endStyle, 'ground');
  check('shape.spring', 'one composed helix recipe', spring.geometry.length, 1);
  const springHelix = spring.geometry[0];
  check('shape.spring', 'composed geometry is curve.helix recipe', springHelix.operation, 'curve.helix');
  const geometryReadback = checkHelix('shape.spring', springHelix, { radius: 4, pitch, turns: 8, hand: 'right' });
  const springMethod = report.methodResults.findLast(item => item.operation === 'shape.spring' && item.status === 'invoked');
  springMethod.nativeGeometry = false;
  springMethod.geometryReadback = geometryReadback;
  validated('shape.spring', 'Fusion recipe result; spring parameters and nested helix samples read back; no BRep claimed');

  const evaluation = cad('spring.evaluate', { schemaVersion: 1, frame: 'component', wireDiameter: '0.5 mm',
    meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    shearModulus: '77000 N/mm^2', density: '7850 kg/m^3', installedLength: '27 mm', compressedLength: '17 mm' });
  check('spring.evaluate', 'read-only status', evaluation.status, 'pass');
  check('spring.evaluate', 'read-only success', evaluation.success, true);
  check('spring.evaluate', 'method operation', evaluation.operation, 'spring.evaluate');
  near('spring.evaluate', 'stiffness readback (N/mm)', evaluation.stiffness.value, stiffness);
  near('spring.evaluate', 'wire length readback (mm)', evaluation.wireLength.value, wireLength);
  near('spring.evaluate', 'mass readback (kg)', evaluation.mass.value, mass);
  near('spring.evaluate', 'solid height readback (mm)', evaluation.solidHeight.value, 4);
  near('spring.evaluate', 'solid height margin readback (mm)', evaluation.solidHeightMargin.value, 31);
  near('spring.evaluate', 'free length readback (mm)', evaluation.freeLength.value, 35);
  near('spring.evaluate', 'installed length readback (mm)', evaluation.installedLength.value, 27);
  near('spring.evaluate', 'compressed length readback (mm)', evaluation.compressedLength.value, 17);
  check('spring.evaluate', 'linear model uses active coils', evaluation.model.activeCoilsUsed, true);
  check('spring.evaluate', 'two force states returned', evaluation.forces.length, 2);
  const forces = Object.fromEntries(evaluation.forces.map(force => [force.state, force]));
  near('spring.evaluate', 'installed deflection readback (mm)', forces.installed.deflection.value, 8);
  near('spring.evaluate', 'installed force readback (N)', forces.installed.force.value, stiffness * 8);
  near('spring.evaluate', 'compressed deflection readback (mm)', forces.compressed.deflection.value, 18);
  near('spring.evaluate', 'compressed force readback (N)', forces.compressed.force.value, stiffness * 18);
  check('spring.evaluate', 'read-only snapshot contract', evaluation.associativity, 'snapshot');
  validated('spring.evaluate', 'Fusion read-only result; engineering parameters and force values independently checked');

  const configuration = cad('spring.configure', { schemaVersion: 1, frame: 'component', wireDiameter: '0.5 mm',
    meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm',
    installedLength: '27 mm', compressedLength: '17 mm', guide: { kind: 'rod', diameter: '7.4 mm' } });
  check('spring.configure', 'read-only status', configuration.status, 'pass');
  check('spring.configure', 'read-only success', configuration.success, true);
  check('spring.configure', 'method operation', configuration.operation, 'spring.configure');
  near('spring.configure', 'configured solid height readback (mm)', configuration.configuredState.solidHeight.value, 4);
  near('spring.configure', 'configured margin readback (mm)', configuration.configuredState.solidHeightMargin.value, 31);
  near('spring.configure', 'configured installed length readback (mm)', configuration.configuredState.installedLength.value, 27);
  near('spring.configure', 'configured compressed length readback (mm)', configuration.configuredState.compressedLength.value, 17);
  const checks = Object.fromEntries(configuration.checks.map(item => [item.check, item]));
  check('spring.configure', 'material-volume clearance status', checks['material-volume'].status, 'pass');
  near('spring.configure', 'material-volume clearance readback (mm)', checks['material-volume'].margin.value, 13);
  check('spring.configure', 'guide-rod clearance status', checks['guide-rod'].status, 'pass');
  near('spring.configure', 'guide-rod clearance readback (mm)', checks['guide-rod'].clearance.value, 0.1);
  check('spring.configure', 'slenderness limitation is reported as unknown', checks.slenderness.status, 'unknown');
  check('spring.configure', 'read-only snapshot contract', configuration.associativity, 'snapshot');
  validated('spring.configure', 'Fusion read-only result; configured state and guide/coil-clearance readback checked');
}

async function main() {
  persist();
  try {
    const payload = runFixedProgram();
    report.fusionVersion = payload.fusionVersion;
    report.before = payload.document.before;
    report.after = payload.document.after;
    report.fixture = payload.document.before;
    report.fixtureDesignBaseline = payload.designBefore;
    report.fixturePreserved = payload.modelUnchanged;
    report.cleanup = payload.cleanup;
    report.ownedDocuments.push({ ...identity, createdBySuite: false });
    runMethods();
    report.tests = [{ name: 'gm12-existing-methods', status: 'pass', operations }];
  } catch (error) {
    failure ||= error;
    report.tests = [{ name: 'gm12-existing-methods',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
      error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  report.operationCoverage = operations.map(operation => {
    const method = report.methodResults.findLast(row => row.operation === operation);
    const contract = contracts[operation];
    return { operation, canonical: true, test: 'tests/live-gm12-spring.js',
      service: contract.service.kind, sdk: contract.requirements.sdk,
      status: method?.status === 'pass' ? 'pass' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed',
      evidence: method?.evidence || null,
      ...(['curve.helix', 'shape.spring'].includes(operation) ? { nativeGeometry: false } : {}) };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || !report.fixturePreserved) {
    console.error('FAIL GM12 live suite: ' + (failure?.message || 'suite did not complete and verify the unchanged owner scratch'));
    process.exitCode = 1;
  } else console.log('PASS GM12 Fusion recipe/evaluation methods: ' + operations.join(', '));
}

main().catch(error => {
  if (/EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_SCOPE_REQUIRED|NATIVE_FIXTURE_CHANGED|BUILD_CHANGED/.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'gm12-existing-methods',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.stack }];
  report.operationCoverage = operations.map(operation => ({ operation, canonical: true,
    test: 'tests/live-gm12-spring.js', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL GM12 live suite: ' + error.stack);
  process.exitCode = 1;
});
