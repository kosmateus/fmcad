'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson, hash, buildHash } = require('./queue-instance');
const { fileHash, exclusive } = require('./queue-atomic-migration-files');
const { resolveRuntimePaths } = require('./dist/config-platform');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const REGIONAL_OPERATIONS = ['document.status', 'entity.inspect', 'entity.list', 'geometry.compare-region',
  'measure.volume', 'shape.box', 'shape.cylinder', 'shape.ring', 'snapshot'];

function fixtureContract(fixtureId) {
  const installation = resolveRuntimePaths({ anchor: __filename }).installation;
  if (['containment-program-v1', 'sections-program-v1', 'sketch-proof-program-v1', 'measured-fasteners-program-v1', 'drive-motion-program-v1', 'drive-precision-program-v1', 'gm12-spring-program-v1', 'gm07-curves-program-v1', 'data-import-program-v1'].includes(fixtureId)) {
    const name = fixtureId.slice(0, -'-program-v1'.length);
    const file = path.join(installation, 'assets/native-qualification/' + name + '-program.json');
    const fixture = readJson(file);
    if (fixture.version !== 1 || fixture.fixtureId !== fixtureId || fixture.kind !== 'fixed-run-v1' ||
        fixture.script !== 'assets/native-qualification/' + name + '.py' || fixture.helperVersion !== 'cad-v1' ||
        !same(fixture.argumentKeys, ['approved', 'creationId', 'expectedFusionVersion', 'fixturePrefix']))
      fail('NATIVE_FIXTURE_CHANGED', 'Installed fixed program differs from its bounded source contract');
    return { fixtureId, kind: 'fixed-run-v1', operations: [], manifestSha256: fileHash(file).sha256,
      script: fixture.script, scriptSha256: fileHash(path.join(installation, fixture.script)).sha256, helperVersion: fixture.helperVersion };
  }
  if (fixtureId !== 'regional-geometry-v1') fail('NATIVE_FIXTURE_UNSUPPORTED', 'Only explicitly registered native fixtures are supported');
  const file = path.join(installation, 'assets/native-qualification/regional-geometry.json');
  const fixture = readJson(file);
  if (fixture.version !== 1 || fixture.fixtureId !== fixtureId || !same(fixture.operations, REGIONAL_OPERATIONS))
    fail('NATIVE_FIXTURE_CHANGED', 'Installed fixture operations differ from the bounded source contract');
  for (const operation of fixture.operations) {
    const declaration = require('./catalog').catalog[operation];
    if (!declaration || !require('./batch-atomic').isTransactional(operation, declaration))
      fail('NATIVE_FIXTURE_CHANGED', 'Every fixture operation must retain its typed transactional scope');
  }
  return { fixtureId, kind: 'typed-cad-v1', operations: fixture.operations, manifestSha256: fileHash(file).sha256 };
}

function onlySuccessfulReadinessQueries(jobs, epoch) {
  return Object.values(jobs).every(job => job.state === 'succeeded' && job.details?.sdkSettled === true &&
    job.kind === 'command' && job.request?.payload?.kind === 'cad' &&
    ['document.status', 'snapshot'].includes(job.request.payload.operation) &&
    job.request.payload.doc === epoch.document.name && job.request.payload.docId === epoch.document.creationId &&
    !job.sequenceId && job.dispatch?.rpcCount > 0 && job.dispatch.completedCount === job.dispatch.rpcCount);
}

// This is a typed-operation grant, not attestation of arbitrary client code.
// It cannot execute the manifest as Python or admit file/cloud/nested batch work.
function grantNativeFixture(p, message, clientId) {
  if (!message || Object.keys(message).some(key => !['action', 'auth', 'control', 'epochId', 'grantClientId', 'fixtureId', 'requestId'].includes(key)) ||
      message.action !== 'grant-native-fixture' || typeof message.requestId !== 'string' ||
      !message.requestId.trim() || message.requestId.length > 180)
    fail('INVALID_REQUEST', 'Exact fixture, epoch, registered client and stable grant request are required');
  const epoch = p.state.epoch, clients = p.clients();
  if (!epoch || clientId !== epoch.ownerClientId || clients[clientId] !== epoch.ownerTokenHash)
    fail('NOT_OWNER', 'Only the original scratch owner may issue native fixture scope');
  p.state.assertEpoch(); p.assertControl(message.control); p.fence();
  const controlRoot = require('./queue-epoch-lineage').epochControlDirectory(p.dir, epoch);
  if (fs.existsSync(path.join(epoch.root, 'saved-first-save-scope.json')))
    fail('SAVED_FIRST_SAVE_PENDING', 'First-save transition forbids unrelated native fixture authority');
  if (fs.existsSync(path.join(controlRoot, 'isolated-scratch-close', 'intent.json')))
    fail('EPOCH_CLEANUP_PENDING', 'Cleanup closes all new fixture authority even after an uncertain reply');
  if (message.epochId !== epoch.epochId || typeof message.grantClientId !== 'string' ||
      !Object.hasOwn(clients, message.grantClientId) || !/^[a-f0-9]{64}$/.test(clients[message.grantClientId]) ||
      message.grantClientId === epoch.ownerClientId)
    fail('NATIVE_FIXTURE_CLIENT_REQUIRED', 'A separate registered fixture client and exact new epoch are required');
  const identity = readJson(path.join(epoch.root, 'instance.json'));
  if (identity.buildHash !== p.buildHash || p.buildHash !== buildHash() || !/^[a-f0-9]{40}$/.test(identity.sourceCommit || ''))
    fail('BUILD_CHANGED', 'The native fixture grant must pin this exact qualified runtime');
  const fixture = fixtureContract(message.fixtureId);
  const grant = { epochId: epoch.epochId, clientId: message.grantClientId, clientTokenHash: clients[message.grantClientId],
    document: epoch.document, nativeFixture: { version: 1, ...fixture, requestId: message.requestId,
      sourceCommit: identity.sourceCommit, buildHash: p.buildHash } };
  const file = path.join(epoch.root, 'access-' + hash(grant.clientId + '\0' + grant.clientTokenHash) + '.json');
  if (fs.existsSync(file)) {
    if (!same(readJson(file), grant)) fail('GRANT_SCOPE_CONFLICT', 'Never silently broaden or replace an existing scratch grant');
    return { epochId: epoch.epochId, clientId: grant.clientId, document: epoch.document, nativeFixture: grant.nativeFixture };
  }
  if (!onlySuccessfulReadinessQueries(p.state.data.jobs, epoch) || p.state.data.active || p.state.data.blocked || p.state.data.lease ||
      p.state.data.localUnknown || p.state.data.controlBlocked)
    fail('NATIVE_FIXTURE_FRESH_EPOCH_REQUIRED', 'A fresh scratch permits only settled typed readiness queries, never prior model work or unknown execution');
  const proof = readJson(epoch.qualificationReceipt.path);
  if (fileHash(epoch.qualificationReceipt.path).sha256 !== epoch.qualificationReceipt.sha256 || proof.status !== 'complete' ||
      proof.summary?.independent !== true || proof.summary.empty !== true || proof.summary.unsaved !== true ||
      !same(proof.summary.document, epoch.document)) fail('NATIVE_FIXTURE_FRESH_EPOCH_REQUIRED', 'Known independent empty unsaved creation proof required');
  exclusive(file, grant);
  return { epochId: epoch.epochId, clientId: grant.clientId, document: epoch.document, nativeFixture: grant.nativeFixture };
}

function validateFixtureGrant(grant, identity) {
  const scope = grant.nativeFixture;
  if (!scope) return null;
  const fixture = fixtureContract(scope.fixtureId);
  if (scope.version !== 1 || scope.buildHash !== identity.buildHash || scope.sourceCommit !== identity.sourceCommit ||
      (scope.kind || 'typed-cad-v1') !== fixture.kind || !same(scope.operations, fixture.operations) ||
      scope.manifestSha256 !== fixture.manifestSha256 || (fixture.kind === 'fixed-run-v1' &&
        (scope.script !== fixture.script || scope.scriptSha256 !== fixture.scriptSha256 || scope.helperVersion !== fixture.helperVersion)))
    fail('NATIVE_FIXTURE_CHANGED', 'The exact owner-approved fixture source/build must remain current; never promote an old scope implicitly');
  return fixture;
}

function fixtureGrantOperations(grant, identity) {
  const fixture = validateFixtureGrant(grant, identity);
  if (!fixture) return null;
  if (fixture.kind !== 'typed-cad-v1') fail('NATIVE_FIXTURE_SCOPE_REQUIRED', 'This fixture grants only its fixed program, not arbitrary catalog operations');
  return fixture.operations;
}

async function nativeFixtureAction(client, options, codeHash) {
  const status = await client.call('queue-summary');
  if (status.control?.buildHash !== codeHash) fail('BUILD_CHANGED', 'CLI and broker must share the exact qualified runtime');
  const { instanceId, generation, contextEpoch } = status.control;
  return client.call('grant-native-fixture', { ...options, control: { instanceId, generation, contextEpoch, buildHash: codeHash } });
}

module.exports = { fixtureContract, grantNativeFixture, fixtureGrantOperations, validateFixtureGrant, nativeFixtureAction };
