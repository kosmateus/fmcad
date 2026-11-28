'use strict';

// GM07 fixed-run adapter. The installed source-pinned program owns all method
// calls; this runner creates only its uniquely named scratch and sends no raw
// modeling Python. Caller cleanup closes only that exact verified scratch.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareNativeInvocation, observeNativeInvocation } = require('../dist/tests/live-import-receipts.js');
const { readQueueResult } = require('./helpers/live-broker');
const { queueExecution } = require('../dist/tests/scenarios/queue-backend.js');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_GM07_' + crypto.randomUUID().replaceAll('-', '_');
const fixtureId = 'gm07-curves-program-v1';
const fixturePrefix = 'NQGM07CURVE01';
const fixedSourceCommit = '0fc1d992db1a3c7b7c5b3d3944d44aba8bc3fa0d';
const expectedManifestSha256 = 'aef99573a0ce45f852ea6883f0921e20056961a9d0b44bb8ced7654fd0707bb5';
const expectedScriptSha256 = 'aad7f113451db0784b16235de4d77cf7d8af024c3880338728154274616dbe16';
const targetOperations = ['sketch.profile-file', 'curve.fit', 'curve.inspect', 'curve.offset', 'curve.offset-edit'];
const supportOperations = ['sketch.create', 'sketch.inspect'];
const coverageOperations = [...supportOperations, ...targetOperations];
const reportPath = path.join(__dirname, 'live-gm07-report.json');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_SUITE = 'gm07';

const { catalog } = require('../src/cad');
const { contracts } = require('../src/catalog');
const report = {
  suite: 'gm07',
  sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT || null },
  name,
  startedAt: new Date().toISOString(),
  scope: 'The suite creates one uniquely named owner-bound pristine unsaved scratch; the fixed source creates one sketch; caller cleanup closes only that exact scratch after terminal-result verification. No save, cloud write, existing-geometry edit or preference change.',
  fixedProgram: {
    fixtureId, sourceCommit: fixedSourceCommit, fixturePrefix,
    runtimeRoot: process.env.FMCAD_LIVE_RUNTIME_ROOT || null,
    buildHash: process.env.FMCAD_LIVE_BUILD_HASH || null,
    manifestSha256: expectedManifestSha256, scriptSha256: expectedScriptSha256,
    status: 'NOT-CHECKED; NATIVE-NOTRUN',
  },
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [],
  remainingOwnedDocuments: 'unknown',
  limitations: ['Native curve inspection is tolerance-bounded, not a global geometry or manufacturing certificate. The fixed source does not create a native 3D surface or solid body.'],
};

let identity;
let uncertain = false;
let blockedReason;

function persist() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(name + ' is required for this exact owner-scoped run.'),
      { code: 'NATIVE_FIXTURE_SCOPE_REQUIRED' });
  }
  return value;
}

function runtimePins() {
  const selectedRoot = requiredEnv('FMCAD_LIVE_RUNTIME_ROOT');
  assert.ok(path.isAbsolute(selectedRoot), 'FMCAD_LIVE_RUNTIME_ROOT must be an absolute path.');
  return {
    runtimeRoot: fs.realpathSync(selectedRoot),
    expectedBuildHash: requiredEnv('FMCAD_LIVE_BUILD_HASH'),
  };
}

// Same execution-only interpretation as the corrected GM12 helper: a nested
// engineering/domain status=unknown is not itself an unknown queue outcome.
const pendingStates = new Set(['started', 'running', 'pending', 'needs_reconciliation']);
const queuedStates = new Set(['queued', 'preparing', 'running', 'sending', 'needs_reconciliation']);
function isExecutionUnknown(value, rootValue = true) {
  if (!value || typeof value !== 'object') return false;
  if (value.executionOutcome === 'unknown' || value.completed === false ||
      pendingStates.has(value.status) || queuedStates.has(value.state) ||
      (rootValue && (value.status === 'unknown' || value.state === 'unknown'))) return true;
  return Object.entries(value).some(([key, nested]) =>
    !(key === 'status' && nested === 'unknown') && isExecutionUnknown(nested, false));
}

function pushAssertion(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  const row = { operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' };
  report.assertions.push(row);
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, JSON.stringify(row));
}

function validated(operation, note) {
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  assert.ok(method, operation + ' has no fixed-run invocation result to validate.');
  method.status = 'pass';
  if (note) method.evidence = note;
  persist();
}

function inspectY(result) {
  const points = (result.inspection?.polylines || []).flat();
  assert.ok(points.length >= 2, 'Native offset inspection returned too few points.');
  return {
    pointCount: points.length,
    meanAbsY: points.reduce((sum, point) => sum + Math.abs(point[1]), 0) / points.length,
  };
}

function fixedContract(runtimeRoot, expectedBuild) {
  assert.match(expectedBuild, /^[a-f0-9]{64}$/u, 'FMCAD_LIVE_BUILD_HASH must be a SHA-256 fingerprint.');
  const runtime = require(path.join(runtimeRoot, 'dist/src/queue-instance.js'));
  const { fixtureContract } = require(path.join(runtimeRoot, 'dist/src/queue-native-fixture-grant.js'));
  const contract = fixtureContract(fixtureId);
  const manifestPath = path.join(runtimeRoot, 'dist', 'assets/native-qualification/gm07-curves-program.json');
  const scriptPath = path.join(runtimeRoot, 'dist', contract.script);
  const cliPath = path.join(runtimeRoot, 'dist/bin/fmcad.js');
  assert.equal(contract.fixtureId, fixtureId);
  assert.equal(contract.kind, 'fixed-run-v1');
  assert.equal(contract.helperVersion, 'cad-v1');
  assert.equal(contract.script, 'assets/native-qualification/gm07-curves.py');
  assert.equal(contract.manifestSha256, expectedManifestSha256);
  assert.equal(contract.scriptSha256, expectedScriptSha256);
  assert.equal(fs.realpathSync(manifestPath), manifestPath, 'Manifest must come from the selected installed runtime.');
  assert.equal(fs.realpathSync(scriptPath), scriptPath, 'Fixed source must come from the selected installed runtime.');
  assert.equal(fs.realpathSync(cliPath), cliPath, 'CLI must come from the selected installed runtime.');
  const manifestBytes = fs.readFileSync(manifestPath);
  const scriptBytes = fs.readFileSync(scriptPath);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const scriptSha256 = crypto.createHash('sha256').update(scriptBytes).digest('hex');
  assert.equal(manifestSha256, expectedManifestSha256, 'Installed GM07 manifest differs from the pinned source.');
  assert.equal(scriptSha256, expectedScriptSha256, 'Installed GM07 source differs from the pinned source.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.fixtureId, fixtureId);
  assert.equal(manifest.kind, 'fixed-run-v1');
  assert.equal(manifest.helperVersion, 'cad-v1');
  assert.deepEqual(manifest.argumentKeys, ['approved', 'creationId', 'expectedFusionVersion', 'fixturePrefix']);
  assert.equal(manifest.callerCleanupRequired, true);
  assert.match(manifest.scope, /exact owner-bound pristine unsaved scratch/);
  const installedBuild = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'dist/runtime-build.json'), 'utf8'));
  const buildHash = runtime.buildHash();
  assert.equal(installedBuild.fingerprint, buildHash, 'Runtime fingerprint differs from installed package identity.');
  assert.equal(buildHash, expectedBuild, 'Build differs from the offline-qualified candidate.');
  return { runtimeRoot, runtime, contract, manifest, manifestSha256, scriptSha256, scriptPath, cliPath, buildHash };
}

function offlineCheck() {
  const { runtimeRoot, expectedBuildHash } = runtimePins();
  const pinned = fixedContract(runtimeRoot, expectedBuildHash);
  const pythonCheck = childProcess.spawnSync('python3', ['-B', '-c',
    'import runpy,sys; value=runpy.run_path(sys.argv[1]); assert callable(value["run"])', pinned.scriptPath],
  { encoding: 'utf8', timeout: 10000 });
  assert.equal(pythonCheck.status, 0, pythonCheck.stderr || String(pythonCheck.error));
  for (const operation of coverageOperations) {
    assert.ok(catalog[operation], 'Missing canonical operation ' + operation);
    const contract = contracts[operation];
    assert.equal(contract.service.kind, 'python', operation + ' must use the Python SDK service.');
    assert.equal(contract.requirements.sdk, 'required', operation + ' must not be local/node-only.');
    assert.equal(contract.requirements.document, true, operation + ' must be document-pinned.');
  }
  report.fixedProgram = {
    ...report.fixedProgram,
    runtimeRoot,
    buildHash: pinned.buildHash,
    manifestSha256: pinned.manifestSha256,
    scriptSha256: pinned.scriptSha256,
    kind: pinned.contract.kind,
    helperVersion: pinned.contract.helperVersion,
    scope: pinned.manifest.scope,
    callerCleanupRequired: pinned.manifest.callerCleanupRequired,
    status: 'OFFLINE-CANDIDATE-QUALIFIED; NATIVE-NOTRUN',
    adapterCheck: 'PASS-OFFLINE',
    nativeStatus: 'NOTRUN-no-active-runtime-grant-or-fresh-scope',
  };
  report.tests = [{ name: 'gm07-fixed-source-offline-adapter-check', status: 'NOTRUN',
    note: 'Manifest/source hashes and the explicit runtime build pin match; no broker or Fusion request was made.' }];
  report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
    test: 'tests/live-gm07.js', status: 'NOTRUN-before-native-fixed-run' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('OFFLINE CHECK PASS; GM07 Fusion methods remain NOTRUN');
}

async function runFixedProgram(pinned, clientId, fusionVersion, requestId = 'gm07-curves-' + crypto.randomUUID()) {
  assert.ok(process.argv.includes('--run'), 'Explicit --run is required; the default path never dispatches.');
  const fixedArgs = { approved: true, creationId: identity.creationId,
    expectedFusionVersion: fusionVersion, fixturePrefix };
  const args = [pinned.cliPath, 'run', pinned.scriptPath, '--helpers', 'cad-v1', '--args', JSON.stringify(fixedArgs),
    '--doc', identity.name, '--doc-id', identity.creationId, '--request-id', requestId, '--timeout', '180000'];
  const intentFile = prepareNativeInvocation(path.join(root, '.test-artifacts/native-invocations'), {
    requestId, clientId, document: identity, runtimeRoot: pinned.runtimeRoot, buildHash: pinned.buildHash,
    fixtureId, manifestSha256: pinned.manifestSha256, scriptSha256: pinned.scriptSha256, command: args,
  });
  const command = { requestId, clientId, runtimeRoot: pinned.runtimeRoot, buildHash: pinned.buildHash,
    fixtureId, manifestSha256: pinned.manifestSha256, scriptSha256: pinned.scriptSha256,
    fixedSourceCommit, arguments: fixedArgs, intentFile, status: 'dispatch-intent' };
  report.commands.push(command);
  persist(); // Persist exact original request and driver birth before a possibly mutating spawn.
  let result;
  try {
    result = childProcess.spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, FMCAD_ROUTING: 'queue', FMCAD_CLIENT: clientId },
    });
  } catch (error) {
    uncertain = true; command.status = 'unknown'; command.error = error.message; persist(); throw error;
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const jobLines = stderr.split(/\r?\n/).filter(line => line.startsWith('FMCAD_QUEUE_JOB '));
  const terminalLines = stderr.split(/\r?\n/).filter(line => line.startsWith('FMCAD_QUEUE_RESULT '));
  Object.assign(command, { exitCode: result.status, signal: result.signal || undefined,
    error: result.error?.message, stdout, stderr, status: 'not-validated' });
  persist();
  if (result.error || result.signal || result.status === null || jobLines.length > 1 ||
      jobLines.length > 0 && terminalLines.length !== 1) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Fixed-run outcome is indeterminate; stop and inspect the exact owner scratch. Never replay.');
  }
  if (terminalLines.length !== 1) {
    if (/NATIVE_FIXTURE_SCOPE_REQUIRED|EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_CHANGED|BUILD_CHANGED/.test(stderr)) {
      blockedReason = stderr.trim();
      command.status = 'blocked-before-native';
      persist();
      throw new Error('GM07 fixed-run admission rejected the exact source/scratch scope.');
    }
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('No terminal broker receipt was returned; stop without replay.');
  }

  let queueResult;
  try { queueResult = JSON.parse(terminalLines[0].slice('FMCAD_QUEUE_RESULT '.length)); }
  catch {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Malformed terminal queue receipt; stop without replay.');
  }
  let jobNotice;
  let execution;
  try {
    jobNotice = jobLines.length === 1 ? JSON.parse(jobLines[0].slice('FMCAD_QUEUE_JOB '.length)) : null;
    assert.equal(jobNotice?.requestId, requestId);
    assert.equal(queueResult.requestId, requestId);
    assert.equal(queueResult.id, jobNotice?.jobId);
    const original = await readQueueResult({ cliPath: pinned.cliPath, backend: 'addin',
      clientId, jobId: jobNotice.jobId, cwd: root });
    execution = queueExecution(original, { clientId }, requestId);
    assert.equal(original.job.id, jobNotice.jobId);
    assert.equal(execution.sdkSettled, true);
    assert.equal(execution.state, queueResult.state);
    assert.equal(original.stdout, stdout);
    assert.deepEqual(queueResult.outcome || queueResult.operationResult, original.job.operationResult);
    if (queueResult.clientId !== undefined) assert.equal(queueResult.clientId, original.job.clientId);
    if (queueResult.executionOutcome !== undefined) assert.equal(queueResult.executionOutcome, original.job.operationResult.executionOutcome);
    assert.equal(original.job.operationResult.version, 1);
    assert.equal(original.job.operationResult.requestId, requestId);
    assert.equal(original.job.operationResult.jobId, jobNotice.jobId);
    assert.equal(original.job.operationResult.acceptance, 'accepted');
    assert.equal(original.job.operationResult.executionOutcome, execution.state);
    assert.equal(original.provenance.status, 'available');
    const sources = original.provenance.inputs.filter(input => input.kind === 'source');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].sha256, pinned.scriptSha256);
    assert.equal(sources[0].originalPath, pinned.scriptPath);
    assert.equal(sources[0].bytes, fs.statSync(pinned.scriptPath).size);
    command.originalResultFile = intentFile + '.original.json';
    fs.writeFileSync(command.originalResultFile, JSON.stringify(original, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // The public CLI emits a thin outcome notice, not a full worker receipt.
    // All identity and execution fields here come from that original worker.
    observeNativeInvocation(intentFile, jobNotice, { ...original.job,
      executionOutcome: original.job.operationResult.executionOutcome });
  } catch (error) {
    uncertain = true; command.status = 'unknown'; command.error = error.message; persist();
    throw new Error('Fixed-run accepted/terminal identity or outcome is unverified; inspect the original request, never replay.', { cause: error });
  }
  command.jobId = jobNotice?.jobId || null;
  command.queueResult = queueResult;
  if (isExecutionUnknown(queueResult)) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Queue outcome is nonterminal/unknown; stop without replay.');
  }
  if (queueResult.requestId !== requestId || jobNotice?.requestId !== requestId || queueResult.id !== command.jobId) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Terminal receipt identity does not match the exact GM07 request; stop without replay.');
  }
  if (queueResult.state !== 'succeeded') {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('GM07 job is terminal but failed; effects require inspection, never replay.');
  }
  const markers = stdout.split(/\r?\n/).filter(line => line.startsWith('FMCAD_RESULT '));
  if (markers.length !== 1) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Settled fixed run returned no unambiguous result marker; stop without replay.');
  }
  let envelope;
  try { envelope = JSON.parse(markers[0].slice('FMCAD_RESULT '.length)); }
  catch {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Malformed fixed-run result envelope; stop without replay.');
  }
  if (isExecutionUnknown(envelope)) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Fixed-run execution is unknown; stop without replay.');
  }
  if (result.status !== 0 || envelope.success !== true) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Fixed run did not return a successful settled payload; inspect the exact scratch.');
  }
  const expectedCalls = ['document.status', 'sketch.create', 'sketch.inspect', 'sketch.profile-file', 'curve.fit',
    'curve.inspect', 'curve.offset', 'curve.inspect', 'curve.offset-edit', 'curve.inspect', 'document.status'];
  assert.deepEqual(envelope.helperCallsOnly.map(call => call.operation), expectedCalls);
  assert.ok(envelope.helperCallsOnly.every(call => call.status === 'completed' && call.effects === 'observed'));
  assert.ok(envelope.result && typeof envelope.result === 'object');
  const payload = envelope.result;
  if (payload.document?.creationId !== identity.creationId || payload.document?.name !== identity.name ||
      payload.document?.after?.saved !== false || payload.document?.after?.fileId !== null) {
    uncertain = true;
    command.status = 'unknown';
    persist();
    throw new Error('Settled payload does not prove the exact unsaved owner document; inspect before cleanup.');
  }
  assert.equal(payload.version, 1);
  assert.equal(payload.fixturePrefix, fixturePrefix);
  assert.equal(payload.document?.creationId, identity.creationId);
  assert.equal(payload.document?.name, identity.name);
  assert.equal(payload.fusionVersion, fusionVersion);
  assert.equal(payload.modelChangedByFixture, true);
  assert.equal(payload.nativeGeometry, true);
  assert.equal(payload.designBefore?.bodyCount, 0);
  assert.equal(payload.designBefore?.sketchCount, 0);
  assert.equal(payload.designBefore?.occurrenceCount, 0);
  assert.equal(payload.designBefore?.timelineCount, 0);
  assert.equal(payload.designBefore?.parameterCount, 0);
  assert.equal(payload.designAfter?.bodyCount, 0);
  assert.equal(payload.designAfter?.sketchCount, 1);
  assert.equal(payload.designAfter?.occurrenceCount, 0);
  assert.equal(payload.document?.before?.creationId, identity.creationId);
  assert.equal(payload.document?.after?.creationId, identity.creationId);
  assert.equal(payload.document?.before?.saved, false);
  assert.equal(payload.document?.before?.modified, false);
  assert.equal(payload.document?.before?.fileId, null);
  assert.equal(payload.document?.after?.saved, false);
  assert.equal(payload.document?.after?.modified, true);
  assert.equal(payload.document?.after?.fileId, null);
  assert.match(payload.cleanup, /owner must close and restore this exact unsaved document/);
  command.status = 'native-fixed-run-complete';
  command.parsed = envelope;
  report.nativeRun = { requestId, jobId: command.jobId, queueState: queueResult.state,
    runtimeRoot: pinned.runtimeRoot, buildHash: pinned.buildHash, fixtureId, manifestSha256: pinned.manifestSha256,
    scriptSha256: pinned.scriptSha256, helperCallsOnly: envelope.helperCallsOnly };
  persist();
  return { value: payload, execution };
}

function recordCalls(payload) {
  const calls = payload.operations;
  assert.ok(Array.isArray(calls), 'Fixed GM07 result has no operation result list.');
  const expected = ['sketch.create', 'sketch.inspect', 'sketch.profile-file', 'curve.fit', 'curve.inspect',
    'curve.offset', 'curve.inspect', 'curve.offset-edit', 'curve.inspect'];
  assert.deepEqual(calls.map(call => call.operation), expected);
  for (const operation of coverageOperations) {
    const results = calls.filter(call => call.operation === operation).map(call => call.result);
    assert.ok(results.length, operation + ' is missing from the fixed GM07 result.');
    report.methodResults.push({ operation, status: 'invoked', results,
      evidence: 'One source-pinned cad-v1 fixed run with a settled broker receipt.' });
  }
  persist();
  return calls;
}

function callResult(calls, operation, index = 0) {
  const matches = calls.filter(call => call.operation === operation);
  assert.ok(matches[index]?.result, operation + ' result #' + index + ' is missing.');
  return matches[index].result;
}

function runAssertions(payload) {
  const calls = recordCalls(payload);
  const created = callResult(calls, 'sketch.create');
  pushAssertion('sketch.create', 'fixed source returns one native sketch reference', created.sketch?.kind, 'sketch');
  validated('sketch.create', 'Fixed source created the exact named native sketch.');

  const empty = callResult(calls, 'sketch.inspect');
  pushAssertion('sketch.inspect', 'fixed source begins from an empty sketch', empty.curves.length + empty.profiles.length, 0);
  validated('sketch.inspect', 'Exact sketch baseline read back empty before curve creation.');

  for (const operation of ['sketch.profile-file', 'curve.fit']) {
    const result = callResult(calls, operation);
    pushAssertion(operation, 'native fit error status', result.fitError.status, 'pass');
    pushAssertion(operation, 'one native curve entity returned', result.entities.length, 1);
    validated(operation, 'Exact fixed open-line fixture returned one native curve.');
  }

  const inspectedFit = callResult(calls, 'curve.inspect', 0);
  pushAssertion('curve.inspect', 'fitted native curve inspection passes', inspectedFit.status, 'pass');
  pushAssertion('curve.inspect', 'one fitted native curve is inspected', inspectedFit.inspection.curves.length, 1);
  pushAssertion('curve.inspect', 'fitted native curve has no self-intersections', inspectedFit.inspection.selfIntersections.length, 0);

  const offset = callResult(calls, 'curve.offset');
  pushAssertion('curve.offset', 'native offset operation passes', offset.status, 'pass');
  pushAssertion('curve.offset', 'one child offset curve is returned', offset.entities.length, 1);
  pushAssertion('curve.offset', 'native editable offset parameter is returned',
    typeof offset.offsetParameter === 'string' && offset.offsetParameter.length > 0, true);
  validated('curve.offset', 'Native offset created and returned its actual editable parameter.');

  const inspectOffsetBefore = callResult(calls, 'curve.inspect', 1);
  const before = inspectY(inspectOffsetBefore);
  pushAssertion('curve.inspect', 'native 1 mm offset readback in cm', before.meanAbsY, 0.1, 0.001);
  const edited = callResult(calls, 'curve.offset-edit');
  pushAssertion('curve.offset-edit', 'edited native parameter expression', edited.after.expression, '2 mm');
  pushAssertion('curve.offset-edit', 'edited native parameter value in cm', edited.after.value, 0.2, 0.001);
  validated('curve.offset-edit', { parameterBefore: edited.before, parameterAfter: edited.after,
    inspectedOffsetBefore: before });

  const inspectOffsetAfter = callResult(calls, 'curve.inspect', 2);
  const after = inspectY(inspectOffsetAfter);
  pushAssertion('curve.inspect', 'native edited 2 mm offset readback in cm', after.meanAbsY, 0.2, 0.001);
  validated('curve.inspect', 'One fixed-run invocation read back the fitted curve and both sides of the offset edit.',
    { fittedCurves: inspectedFit.inspection.curves.length, before, after });
  report.nativeReadback = { offsetParameterBefore: edited.before, offsetParameterAfter: edited.after,
    inspectedOffsetBefore: before, inspectedOffsetAfter: after };
  persist();
}

function gm07OwnedScenario(pinned, fusionVersion) {
  return {
    id: 'gm07-source-pinned',
    scope: 'exclusive-instance',
    requires: ['documents', 'fixture-export', 'original-user-view'],
    async run(session) {
      identity = session.document;
      assert.equal(identity.file, undefined, 'GM07 requires an unsaved owner scratch');
      session.expectCleanupModified(false);
      report.name = identity.name;
      report.broker.client = session.report.owner.clientId;
      report.ownedDocuments.push({ ...identity, createdBySuite: true });
      persist();
      await session.verifyOwnedUnsaved('observe-gm07-before-fixed-run');
      const payload = await session.registeredRequest('gm07-fixed-run', {
        fixtureId, manifestSha256: pinned.manifestSha256, scriptSha256: pinned.scriptSha256,
        buildHash: pinned.buildHash, document: identity,
      }, async (binding) => {
        const { value, execution } = await runFixedProgram(pinned, binding.owner.clientId, fusionVersion, binding.requestId);
        assert.ok(execution, 'Missing exact original GM07 result; do not replay');
        assert.equal(execution.brokerReceipt?.jobId, report.nativeRun.jobId, 'Foreign GM07 original job');
        assert.equal(execution.brokerReceipt?.clientId, binding.owner.clientId, 'Foreign GM07 original owner');
        return { value, execution };
      });
      session.expectCleanupModified(true);
      report.fusionVersion = payload.fusionVersion;
      report.fixtureStatusBefore = payload.document.before;
      report.afterNativeRun = payload.document.after;
      report.fixture = { ...payload.document.before, designBefore: payload.designBefore };
      report.nativeResult = payload;
      report.fixtureDesignBaseline = payload.designBefore;
      runAssertions(payload);
      report.tests = [{ name: 'gm07-source-pinned-native-methods', status: 'pass', operations: coverageOperations }];
      persist();
    },
  };
}

async function main() {
  const { runtimeRoot, expectedBuildHash } = runtimePins();
  const pinned = fixedContract(runtimeRoot, expectedBuildHash);
  const fusionVersion = requiredEnv('FMCAD_LIVE_FUSION_VERSION');
  const { QueueScenarioBackend } = require('../dist/tests/scenarios/queue-backend.js');
  const { runScenarios } = require('../dist/tests/scenarios/runner.js');
  const { scenarioArtifactRoot } = require('../dist/tests/scenarios/artifact-root.js');
  const { toWindowsPath, detectPlatform } = require('../src/dist/config-platform');
  const { cfg } = require('../src/config').loadConfig({ routing: 'queue' });
  assert.equal(cfg.backend, 'addin');
  assert.equal(cfg.url, 'http://127.0.0.1:8765/mcp');
  const backend = new QueueScenarioBackend('fusion', 'addin',
    new Set(['documents', 'fixture-export', 'original-user-view']), root, cfg,
    file => toWindowsPath(file, detectPlatform()));
  report.fixedProgram = { ...report.fixedProgram, runtimeRoot, buildHash: pinned.buildHash,
    manifestSha256: pinned.manifestSha256, scriptSha256: pinned.scriptSha256,
    status: 'RUNTIME-BUILD-VERIFIED; NATIVE-NOTRUN' };
  persist();
  try {
    const [owned] = await runScenarios(backend, [gm07OwnedScenario(pinned, fusionVersion)],
      scenarioArtifactRoot(root, 'fusion'), 1);
    report.lifecycle = owned;
    uncertain ||= owned.cleanup === 'deferred';
    report.fixtureClosed = owned.cleanup === 'complete' && Boolean(owned.document);
    report.remainingOwnedDocuments = report.fixtureClosed ? [] : 'unknown';
    report.cleanup = { status: owned.cleanup, document: owned.document, report: path.join(owned.directory, 'report.json') };
    report.fixedProgram.nativeStatus = owned.status === 'passed' ? 'PASS-NATIVE-FIXED-RUN-AND-OWN-CLEANUP'
      : owned.cleanup === 'deferred' ? 'UNKNOWN-INSPECT-ORIGINAL-REQUEST-NO-REPLAY' : 'FAIL';
    report.finalAuditStatus = owned.status === 'passed' ? 'PASS-receipt-bound-coordinator-and-own-cleanup' : 'NOT-PASS';
    if (owned.status !== 'passed') report.tests = [{ name: 'gm07-source-pinned-native-methods',
      status: owned.cleanup === 'deferred' ? 'unknown' : 'fail', error: owned.error || owned.cleanupError }];
    report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
      test: 'tests/live-gm07.js', status: report.methodResults.some(row => row.operation === operation && row.status === 'pass')
        ? 'pass' : owned.cleanup === 'deferred' ? 'unknown' : 'not-passed' }));
    report.finishedAt = new Date().toISOString();
    persist();
    assert.equal(owned.status, 'passed', owned.error || owned.cleanupError || 'GM07 lifecycle failed');
    assert.equal(report.fixtureClosed, true, 'GM07 exact own cleanup incomplete');
    console.log('REPORT ' + reportPath);
    console.log('PASS GM07 source-pinned native methods: ' + targetOperations.join(', '));
  } finally {
    backend.close();
  }
}

async function entry() {
  persist();
  const checkRequested = process.argv.includes('--check');
  const runRequested = process.argv.includes('--run');
  if (checkRequested && runRequested) throw new Error('Choose --check or --run, not both.');
  if (checkRequested) {
    offlineCheck();
    return;
  }
  if (!runRequested) {
    report.tests = [{ name: 'gm07-source-pinned-native-methods', status: 'NOTRUN',
      note: 'No Fusion dispatch: use --check for local hashes; --run requires the owner-approved exact scratch and restore identity.' }];
    report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
      test: 'tests/live-gm07.js', status: 'NOTRUN-before-native-fixed-run' }));
    report.finishedAt = new Date().toISOString();
    persist();
    console.log('NOTRUN; no --run opt-in');
    process.exitCode = 2;
    return;
  }
  await main();
}

entry().catch(error => {
  blockedReason = /EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_SCOPE_REQUIRED|NATIVE_FIXTURE_CHANGED|BUILD_CHANGED|FMCAD_LIVE_(RUNTIME_ROOT|BUILD_HASH)/.test(error.message)
    ? error.message : blockedReason;
  report.tests = [{ name: 'gm07-source-pinned-wrapper-setup',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
    test: 'tests/live-gm07.js', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL GM07 wrapper: ' + error.stack);
  process.exitCode = 1;
});
