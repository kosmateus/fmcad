#!/usr/bin/env node
'use strict';
// Actual installed candidate + actual accepted smoke invocation, OFFLINE ONLY.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const opts = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--runtime', '--source-commit', '--request', '--output', '--fixture', '--settled'].includes(args[i]) || opts[args[i]] || !args[i + 1])
      throw new Error('Exact installed runtime/source/request/output/fixture required');
    opts[args[i]] = args[i + 1];
  }
  const runtime = opts['--runtime'], output = opts['--output'];
  if (opts['--settled'] !== undefined && opts['--settled'] !== 'true') throw new Error('--settled supports only true');
  const settled = opts['--settled'] === 'true';
  if (!path.isAbsolute(runtime || '') || !path.isAbsolute(output || '') || output.startsWith(runtime + path.sep) ||
      !/^[a-f0-9]{40}$/.test(opts['--source-commit'] || '')) throw new Error('Explicit canonical runtime and private external output required');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const api = require(runtime + '/src/queue-instance'), py = require(runtime + '/src/python');
  const codeHash = api.buildHash(runtime);
  assert.equal(codeHash, JSON.parse(fs.readFileSync(runtime + '/runtime-build.json')).fingerprint);
  const envelope = JSON.parse(fs.readFileSync(opts['--request']));
  const invocation = envelope.request.payload;
  assert.equal(invocation.operation, 'sketch.create');
  const artifact = require(runtime + '/src/cad').prepareCadScript(invocation.operation, invocation.data,
    { doc: invocation.doc, docId: invocation.docId, preview: invocation.preview === true });
  const physical = require(runtime + '/src/dist/fusion-transport/broker').createBrokerTransport({
    backend: 'addin', url: 'http://NEVER-SEND.invalid', timeoutMs: 180000,
  }, { version: 'installed-offline-qualification', requestTimeout: s => s.timeoutMs,
    bridgeSource: () => assert.fail('No alternate bridge') });
  physical._post = () => assert.fail('NO HTTP OR SDK in offline qualification');
  const production = require(runtime + '/src/queue-admission').createProductionQueueAdmission(runtime + '/runtime/python');
  let report, finalArtifactHash;
  physical.preparePost = async (payload, origin) => {
    const code = payload.params.arguments.code; assert.ok(code.includes('FMCAD_UI_GUARD'));
    const final = py.retainPythonOrigin(api.prepareReceiptScript(code, false, path.join(output, 'never-sent.json'), {
      jobId: 'offline-accepted-smoke-invocation', rpcId: 'offline', requestHash: api.hash(JSON.stringify(payload)),
      sourceHash: api.hash(code), buildHash: codeHash,
    }), origin);
    const outgoing = { ...payload, params: { ...payload.params, arguments: { ...payload.params.arguments, code: final.script } } };
    const certificate = await production.admission.check(outgoing, final);
    report = certificate.report; finalArtifactHash = final.artifactHash;
    assert.equal(report.status, 'passed'); assert.equal(report.provenance.checker, 'basedpyright');
    certificate.fence(outgoing);
    const altered = structuredClone(outgoing); altered.params.arguments.code += '\n# changed bytes';
    assert.throws(() => certificate.fence(altered));
    const forged = structuredClone(final); forged.context.origin.segments[0].startLine++;
    await assert.rejects(production.admission.check(outgoing, forged));
    return { fence() {}, send() { assert.fail('No prepared send'); } };
  };
  await physical.prepareCallTool({ featureType: 'script', object: { script: artifact.script } },
    'fusion_mcp_execute', py.pythonArtifactManifest(artifact));
  assert.ok(report); assert.equal(fs.existsSync(path.join(output, 'never-sent.json')), false);
  // Real packaged broker startup, explicit synthetic filesystem/physical fixture.
  const fixtureRoot = path.join(output, 'startup-fixture'); fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  const f = require(opts['--fixture'])(fixtureRoot, runtime), original = fs.readFileSync(path.join(f.dir, 'queue-state.json'));
  if (settled) require(runtime + '/src/queue-epoch-runtime-upgrade').assertSettledEpochUpgrade(f.paused, f.approval, { paused: true });
  const epochState = fs.readFileSync(path.join(f.pointer.root, 'queue-state.json')); let sends = 0;
  const broker = await require(runtime + '/src/queue-broker').serve(f.cfg, { dir: f.dir, confirmOwnership: true,
    epochRuntimeUpgradeNonce: f.nonce, autoReconcile: false, createBackend: () => ({ server: { timeoutMs: 1000 },
      _parse: JSON.parse, _post() { sends++; assert.fail('No startup SDK'); }, callTool() { sends++; assert.fail('No probe'); } }) });
  assert.equal(sends, 0); assert.equal(broker.status().admissionEpoch, f.pointer.epochId);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'queue-state.json')), original);
  assert.deepEqual(fs.readFileSync(path.join(f.pointer.root, 'queue-state.json')), epochState);
  await broker.close();
  await assert.rejects(new (require(runtime + '/src/client').McpClient)({ routing: 'direct' }).callTool(), { code: 'QUEUE_REQUIRED' });
  const result = { version: 1, qualifiedAt: new Date().toISOString(), sourceCommit: opts['--source-commit'], buildHash: codeHash,
    passed: true, productionAdmission: true, epochRuntimeUpgradeQualified: true,
    actualAcceptedInvocation: { requestId: envelope.request.requestId, operation: invocation.operation,
      invocationHash: api.hash(JSON.stringify(invocation)), reference: { path: opts['--request'], sha256: api.hash(fs.readFileSync(opts['--request'])) } },
    actualInstalledRealAddinUiGuard: true, completeOriginRuntimeUnits: artifact.units.length, finalArtifactHash,
    realChecker: report, finalByteTamperRejected: true, forgedOriginSegmentRejected: true,
    installedMetadataOnlyEpochStartup: true, syntheticStartupHistoryByteIdentical: true,
    publicDirectAccessRejected: true, liveSdkRequestsSent: 0, actualModelGeometryValidated: false,
    historicalOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' };
  if (settled) {
    result.settledEpochRuntimeUpgradeQualified = true;
    result.syntheticSettledJobs = f.approval.settledJobIds.length;
    result.syntheticSettledEvidenceHash = f.approval.settledEvidenceHash;
  }
  fs.writeFileSync(path.join(output, 'installed-qualification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: true, sourceCommit: result.sourceCommit, buildHash: codeHash,
    actualInstalledRealAddinUiGuard: true, actualAcceptedInvocationHash: result.actualAcceptedInvocation.invocationHash,
    sdkRequestsSent: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
