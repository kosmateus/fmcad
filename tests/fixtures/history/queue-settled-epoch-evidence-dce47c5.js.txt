'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const { readJson, priorProcessAlive, sameInstance, hash, buildHash } = require('./queue-instance');
const { fileHash, directory } = require('./queue-atomic-migration-files');
const fail = message => { throw Object.assign(new Error(message), { code: 'EPOCH_UPGRADE_UNSETTLED' }); };

// Deliberately narrower than all terminal jobs: this first live-handoff contract
// carries successful typed scratch work and exact registered fixed programs only. Failure/reconciliation is not a
// second route around the original SDK0 checker-repair contract.
function settledEpochEvidence(root, state, pointer) {
  const evidence = [];
  function reference(file) {
    if (fs.realpathSync(file) !== file) fail('Settled evidence must not traverse symbolic links');
    const ref = { path: file, sha256: fileHash(file).sha256 };
    evidence.push(ref);
    return ref;
  }
  function read(file) {
    const ref = reference(file);
    const value = readJson(file, 256 * 1024 * 1024);
    if (fileHash(file).sha256 !== ref.sha256) fail('Settled evidence changed during observation');
    return value;
  }
  const jobs = Object.values(state.jobs);
  if (!jobs.length) fail('An explicit nonempty successful SDK job set is required');
  for (const job of jobs) {
    // A preserved epoch can contain jobs from earlier qualified handoffs. Pin
    // each job to its own original build; never relabel its receipts as current.
    const jobBuildHash = job.request?.buildHash;
    const payload = job.request?.payload;
    const typed = payload?.kind === 'cad' && payload.doc === pointer.document.name && payload.docId === pointer.document.creationId;
    let fixed = false;
    if (payload?.kind === 'run') {
      const clients = read(path.join(root, 'clients.json'));
      const tokenHash = clients[job.clientId];
      if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) fail('Original fixed-program client credential is unavailable');
      const grant = read(path.join(pointer.root, 'access-' + hash(job.clientId + '\0' + tokenHash) + '.json'));
      if (grant.clientId !== job.clientId || grant.clientTokenHash !== tokenHash || grant.epochId !== pointer.epochId ||
          !equal(grant.document, pointer.document) || grant.nativeFixture?.kind !== 'fixed-run-v1')
        fail('A carried program requires its original credential/document-bound fixed grant');
      const fixture = require('./queue-native-fixture-grant').fixtureContract(grant.nativeFixture.fixtureId);
      const script = payload.request?.name;
      if (typeof script !== 'string' || !path.isAbsolute(script) || !script.endsWith('/' + fixture.script))
        fail('Carried program source is not from its exact original installed runtime');
      const installation = script.slice(0, -fixture.script.length - 1);
      if (buildHash(installation) !== jobBuildHash || fileHash(script).sha256 !== fixture.scriptSha256)
        fail('Original fixed program/runtime bytes changed');
      reference(script); reference(path.join(installation, 'runtime-build.json'));
      require('./queue-fixed-fixture-admission').fixedFixtureAdmission(pointer, job.request, grant, {
        installation, identity: { buildHash: jobBuildHash, sourceCommit: grant.nativeFixture.sourceCommit },
      });
      fixed = true;
    }
    if (!/^[a-f0-9-]{36}$/.test(job.id || '') || job.state !== 'succeeded' ||
        job.code !== 'EXECUTION_COMPLETE' || job.details?.sdkSettled !== true ||
        (!typed && !fixed) || job.request.isolatedEpoch !== pointer.epochId ||
        !/^[a-f0-9]{64}$/.test(jobBuildHash || '') || job.sequenceId ||
        job.dispatch?.rpcState !== 'terminal' || !Number.isSafeInteger(job.dispatch.rpcCount) || job.dispatch.rpcCount < 1 ||
        job.dispatch.completedCount !== job.dispatch.rpcCount)
      fail('Each carried job must be known successful, typed, document-bound and SDK-settled without a lease');
    const dir = path.join(root, 'jobs', job.id);
    directory(dir);
    const outcome = read(path.join(dir, 'outcome.json'));
    if (outcome.state !== job.state || outcome.code !== job.code || outcome.sdkSettled !== true ||
        outcome.exitCode !== 0 || outcome.publicationOutcome !== 'published' ||
        !equal(outcome, { state: job.state, ...job.details }))
      fail('Independent worker outcome must agree with the terminal queue record');
    const worker = read(path.join(dir, 'worker-identity.json'));
    if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0 || typeof worker.birth !== 'string' ||
        !worker.birth || priorProcessAlive(worker) !== false)
      fail('The exact local SDK worker must be proven dead');
    const probeReceipts = new Set();
    for (const phase of ['preflight', 'postflight']) {
      const start = read(path.join(dir, phase + '-start.json'));
      const result = read(path.join(dir, phase + '-result.json'));
      const summary = read(path.join(dir, phase + '.json'));
      const instance = phase === 'preflight' ? summary.instance : summary;
      const b = start.binding;
      if (start.version !== 2 || start.jobId !== job.id || start.buildHash !== jobBuildHash ||
          !sameInstance(start.instance, pointer.currentInstance) || !b || b.jobId !== job.id || b.buildHash !== jobBuildHash ||
          !/^[a-f0-9-]{36}$/.test(b.rpcId || '') || !/^[a-f0-9]{64}$/.test(b.requestHash || '') ||
          start.receipt !== path.join(dir, phase + '-' + b.rpcId + '.receipt.json') ||
          result.failed !== false || result.stage !== 'instance_probe' ||
          !sameInstance(instance, pointer.currentInstance) || instance.documentState?.status !== 'complete' ||
          instance.documentState.state?.identity?.creationId !== pointer.document.creationId ||
          instance.documentState.state.identity.name !== pointer.document.name ||
          instance.documentState.state.identity.fileId !== null ||
          (phase === 'preflight' && (summary.completed !== true || summary.jobId !== job.id || summary.buildHash !== jobBuildHash)))
        fail('Every pre/postflight must independently finish on the exact scratch and process');
      const lines = typeof result.text === 'string' ? result.text.split('\n').filter(line => line.startsWith('FMCAD_QUEUE_INSTANCE ')) : [];
      if (lines.length !== 1 || !equal(JSON.parse(lines[0].slice('FMCAD_QUEUE_INSTANCE '.length)), instance))
        fail('Probe output differs from the published document/process observation');
      const remote = read(start.receipt);
      if (remote.terminal !== true || remote.outcome !== 'succeeded' || !sameInstance(remote.instance, pointer.currentInstance) ||
          Object.keys(b).some(key => !equal(remote[key], b[key]))) fail('Probe lacks its original terminal physical receipt');
      probeReceipts.add(path.basename(start.receipt));
    }
    if (fs.readdirSync(dir).some(name => /^(preflight|postflight)-.*\.receipt\.json$/.test(name) && !probeReceipts.has(name)))
      fail('An unaccounted pre/postflight receipt prevents handoff');
    const names = fs.readdirSync(dir).filter(name => /^rpc-.*\.json$/.test(name)).sort();
    if (names.length !== job.dispatch.rpcCount) fail('RPC journal cardinality differs from the settled dispatch');
    const expectedRemote = new Set();
    for (const name of names) {
      const record = read(path.join(dir, name)), b = record.binding;
      if (!b || !/^[a-f0-9-]{36}$/.test(b.rpcId || '') || name !== 'rpc-' + b.rpcId + '.json' ||
          b.jobId !== job.id || b.buildHash !== jobBuildHash || b.isolatedEpoch !== pointer.epochId ||
          b.qualifiedDocumentHash !== hash(JSON.stringify(pointer.document)) || !/^[a-f0-9]{64}$/.test(b.requestHash || '') ||
          !/^[a-f0-9]{64}$/.test(b.sourceHash || '') || !sameInstance(b.auditExpectedInstance, pointer.currentInstance) ||
          !sameInstance(record.instance, pointer.currentInstance) || record.terminal !== true ||
          record.failed !== false || !(record.nonterminal === false || fixed && record.nonterminal === undefined) || record.pythonCheck?.status !== 'passed' ||
          record.receipt !== path.join(dir, 'remote-' + b.rpcId + '.json'))
        fail('Every RPC must have checked final code and exact epoch/document/process/build binding');
      const remote = read(record.receipt);
      expectedRemote.add(path.basename(record.receipt));
      if (remote.terminal !== true || remote.outcome !== 'succeeded' || !sameInstance(remote.instance, pointer.currentInstance) ||
          !equal(record.remoteReceipt, remote) || Object.keys(b).some(key => !equal(remote[key], b[key])))
        fail('A terminal successful physical receipt must independently match every RPC binding');
      const native = require('./queue-native-receipt');
      const declaration = native.start(record);
      if (declaration) {
        read(record.receipt + '.native-start.json');
        const completion = native.completion(record, declaration);
        if (!completion || completion.outcome !== 'succeeded') fail('Native command lifecycle must be known completed');
        read(record.receipt + '.native-end.json');
        expectedRemote.add(path.basename(record.receipt) + '.native-start.json');
        expectedRemote.add(path.basename(record.receipt) + '.native-end.json');
      }
    }
    if (fs.readdirSync(dir).some(name => name.startsWith('remote-') && !expectedRemote.has(name)))
      fail('Unaccounted physical/native receipts prevent live handoff');
  }
  return evidence;
}

module.exports = { settledEpochEvidence };
