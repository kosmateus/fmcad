'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const json = require('../dist/core/application/cad/json');
const stageCore = require('../dist/core/application/stage-journal');
const documentSave = require('../dist/core/application/documents/save');
const atomic = require('../dist/core/application/cad/atomic-receipt');
const { createAuthenticatedStageOwner } = require('../dist/node-adapters/persistence/stage-owner');
const { stageReceiptReference } = require('../dist/node-adapters/persistence/stage-journal');
const { readBytes } = require('../dist/node-adapters/persistence/records');
const queueInstance = require('../queue-instance');

const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function acceptedPayload(job, accepted) {
  const retained = accepted.find(item => item.reference.kind === 'payload');
  if (!retained) throw new Error('Owning job has no retained typed payload');
  const payload = JSON.parse(retained.bytes.toString('utf8'));
  if (json.canonical(payload) !== json.canonical(job.request.payload))
    throw new Error('Retained typed payload differs from the authenticated request');
  return payload;
}
function catalogInvocation(payload) {
  if (payload?.kind === 'cad') return payload;
  if (payload?.kind === 'cad-command') return payload.invocation;
  return null;
}
function requiresPhysicalStageOwner(payload) {
  const invocation = catalogInvocation(payload);
  return !!(payload?.kind === 'run' && payload.request?.helperVersion === 'cad-v1' ||
    invocation && ['document.save.once', 'batch.run', 'definition.instantiate'].includes(invocation.operation));
}
function candidates(preflight, selector) {
  const rows = preflight.instance?.documents ?? [];
  const matching = rows.filter(row =>
    (!selector.creationId || row.id === selector.creationId) &&
    (!selector.fileId || row.fileId === selector.fileId));
  const stateIdentity = preflight.instance?.documentState?.status === 'complete'
    ? preflight.instance.documentState.state?.identity : null;
  if (selector.name && matching.some(row => typeof row.name === 'string'))
    return matching.filter(row => row.name === selector.name);
  if (selector.name && stateIdentity && stateIdentity.name !== selector.name) return [];
  if (selector.name && !stateIdentity && matching.length !== 1 && !selector.creationId && !selector.fileId) return [];
  return matching;
}
function pinFromPreflight(preflight, selector, additions = {}) {
  const rows = candidates(preflight, selector);
  if (rows.length !== 1 || typeof rows[0].id !== 'string' ||
      (typeof rows[0].fileId !== 'string' && !(additions.allowUnsaved === true && rows[0].fileId === null && rows[0].isSaved === false)))
    throw new Error('Authenticated document selector does not identify exactly one open document');
  const pinAdditions = { ...additions };
  delete pinAdditions.allowUnsaved;
  const result = { creationId: rows[0].id, fileId: rows[0].fileId, ...pinAdditions };
  if (selector.name) result.selectorName = selector.name;
  const snapshot = preflight.instance?.documentState;
  const identity = snapshot?.status === 'complete' ? snapshot.state?.identity : null;
  if (identity?.creationId === result.creationId && identity?.fileId === result.fileId && Number.isSafeInteger(identity.version))
    result.version = identity.version;
  return result;
}
function safeReportRoot(scope, job, reportPath) {
  const resolved = path.resolve(job.request.cwd, reportPath);
  if (!inside(scope.project, resolved)) throw new Error('Owner receipt directory escaped project scope');
  return resolved;
}
function numbered(directory) {
  if (fs.realpathSync(directory) !== directory) throw new Error('Owner receipt directory is not canonical');
  const names = fs.readdirSync(directory).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (names.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`))
    throw new Error('Owner receipt history has a sequence gap');
  return names.map((name, sequence) => {
    const file = path.join(directory, name);
    const bytes = readBytes(file, 16 * 1024 * 1024, fs, file);
    return { file, bytes, record: JSON.parse(bytes.toString('utf8')), sequence };
  });
}
function documentSaveReceipt({ scope, stage, reference, lifecycle }) {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const invocation = catalogInvocation(payload);
  if (!invocation || !['document.save.once', 'document.save.observe'].includes(invocation.operation))
    return { status: 'missing' };
  const data = { ...invocation.data };
  const binding = documentSave.bindingFor(data);
  if (scope.document !== json.canonical(binding.target) || stage.id !== 'document.save.once' || stage.requestHash !== binding.requestHash ||
      reference !== stageReceiptReference(Buffer.from(json.canonical(binding), 'utf8')))
    return { status: 'corrupt' };
  const root = safeReportRoot(scope, lifecycle.job, data.reportPath);
  const directory = path.join(root, 'document-save', json.hash([binding.requestId, binding.operationId]));
  let records;
  try { records = numbered(directory); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'missing' }; throw error; }
  if (!records.length) return { status: 'missing' };
  const states = new Set(['submit_uncertain', 'accepted', 'pending', 'complete', 'failed', 'blocked', 'unknown', 'noop']);
  for (const { record, sequence } of records) {
    if (record.sequence !== sequence || record.operation !== 'document.save.once' ||
        json.canonical(record.binding) !== json.canonical(binding) ||
        !record.result || record.state !== record.result.status || !states.has(record.state))
      return { status: 'corrupt' };
  }
  const last = records.at(-1);
  const result = last.record.result;
  const accepted = records.findLast(item =>
    item.record.result?.accepted === true && item.record.result?.changed === true &&
    ['accepted', 'pending', 'complete'].includes(item.record.result?.status));
  if (result.status !== 'complete' || result.changed !== true ||
      (result.baselineVersion !== undefined && result.baselineVersion !== binding.target.version) ||
      !Number.isSafeInteger(result.resultingVersion) ||
      result.resultingVersion <= binding.target.version || result.cloudComplete !== true || !lifecycle.rpcReceipts.length)
    return { status: 'unknown', reason: `Document save receipt is not terminal-complete: ${json.canonical(result)}` };
  const sha256 = digest(last.bytes);
  const nativeEvidence = accepted ? accepted.bytes : Buffer.from(json.canonical({
    submitIntent: records.find(item => item.record.result?.status === 'submit_uncertain')?.bytes.toString('base64') ?? null,
    rpcReceipts: lifecycle.rpcReceipts.map(item => ({ binding: item.binding, receipt: item.sha256, native: item.nativeSha256 ?? null })),
  }), 'utf8');
  return { status: 'completed', sha256, ownerTerminalSha256: sha256, nativeTerminalSha256: digest(nativeEvidence),
    postflightSha256: lifecycle.postflightEvidenceSha256 };
}
function batchBinding(payload, job) {
  const invocation = catalogInvocation(payload);
  if (!invocation) throw new Error('Batch receipt has no catalog invocation');
  const request = { ...invocation.data };
  delete request.mode;
  delete request.reportPath;
  const context = Object.fromEntries(Object.entries({
    doc: invocation.doc,
    docId: invocation.docId,
    docFileId: invocation.docFileId,
    component: invocation.component,
    projectId: invocation.projectId,
    preview: invocation.preview === true,
  }).filter(([, value]) => value !== undefined));
  const requestHash = json.hash({ request, context });
  const reportPath = invocation.data.reportPath || path.join('.fmcad-batch', invocation.data.runId);
  return { invocation, request, context, requestHash, reportPath: path.resolve(job.request.cwd, reportPath) };
}
function batchReceipt({ scope, stage, reference, lifecycle }) {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const binding = batchBinding(payload, lifecycle.job);
  const pinned = JSON.parse(scope.document);
  const stageRequestHash = json.hash({ jobRequestHash: lifecycle.job.hash, reportRequestHash: binding.requestHash });
  if (!['batch.run', 'definition.instantiate'].includes(binding.invocation.operation) ||
      (binding.invocation.docId && pinned.creationId !== binding.invocation.docId) ||
      (binding.invocation.docFileId && pinned.fileId !== binding.invocation.docFileId) ||
      !['batch.run', 'batch.atomic'].includes(stage.id) || stage.requestHash !== stageRequestHash ||
      reference !== stageReceiptReference(Buffer.from(json.canonical({ operation: stage.id, requestHash: stageRequestHash }), 'utf8')))
    return { status: 'corrupt' };
  if (stage.id === 'batch.atomic') {
    let atomicRecords;
    try {
      atomicRecords = numbered(safeReportRoot(scope, lifecycle.job, binding.reportPath));
    }
    catch { return { status: 'unknown' }; }
    if (!atomicRecords.length) return { status: 'missing' };
    let atomicReport;
    try { atomicReport = atomic.validateOwnedAtomicHistory(atomicRecords.map(item => item.record), binding, pinned); }
    catch { return { status: 'corrupt' }; }
    const finalRecord = atomicRecords.at(-1)?.record;
    if (atomicReport.status !== 'success' || atomicReport.outcome !== 'committed' ||
        finalRecord?.journal?.event !== 'finalized' || finalRecord.journal.nativeOutcome !== 'committed' ||
        !lifecycle.rpcReceipts.some(item => item.nativeSha256))
      return { status: 'unknown' };
    const last = atomicRecords.at(-1);
    const receiptSha = digest(last.bytes);
    const nativeSet = digest(Buffer.from(json.canonical(lifecycle.rpcReceipts.map(item => ({
      binding: item.binding, receipt: item.sha256, native: item.nativeSha256 ?? null,
    }))), 'utf8'));
    return { status: 'completed', sha256: receiptSha, ownerTerminalSha256: receiptSha,
      nativeTerminalSha256: nativeSet, postflightSha256: lifecycle.postflightEvidenceSha256 };
  }
  let reportDirectory;
  try { reportDirectory = safeReportRoot(scope, lifecycle.job, binding.reportPath); }
  catch { return { status: 'unknown' }; }
  let terminal;
  try { terminal = require('../batch').readBatchReportSync(reportDirectory); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'missing' }; return { status: 'corrupt', reason: error.message }; }
  const report = terminal.report;
  if (![1, 2].includes(report.version) || report.operation !== 'batch.run' ||
      report.requestHash !== binding.requestHash ||
      json.canonical(report.request) !== json.canonical(binding.request) ||
      json.canonical(report.context) !== json.canonical(binding.context))
    return { status: 'corrupt' };
  if (report.status !== 'success' || report.success !== true || !Array.isArray(report.steps) ||
      lifecycle.rpcReceipts.length === 0 ||
      report.steps.some(step => step.status !== 'success' || (!step.expectFail && (step.output?.success !== true || step.output?.failed === true))))
    return { status: 'unknown' };
  const sha256 = digest(terminal.bytes);
  const nativeSet = digest(Buffer.from(json.canonical(lifecycle.rpcReceipts.map(item => ({
    binding: item.binding, receipt: item.sha256, native: item.nativeSha256 ?? null,
  }))), 'utf8'));
  return { status: 'completed', sha256, ownerTerminalSha256: sha256, nativeTerminalSha256: nativeSet,
    postflightSha256: lifecycle.postflightEvidenceSha256 };
}
function parseHelperResult(text) {
  const lines = String(text).split(/\r?\n/).filter(line => line.startsWith('FMCAD_RESULT '));
  if (lines.length !== 1) return null;
  try { return JSON.parse(lines[0].slice('FMCAD_RESULT '.length)); }
  catch { return null; }
}
function helperBinding(job, accepted, payload) {
  const scriptPath = typeof payload?.request?.name === 'string'
    ? path.resolve(job.request.cwd, payload.request.name) : null;
  const source = accepted.find(item => item.reference.kind === 'source' && item.reference.originalPath === scriptPath);
  if (!source || payload?.kind !== 'run' || payload.request.helperVersion !== 'cad-v1') return null;
  return json.hash({ jobHash: job.hash, sourceHash: source.reference.sha256,
    helperVersion: payload.request.helperVersion, docId: payload.request.identity.docId ?? null,
    docFileId: payload.request.identity.docFileId ?? null });
}
function helperReceipt({ scope, stage, reference, lifecycle }) {
  const payload = acceptedPayload(lifecycle.job, lifecycle.accepted);
  const baseRequestHash = helperBinding(lifecycle.job, lifecycle.accepted, payload);
  const pinned = JSON.parse(scope.document);
  const scriptReceipts = lifecycle.rpcReceipts.filter(item => /^[a-f0-9]{64}$/.test(item.binding.sourceHash ?? ""));
  if (!baseRequestHash || stage.id !== 'python.helpers.run' || stage.requestHash !== baseRequestHash ||
      scriptReceipts.length !== 1 ||
      pinned.creationId !== payload.request.identity.docId || pinned.fileId !== (payload.request.identity.docFileId ?? null))
    return { status: 'corrupt' };
  if (reference !== stageReceiptReference(Buffer.from(json.canonical({ operation: stage.id, requestHash: baseRequestHash }), 'utf8')))
    return { status: 'corrupt' };
  const result = parseHelperResult(lifecycle.stdout);
  if (!result || result.success !== true || !Array.isArray(result.helperCallsOnly) ||
      result.error !== undefined || lifecycle.rpcReceipts.length === 0 ||
      result.helperCallsOnly.some(call => call.status !== 'completed' || call.effects !== 'observed'))
    return { status: 'unknown' };
  const sha256 = lifecycle.stdoutSha256;
  const nativeSet = digest(Buffer.from(json.canonical(lifecycle.rpcReceipts.map(item => ({
    binding: item.binding, receipt: item.sha256, native: item.nativeSha256 ?? null,
  }))), 'utf8'));
  return { status: 'completed', sha256, ownerTerminalSha256: sha256, nativeTerminalSha256: nativeSet,
    postflightSha256: lifecycle.postflightEvidenceSha256 };
}
async function createAuthenticatedStageDependencies(verifiedWorkerInputs) {
  if (!verifiedWorkerInputs?.brokerDirectory || !verifiedWorkerInputs.jobId) return null;
  const brokerDirectory = fs.realpathSync(verifiedWorkerInputs.brokerDirectory);
  const admissionDirectory = require('../queue-isolated-epoch').isolatedEpochDirectory(brokerDirectory);
  if (fs.existsSync(path.join(admissionDirectory, 'queue-state.pending.json')))
    throw new Error('Queue state has an unresolved durability marker');
  const queueFile = path.join(admissionDirectory, 'queue-state.json');
  const queue = JSON.parse(readBytes(queueFile, 128 * 1024 * 1024, fs, queueFile).toString('utf8'));
  const job = queue.jobs?.[verifiedWorkerInputs.jobId];
  if (!job || job.id !== verifiedWorkerInputs.jobId) throw new Error('Authenticated queue job is unavailable');
  const payload = job.request?.payload;
  if (!payload) return null;
  const invocation = catalogInvocation(payload);
  const isDocumentSave = invocation?.operation === 'document.save.once';
  const isBatch = invocation && ['batch.run', 'definition.instantiate'].includes(invocation.operation);
  const isHelper = payload.kind === 'run' && payload.request?.helperVersion === 'cad-v1';
  if (!isDocumentSave && !isBatch && !isHelper) return null;
  if (isHelper) require('../cad-service').decodeInvocation(payload);
  const owner = createAuthenticatedStageOwner({
    brokerDirectory,
    admissionDirectory: () => require('../queue-isolated-epoch').isolatedEpochDirectory(brokerDirectory),
    jobId: verifiedWorkerInputs.jobId,
    expectedClientId: verifiedWorkerInputs.clientId,
    expectedProject: verifiedWorkerInputs.projectDirectory,
    buildHash: queueInstance.buildHash,
    core: { canonical: json.canonical, ...stageCore },
    sameInstance: queueInstance.sameInstance,
    nativeWorkflowIdentity: queueInstance.nativeWorkflowIdentity,
    resolvePinnedDocument,
    readOriginalReceipt(input) {
      if (input.stage.id === 'document.save.once') return documentSaveReceipt(input);
      if (['batch.run', 'batch.atomic'].includes(input.stage.id)) return batchReceipt(input);
      if (input.stage.id === 'python.helpers.run') return helperReceipt(input);
      return { status: 'missing' };
    },
  });
  if (verifiedWorkerInputs.buildHash && verifiedWorkerInputs.buildHash !== owner.owner.scope.build)
    throw Object.assign(new Error('Verified worker build differs from the authenticated stage scope'), { code: 'BUILD_CHANGED' });
  const admittedPayload = acceptedPayload(owner.job, owner.accepted);
  const document = isDocumentSave ? require('../document-stages').createDocumentSaveStages(
    owner.operationDirectory, owner.owner, owner.evidence,
  ) : undefined;
  const batch = invocation && ['batch.run', 'definition.instantiate'].includes(invocation.operation)
    ? createBatchStages(owner)
    : undefined;
  const helperRequestHash = helperBinding(owner.job, owner.accepted, admittedPayload);
  if (isHelper && !helperRequestHash)
    throw new Error('cad-v1 helper job lacks retained original source bytes');
  const helper = helperRequestHash ? createHelperStages(owner, helperRequestHash) : undefined;
  return {
    owner,
    document,
    batch,
    helper,
    stage: { journalInspect: owner.inspect, resumePlan: owner.resumePlan, revalidate: owner.revalidate },
    journalInspect: owner.inspect,
    resumePlan: owner.resumePlan,
    revalidate: owner.revalidate,
  };
}
function resolvePinnedDocument(input) {
  const payload = acceptedPayload(input.job, input.accepted);
  const invocation = catalogInvocation(payload);
  if (invocation && ['document.save.once', 'document.save.observe'].includes(invocation.operation))
    return documentSave.bindingFor(invocation.data).target;
  if (payload?.kind === 'run') return pinFromPreflight(input.preflight, {
    creationId: payload.request.identity.docId, fileId: payload.request.identity.docFileId, name: payload.request.doc,
  }, { allowUnsaved: payload.request.helperVersion === 'cad-v1' });
  if (invocation) return pinFromPreflight(input.preflight, {
    creationId: invocation.docId, fileId: invocation.docFileId, name: invocation.doc,
  }, invocation.projectId ? { projectId: invocation.projectId } : {});
  throw new Error('This authenticated job does not own a document-scoped stage');
}
function createNamedStages(owner, id, requestHash) {
  const definition = { id, requestHash, mutates: true };
  const reference = stageReceiptReference(Buffer.from(json.canonical({ operation: id, requestHash }), 'utf8'));
  return {
    async plan() { owner.stages.plan([definition]); },
    async started() { owner.stages.started(id, reference); },
    context() { return { stage: { ...definition }, inspection: owner.inspect(), resumePlan: owner.resumePlan() }; },
  };
}
function createHelperStages(owner, baseRequestHash) {
  let definition;
  const id = 'python.helpers.run';
  return {
    async plan() {
      definition = { id, requestHash: baseRequestHash, mutates: true };
      owner.stages.plan([definition]);
    },
    async started() {
      if (!definition) throw new Error('Helper stage intent requires its durable plan');
      owner.stages.started(id, stageReceiptReference(Buffer.from(json.canonical({ operation: id, requestHash: baseRequestHash }), 'utf8')));
    },
    context() {
      return {
        stage: { id, requestBaseHash: baseRequestHash },
        inspection: owner.inspect(),
        resumePlan: owner.resumePlan(),
      };
    },
  };
}
function createBatchStages(owner) {
  return {
    async beforeRun({ requestHash: currentHash, atomic }) {
      const payload = acceptedPayload(owner.job, owner.accepted);
      const expectedHash = batchBinding(payload, owner.job).requestHash;
      if (currentHash !== expectedHash) throw new Error('Batch request differs from retained owner input');
      const stageRequestHash = json.hash({ jobRequestHash: owner.job.hash, reportRequestHash: currentHash });
      const stages = createNamedStages(owner, atomic ? 'batch.atomic' : 'batch.run', stageRequestHash);
      await stages.plan();
      await stages.started();
    },
  };
}

module.exports = { createAuthenticatedStageDependencies, requiresPhysicalStageOwner };
