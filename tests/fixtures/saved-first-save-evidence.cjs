'use strict';
// FAKE SDK ledger/output only. No native save or publication is performed.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = function fixture(t, repo) {
  const api = require(repo + '/src/queue-instance');
  const f = require('./saved-first-save.cjs')(t, repo), grant = f.grant(), origin = f.state.epoch.document;
  const accepted = f.state.submit({ ...f.request(), ownerToken: f.clients.native, timeoutMs: 1000, cwd: f.base });
  f.state.next();
  f.state.data.jobs[accepted.id].dispatch = { rpcCount: 1, completedCount: 1 };
  f.state.finish(accepted.id, { state: 'succeeded', sdkSettled: true, code: 'FAKE_FIRST_SAVE' });
  const job = f.state.data.jobs[accepted.id], dir = path.join(f.dir, 'jobs', job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = grant.savedFirstSave.destination;
  const reply = { accepted: true, status: 'pending', pending: true, targetObserved: false, current: null, copyRequested: false,
    original: { ...origin, saved: false, modified: false },
    target: { name: origin.name, projectName: destination.projectName, projectId: 'native-project',
      folderId: destination.folderId, folder: destination.folderName } };
  const observed = { name: origin.name, creationId: origin.creationId, saved: true, modified: false,
    fileId: 'new-file', fileName: origin.name, folderId: destination.folderId, projectId: 'native-project', version: 1, isComplete: true };
  api.durable(path.join(dir, 'request.json'), job.request, true);
  api.durable(path.join(dir, 'outcome.json'), job.details, true);
  api.durable(path.join(dir, 'worker-identity.json'), { pid: 2147483646, birth: 'dead:fake-save-worker' }, true);
  const rpcId = randomUUID(), receipt = path.join(dir, 'remote-' + rpcId + '.json');
  const binding = { jobId: job.id, rpcId, buildHash: f.identity.buildHash, purpose: 'saved-fixture-first-save-v1', auditFirstSave: true,
    auditExpectedDocument: origin, auditExpectedInstance: f.state.epoch.currentInstance };
  const remote = { ...binding, terminal: true, outcome: 'succeeded', instance: f.state.epoch.currentInstance };
  api.durable(receipt, remote, true);
  api.durable(path.join(dir, 'rpc-1.json'), { binding, receipt, terminal: true, failed: false,
    pythonCheck: { status: 'passed', provenance: { checker: 'basedpyright' } }, remoteReceipt: remote }, true);
  const documentState = { status: 'complete', state: { identity: { creationId: origin.creationId } } };
  api.durable(path.join(dir, 'preflight.json'), { instance: { documentState } }, true);
  api.durable(path.join(dir, 'postflight.json'), { documentState }, true);
  fs.writeFileSync(path.join(dir, 'stdout.txt'), JSON.stringify({ success: true, operation: 'document.save_as', result: reply }), { flag: 'wx' });
  return { ...f, grant, job, jobDirectory: dir, reply, observed };
};
