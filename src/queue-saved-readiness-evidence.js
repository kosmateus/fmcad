'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson } = require('./queue-instance');
const { fileHash } = require('./queue-atomic-migration-files');
const { settledEpochEvidence } = require('./queue-settled-epoch-evidence');
const fail = message => { throw Object.assign(new Error(message), { code: 'SAVED_READINESS_EVIDENCE_REQUIRED' }); };

function savedReadinessEvidence(root, epoch, jobId, recordedJobs) {
  const state = readJson(path.join(epoch.root, 'queue-state.json'), 256 * 1024 * 1024);
  const jobs = recordedJobs || state.jobs;
  const values = Object.values(jobs);
  if (!values.length || values.some(job => job.clientId !== epoch.ownerClientId ||
      job.request?.ownerToken !== epoch.ownerTokenHash || job.request.payload?.kind !== 'cad' ||
      !['document.status', 'snapshot'].includes(job.request.payload.operation) || !same(state.jobs[job.id], job)))
    fail('Only the original settled owner readiness set may anchor destination discovery');
  const job = jobs[jobId];
  if (!job || job.request.payload.operation !== 'document.status') fail('An actual owner document.status readiness job required');
  const evidence = settledEpochEvidence(root, { jobs }, epoch);
  const stdout = require('./queue-response-files').responsePath(root, job, 'stdout.txt');
  if (fs.statSync(stdout).size > 1024 * 1024) fail('Bounded readiness output required');
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(stdout, 'utf8')); } catch { fail('Typed original readiness output required'); }
  const observed = envelope.result;
  if (envelope.success !== true || envelope.operation !== 'document.status' || observed?.creationId !== epoch.document.creationId ||
      observed.name !== epoch.document.name || observed.saved !== false || observed.modified !== false || observed.fileId !== null)
    fail('Original independent empty unsaved readiness observation required');
  evidence.push({ path: stdout, sha256: fileHash(stdout).sha256 });
  return { job, jobs, evidence };
}

module.exports = { savedReadinessEvidence };
