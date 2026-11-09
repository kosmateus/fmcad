'use strict';

// GM07 fixed-run adapter. The installed source-pinned program owns all method
// calls; this wrapper never creates a document or sends raw modeling Python.
// Its explicit caller cleanup closes only the exact verified unsaved scratch.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareNativeInvocation, observeNativeInvocation } = require('../dist/tests/live-import-receipts.js');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_GM07_' + crypto.randomUUID().replaceAll('-', '_');
const fixtureId = 'gm07-curves-program-v1';
const fixturePrefix = 'NQGM07CURVE01';
const fixedSourceCommit = '0fc1d992db1a3c7b7c5b3d3944d44aba8bc3fa0d';
const expectedRuntimeRoot = '/home/kamil/.local/share/fmcad/releases/b811af8/node_modules/fmcad';
const expectedBuildHash = 'b865bd3ca761ba71d4a2661d487301823f0326b6faf1df101cc8e345a5e60526';
const expectedManifestSha256 = 'aef99573a0ce45f852ea6883f0921e20056961a9d0b44bb8ced7654fd0707bb5';
const expectedScriptSha256 = 'aad7f113451db0784b16235de4d77cf7d8af024c3880338728154274616dbe16';
const targetOperations = ['sketch.profile-file', 'curve.fit', 'curve.inspect', 'curve.offset', 'curve.offset-edit'];
const supportOperations = ['sketch.create', 'sketch.inspect'];
const coverageOperations = [...supportOperations, ...targetOperations];
const reportPath = path.join(__dirname, 'live-gm07-report.json');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_SUITE = 'gm07';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog } = require('../src/cad');
const { contracts } = require('../src/catalog');
const report = {
  suite: 'gm07',
  sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT || null },
  name,
  startedAt: new Date().toISOString(),
  scope: 'Existing exact owner-bound pristine unsaved scratch only. The fixed source creates one sketch; the caller closes only that exact scratch after terminal-result verification. No document creation, save, cloud write, existing-geometry edit or preference change.',
  fixedProgram: {
    fixtureId, sourceCommit: fixedSourceCommit, fixturePrefix,
    runtimeRoot: expectedRuntimeRoot, buildHash: expectedBuildHash,
    manifestSha256: expectedManifestSha256, scriptSha256: expectedScriptSha256,
    status: 'OFFLINE-CANDIDATE-QUALIFIED; NOT-ACTIVE; NATIVE-NOTRUN',
  },
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [],
  remainingOwnedDocuments: 'unknown',
  limitations: ['Native curve inspection is tolerance-bounded, not a global geometry or manufacturing certificate. The fixed source does not create a native 3D surface or solid body.'],
};

let identity;
let restoreDocumentId;
let baseline;
let documentCreated = false;
let uncertain = false;
let blockedReason;
let fixedRunSettled = false;
let failure;

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

function fixedContract(runtimeRoot, expectedBuild = null) {
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
  if (expectedBuild) assert.equal(buildHash, expectedBuild, 'Build differs from the offline-qualified candidate.');
  return { runtime, contract, manifest, manifestSha256, scriptSha256, scriptPath, cliPath, buildHash };
}

function offlineCheck() {
  const runtimeRoot = fs.realpathSync(process.env.FMCAD_LIVE_RUNTIME_ROOT || expectedRuntimeRoot);
  assert.equal(runtimeRoot, expectedRuntimeRoot, 'Use only the source-pinned GM07 candidate for offline checks.');
  const pinned = fixedContract(runtimeRoot);
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
    adapterCheck: 'PASS-OFFLINE',
    nativeStatus: 'NOTRUN-no-active-runtime-grant-or-fresh-scope',
  };
  report.tests = [{ name: 'gm07-fixed-source-offline-adapter-check', status: 'NOTRUN',
    note: 'Manifest/source/build hashes match the inactive offline-qualified candidate; no broker or Fusion request was made.' }];
  report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
    test: 'tests/live-gm07.js', status: 'NOTRUN-before-native-fixed-run' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('OFFLINE CHECK PASS; GM07 Fusion methods remain NOTRUN');
}

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '60000'], {
    cwd: root, encoding: 'utf8', timeout: 0, maxBuffer: 32 * 1024 * 1024,
  });
  const row = { args, exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error?.message, signal: result.signal || undefined, status: 'not-validated' };
  report.commands.push(row);
  const text = row.stdout + row.stderr.split(/\r?\n/)
    .filter(line => !line.startsWith('FMCAD_QUEUE_') && !line.startsWith('QUEUE ')).join('\n');
  if (result.error || result.signal || result.status === null || !text.trim() ||
      /empty response|timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|MCP_ERROR|HTTP [45]\d\d/i.test(text)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Indeterminate lifecycle result; stop and inspect without retry.');
  }
  if (/EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_SCOPE_REQUIRED|NATIVE_FIXTURE_CHANGED|BUILD_CHANGED|no modeling grant for the isolated scratch/i.test(text)) {
    blockedReason = text.trim();
    row.status = 'blocked-before-native';
    persist();
    throw new Error('Exact fixed-run admission blocked before a GM07 method ran.');
  }
  row.status = result.status === 0 ? 'transport-returned' : 'command-failed';
  persist();
  return row;
}

function lifecycleScript(source, readOnly = true) {
  const wrapped = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    source.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: wrapped, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_GM07 '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Lifecycle script returned no unambiguous result; stop without retry.');
  }
  let parsed;
  try { parsed = JSON.parse(lines[0].slice('LIVE_GM07 '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Lifecycle script returned malformed JSON; stop without retry.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  if (isExecutionUnknown(parsed)) {
    uncertain = true;
    row.status = 'unknown';
    row.parsed = parsed;
    persist();
    throw new Error('Lifecycle result is pending/unknown; stop without replay.');
  }
  row.parsed = parsed;
  row.status = 'validated';
  persist();
  return parsed;
}

function state() {
  fixture(null, null);
  return lifecycleScript(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents]
print('LIVE_GM07 ' + json.dumps({"version": app.version, "documents": docs}))`);
}

function stableDocuments(docs) {
  return docs.map(({ active, ...doc }) => doc).sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));
}

function runFixedProgram(pinned, clientId, fusionVersion) {
  assert.ok(process.argv.includes('--run'), 'Explicit --run is required; the default path never dispatches.');
  const requestId = 'gm07-curves-' + crypto.randomUUID();
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
  try {
    jobNotice = jobLines.length === 1 ? JSON.parse(jobLines[0].slice('FMCAD_QUEUE_JOB '.length)) : null;
    observeNativeInvocation(intentFile, jobNotice, queueResult);
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
  fixedRunSettled = true;
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
  return payload;
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

function closeOwned() {
  if (!identity || uncertain || !documentCreated) return false;
  // This is the manifest's caller-owned cleanup only, never a test-method
  // dispatch. Clear the helper scope so it cannot activate another document.
  fixture(null, null);
  const expectedOtherDocuments = baseline.documents.map(({ active, ...doc }) => doc);
  const expectedOtherJson = JSON.stringify(expectedOtherDocuments);
  const expectedModified = fixedRunSettled ? 'True' : 'False';
  const closed = lifecycleScript(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(identity.name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Exact test-owned scratch identity ambiguous; leave open'
doc = matches[0]
assert app.activeDocument == doc, 'Exact test-owned scratch is not active; do not switch documents'
assert doc.dataFile is None and not doc.isSaved, 'Unexpected saved/cloud scratch; leave open'
assert doc.isModified is ${expectedModified}, 'Scratch modification state differs from the settled test phase'
restore_id = ${JSON.stringify(restoreDocumentId)}
expected_others = sorted(tuple(row) for row in json.loads(${JSON.stringify(expectedOtherJson)}))
before_others = sorted((d.name, d.creationId, d.dataFile.id if d.dataFile else None, d.isSaved, d.isModified)
                       for d in app.documents if d.creationId != doc.creationId)
assert before_others == expected_others, 'An existing document changed during the GM07 test'
if restore_id is not None:
    assert len([d for d in app.documents if d.creationId == restore_id]) == 1, 'Original active document disappeared'
assert doc.close(False), 'Exact test-owned scratch close failed'
app = adsk.core.Application.get()
after_others = sorted((d.name, d.creationId, d.dataFile.id if d.dataFile else None, d.isSaved, d.isModified)
                      for d in app.documents)
assert after_others == expected_others, 'Another document changed during exact scratch cleanup'
active_id = app.activeDocument.creationId if app.activeDocument else None
assert active_id == restore_id, 'Original active document was not restored'
print('LIVE_GM07 ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)},
                                 "activeCreationId": active_id, "remainingDocuments": len(app.documents)}))`, false);
  assert.equal(closed.closedCreationId, identity.creationId);
  assert.equal(closed.activeCreationId, restoreDocumentId);
  report.cleanupResult = closed;
  return true;
}

async function main() {
  persist();
  try {
    const runtimeRoot = fs.realpathSync(requiredEnv('FMCAD_LIVE_RUNTIME_ROOT'));
    const pinned = fixedContract(runtimeRoot);
    process.env.FMCAD_LIVE_ROUTING = 'queue';
    const clientId = requiredEnv('FMCAD_LIVE_CLIENT');
    report.broker.client = clientId;
    const fusionVersion = requiredEnv('FMCAD_LIVE_FUSION_VERSION');
    fixture(null, null);
    baseline = state();
    report.before = baseline;
    restoreDocumentId = baseline.documents.find(doc => doc.active)?.creationId || null;
    assert.ok(!baseline.documents.some(doc => doc.name === name), 'Random GM07 fixture name already exists.');

    const created = cli(['doc', 'new', '--name', name, '--json']);
    const afterCreate = state();
    const baselineIds = new Set(baseline.documents.map(doc => doc.creationId));
    const added = afterCreate.documents.filter(doc => !baselineIds.has(doc.creationId));
    if (added.length !== 1) {
      if (created.exitCode === 0 || added.length > 1) uncertain = true;
      throw new Error('Document creation and read-only reconciliation did not identify exactly one owned scratch; inspect, never retry.');
    }
    identity = { name: added[0].name, creationId: added[0].creationId };
    documentCreated = true;
    report.documentCreationExitCode = created.exitCode;
    assert.equal(identity.name, name, 'CLI created a document with an unexpected name.');
    assert.match(identity.creationId, /^[0-9a-f-]{36}$/i, 'New scratch did not return an exact creationId.');
    assert.equal(added[0].fileId, null, 'New scratch unexpectedly has a cloud file ID.');
    assert.equal(added[0].saved, false, 'New scratch unexpectedly saved.');
    assert.equal(added[0].modified, false, 'New scratch was not pristine before the GM07 program.');
    assert.equal(added[0].active, true, 'New scratch was not active; do not switch documents.');
    fixture(identity.name, identity.creationId);
    report.name = identity.name;
    report.ownedDocuments.push({ ...identity, createdBySuite: true });
    report.fixture = added[0];
    if (created.exitCode !== 0) {
      throw new Error('Document creation returned a terminal CLI failure, but one exact new scratch was observed; closing only that owned scratch.');
    }

    report.fixedProgram = { ...report.fixedProgram, runtimeRoot, buildHash: pinned.buildHash,
      manifestSha256: pinned.manifestSha256, scriptSha256: pinned.scriptSha256,
      scope: pinned.manifest.scope, callerCleanupRequired: true,
      nativeStatus: 'EXPLICIT-RUN-REQUESTED; own unsaved document created; broker admission not yet established' };
    persist();

    const payload = runFixedProgram(pinned, clientId, fusionVersion);
    report.fusionVersion = payload.fusionVersion;
    report.fixtureStatusBefore = payload.document.before;
    report.afterNativeRun = payload.document.after;
    report.fixture = { ...payload.document.before, designBefore: payload.designBefore };
    report.nativeResult = payload;
    report.fixtureDesignBaseline = payload.designBefore;
    runAssertions(payload);
    report.tests = [{ name: 'gm07-source-pinned-native-methods', status: 'pass', operations: coverageOperations }];
  } catch (error) {
    failure = error;
    if (error.code === 'NATIVE_FIXTURE_SCOPE_REQUIRED' || /FMCAD_LIVE_(CLIENT|RUNTIME_ROOT|DOC_NAME|DOC_ID|RESTORE_DOC_ID|FUSION_VERSION) is required/.test(error.message))
      blockedReason = error.message;
    report.tests = [{ name: 'gm07-source-pinned-native-methods',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
      ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  if (!uncertain && documentCreated && identity) {
    try { report.fixtureClosed = closeOwned(); }
    catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  if (report.fixtureClosed) {
    report.remainingOwnedDocuments = [];
    report.after = report.cleanupResult;
    report.cleanup = { closedCreationId: identity.creationId, restoredActiveCreationId: restoreDocumentId,
      status: 'exact test-owned unsaved scratch discard-closed; original documents unchanged' };
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-block';
    report.cleanupStatus = documentCreated
      ? 'cleanup blocked; inspect the exact owned unsaved document without retry'
      : 'no test document was created; cleanup was unnecessary';
  } else if (uncertain) {
    report.finalAuditStatus = 'NOTRUN-after-unknown; inspect exact scratch and reconcile, never replay';
  }

  report.operationCoverage = coverageOperations.map(operation => ({ operation, canonical: true,
    test: 'tests/live-gm07.js', status: report.methodResults.some(row => row.operation === operation && row.status === 'pass')
      ? 'pass' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-passed' }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.finalAuditError || !report.fixtureClosed) {
    console.error('FAIL GM07 source-pinned suite: ' + (failure?.message || report.finalAuditError || 'run or exact cleanup incomplete'));
    process.exitCode = 1;
  } else console.log('PASS GM07 source-pinned native methods: ' + targetOperations.join(', '));
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
  blockedReason = /EPOCH_CLIENT_NOT_GRANTED|NATIVE_FIXTURE_SCOPE_REQUIRED|NATIVE_FIXTURE_CHANGED|BUILD_CHANGED/.test(error.message)
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
