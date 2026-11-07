'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateAtomicHistory, atomicRpcArgs } = require('./dist/core/application/cad/atomic');
const { clone, hash: canonicalHash } = require('./dist/core/application/cad/json');
const { preparePythonArtifact, cadBundleUnits } = require('./python');
const { resolveRuntimePaths } = require('./dist/config-platform');

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const scopeKeys = ['version', 'kind', 'jobId', 'requestId', 'projectDirectory', 'reportPath', 'commandId', 'sessionNonce', 'docId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxReportFiles = 128;
const maxReportFileBytes = 16 * 1024 * 1024;
const maxReportHistoryBytes = 32 * 1024 * 1024;
const fastenersScope = Object.freeze({
  jobId: '5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a',
  requestId: 'measured-fasteners-fixture-setup-20261027-1905z',
  projectDirectory: '/tmp/opencode/fmcad-backlog/measured-fasteners',
  reportPath: '/tmp/opencode/measured-fasteners-native/batch-v1',
  commandId: 'fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7',
  sessionNonce: 'a87b938ad05f67893a0af5889b7b36c3',
  docId: 'f9f27526-55d2-47bb-a4d8-312246f2de08',
});
const atomicRuntimeUnits = new Set([
  'runtime/python/fmcad/adapters/fusion/atomic.py',
  'runtime/python/fmcad/adapters/fusion/identity.py',
  'runtime/python/fmcad/adapters/fusion/values.py',
  'runtime/python/fmcad/domain/values.py',
  'assets/cad/core.py',
]);

const same = (left, right) => canonicalHash(left) === canonicalHash(right);
const statusRuntimeFilename = 'runtime/python/fmcad/adapters/fusion/atomic_status.py';

function atomicRuntimeAbiUnits(root = resolveRuntimePaths({ anchor: __filename }).installation) {
  const units = cadBundleUnits(root).filter(unit => atomicRuntimeUnits.has(unit.filename))
    .map(unit => ({ id: unit.id, filename: unit.filename, sha256: digest(unit.source) }));
  if (units.length !== atomicRuntimeUnits.size) fail('BUILD_CHANGED', 'Canonical atomic ABI source inventory is incomplete');
  return units;
}

function pythonLiteral(value) {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pythonLiteral).join(', ') + ']';
  return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ': ' + pythonLiteral(item)).join(', ') + '}';
}

function prepareAtomicStatusScript(args) {
  if (args.operation !== 'atomic_status') fail('WORKFLOW_OPERATION_NOT_ALLOWED', 'Only atomic_status may be prepared');
  const wrapper = `

_ATOMIC_STATUS_REQUEST: AtomicStatusObject = ${pythonLiteral(clone(args))}

def run(_context: str) -> None:
    import adsk.core
    import json
    _value = atomic_status_readonly(_atomic_status_cast(AtomicStatusApplication, adsk.core.Application.get()), _ATOMIC_STATUS_REQUEST)
    _summary: AtomicStatusObject = {key: _value.get(key) for key in (
        'status', 'accepted', 'completed', 'destroyed', 'cleanupCompleted',
        'definitionDeleted', 'outcome', 'terminationReason', 'idle', 'createdCount',
        'executeCount', 'executeCompleted', 'terminationCompleted', 'notStarted')}
    _identity = _value.get('identity')
    if isinstance(_identity, dict):
        _summary['identity'] = {key: _identity.get(key) for key in (
            'commandId', 'runId', 'requestHash', 'backend', 'sessionNonce',
            'documentIdentity', 'resolvedIdentity')}
    _unavailable = _value.get('unavailableEvidence')
    if isinstance(_unavailable, list) and all(isinstance(item, str) for item in _unavailable):
        _summary['unavailableEvidence'] = _unavailable[:16]
    print('FMCAD_RESULT ' + json.dumps(_summary, allow_nan=False))
`;
  const root = resolveRuntimePaths({ anchor: __filename }).installation;
  const abiPinnedUnits = atomicRuntimeAbiUnits(root);
  const reader = { id: 'atomic-status', filename: statusRuntimeFilename,
    source: fs.readFileSync(path.join(root, statusRuntimeFilename), 'utf8'), role: 'runtime' };
  const artifact = preparePythonArtifact([reader, {
    id: 'wrapper', filename: '<fmcad-wrapper>', source: wrapper, role: 'wrapper',
  }], { request: args, context: { kind: 'atomic-status-readonly-v1',
    executedUnits: [reader.filename, '<fmcad-wrapper>'], abiPinnedUnits } });
  return { artifact, abiPinnedUnits };
}

function validAtomicInvocation(invocation) {
  return object(invocation) && invocation.version === 1 && invocation.kind === 'cad' &&
    invocation.operation === 'batch.run' && object(invocation.data) &&
    (invocation.data.atomic === undefined || invocation.data.atomic === true) &&
    typeof invocation.data.reportPath === 'string' && typeof invocation.data.runId === 'string' &&
    typeof invocation.doc === 'string' && !!invocation.doc && typeof invocation.docId === 'string' && !!invocation.docId;
}

function atomicInvocationProjection(job, approvedScope = fastenersScope) {
  const payload = job?.request?.payload;
  const invocation = payload?.kind === 'cad-command' ? payload.invocation : payload;
  if (validAtomicInvocation(invocation)) return { invocation, sourceEnvelope: null };
  const r = job?.request, argv = r?.argv;
  // The original CLI job retains raw argv/hash forever. The broker wrote its
  // typed worker envelope BEFORE the first turn. Observe that immutable input,
  // never rerun argv, reread a mutable --file, or add payload to the original job.
  if (payload !== undefined || job?.id !== approvedScope.jobId || job?.requestId !== approvedScope.requestId ||
      r?.cwd !== approvedScope.projectDirectory || r?.phased !== true || !Array.isArray(argv) || argv.length !== 9 ||
      argv[0] !== 'batch' || argv[1] !== 'run' || argv[2] !== '--doc' || argv[4] !== '--doc-id' ||
      argv[5] !== approvedScope.docId || argv[6] !== '--file' || argv[8] !== '--json' ||
      typeof argv[7] !== 'string' || !path.isAbsolute(argv[7]) || !Array.isArray(r.inputFiles) ||
      r.inputFiles.length !== 1 || r.inputFiles[0]?.path !== argv[7] || !/^[a-f0-9]{64}$/.test(r.inputFiles[0]?.sha256 || '')) return null;
  try {
    const file = path.join(require('./queue-connection').queueDirectory(), 'jobs', job.id, 'request.json');
    const before = fs.lstatSync(file);
    const bytes = require('./dist/node-adapters/persistence/records').readBytes(file, maxReportFileBytes, fs, file);
    const envelope = JSON.parse(bytes.toString('utf8')), worker = envelope.request;
    const parsed = require('./cad-service').decodeInvocation(worker?.payload);
    if (envelope.id !== job.id || envelope.buildHash !== r.buildHash || !object(worker) || parsed.kind !== 'cad-command' ||
        Object.entries(r).some(([key, value]) => key !== 'argv' && !same(value, worker[key])) ||
        Object.keys(worker).some(key => !Object.hasOwn(r, key) && key !== 'payload') ||
        !same(worker.argv, require('./cad-service').policyArguments(parsed)) ||
        parsed.invocation.doc !== argv[3] || parsed.invocation.docId !== argv[5] ||
        parsed.output?.json !== true || parsed.output?.summary === true || !validAtomicInvocation(parsed.invocation)) return null;
    const after = fs.lstatSync(file);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    return { invocation: parsed.invocation, sourceEnvelope: { path: file, dev: after.dev, ino: after.ino,
      size: after.size, mtimeMs: after.mtimeMs, sha256: digest(bytes) } };
  } catch { return null; } // Missing/changed/unvalidated original input is never reconstructed by replay.
}

function sourceEnvelopeStillCurrent(snapshot) {
  if (!snapshot) return true;
  try {
    const stat = fs.lstatSync(snapshot.path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.dev === snapshot.dev && stat.ino === snapshot.ino &&
      stat.size === snapshot.size && stat.mtimeMs === snapshot.mtimeMs &&
      digest(require('./dist/node-adapters/persistence/records').readBytes(snapshot.path, maxReportFileBytes, fs, snapshot.path)) === snapshot.sha256;
  } catch { return false; }
}

function atomicInvocation(job, approvedScope = fastenersScope) {
  return atomicInvocationProjection(job, approvedScope)?.invocation ?? null;
}

function isAtomicObservationCandidate(job, originalBuildHash, approvedScope = fastenersScope) {
  const invocation = atomicInvocation(job, approvedScope);
  return !!(job && job.state === 'needs_reconciliation' && job.kind === 'command' &&
    job.id === approvedScope.jobId && job.requestId === approvedScope.requestId &&
    job.request?.cwd === approvedScope.projectDirectory &&
    Number.isSafeInteger(job.physicalTurns) && job.physicalTurns > 0 &&
    Number.isSafeInteger(job.dispatch?.rpcCount) && job.dispatch.rpcCount > 0 &&
    job.request?.backend === 'addin' && typeof originalBuildHash === 'string' &&
    job.request.buildHash === originalBuildHash && invocation?.data.atomic !== false &&
    path.resolve(job.request.cwd, invocation?.data.reportPath || '') === approvedScope.reportPath &&
    invocation?.docId === approvedScope.docId &&
    invocation?.data.runId && invocation?.data.reportPath && invocation.doc && invocation.docId);
}

function deriveAtomicHolderScope(job, reconcileInvocation, reportPathRoot = job?.request?.cwd, approvedScope = fastenersScope) {
  const invocation = atomicInvocation(job, approvedScope);
  if (!invocation || !object(reconcileInvocation) || reconcileInvocation.operation !== 'batch.reconcile' ||
      !object(reconcileInvocation.data) || typeof job.request.cwd !== 'string' || !path.isAbsolute(job.request.cwd)) return null;
  const data = reconcileInvocation.data;
  if (typeof data.reportPath !== 'string' || typeof data.blockedJobId !== 'string' ||
      typeof data.commandId !== 'string' || typeof data.sessionNonce !== 'string' ||
      data.blockedJobId !== job.id || reconcileInvocation.docId !== invocation.docId ||
      reconcileInvocation.doc !== invocation.doc ||
      path.resolve(reportPathRoot, data.reportPath) !== path.resolve(job.request.cwd, invocation.data.reportPath)) return null;
  const scope = {
    version: 1,
    kind: 'atomic_holder_status',
    jobId: job.id,
    requestId: job.requestId,
    projectDirectory: job.request.cwd,
    reportPath: path.resolve(job.request.cwd, invocation.data.reportPath),
    commandId: data.commandId,
    sessionNonce: data.sessionNonce,
    docId: reconcileInvocation.docId,
  };
  return Object.entries(approvedScope).every(([key, value]) => scope[key] === value) ? scope : null;
}

function validateScope(scope) {
  if (!object(scope) || Object.keys(scope).length !== scopeKeys.length ||
      Object.keys(scope).some(key => !scopeKeys.includes(key)) ||
      scope.version !== 1 || scope.kind !== 'atomic_holder_status' ||
      typeof scope.jobId !== 'string' || typeof scope.requestId !== 'string' ||
      typeof scope.projectDirectory !== 'string' || typeof scope.reportPath !== 'string' || typeof scope.commandId !== 'string' ||
      typeof scope.sessionNonce !== 'string' || typeof scope.docId !== 'string') {
    fail('INVALID_WORKFLOW_SCOPE', 'Atomic holder observation requires the exact version-1 scoped identity');
  }
  if (!path.isAbsolute(scope.projectDirectory) || path.resolve(scope.projectDirectory) !== scope.projectDirectory ||
      !/^fmcad_atomic_[0-9a-f]{32}$/.test(scope.commandId) || !/^[0-9a-f]{32}$/.test(scope.sessionNonce) ||
      !scope.docId.trim() || !scope.requestId.trim() || !scope.jobId.trim()) {
    fail('INVALID_WORKFLOW_SCOPE', 'Atomic holder observation identity is malformed');
  }
}

function atomicStatusSummaryFromReply(reply) {
  if (!object(reply) || reply.error || !object(reply.result) || reply.result.isError === true) {
    fail('WORKFLOW_OBSERVATION_FAILED', 'Atomic status tool call did not return a successful MCP result');
  }
  const result = reply.result;
  let stdout = object(result.structuredContent) && typeof result.structuredContent.stdout === 'string'
    ? result.structuredContent.stdout : null;
  if (stdout === null) {
    const content = Array.isArray(result.content) ? result.content.find(item => item?.type === 'text' && typeof item.text === 'string') : null;
    if (!content) fail('WORKFLOW_OBSERVATION_OUTPUT', 'Atomic status response contains no bounded text result');
    try {
      const wrapped = JSON.parse(content.text);
      stdout = object(wrapped) && typeof wrapped.stdout === 'string' ? wrapped.stdout : content.text;
    } catch { stdout = content.text; }
  }
  if (Buffer.byteLength(stdout, 'utf8') > 65536)
    fail('WORKFLOW_OBSERVATION_OUTPUT', 'Atomic status response exceeds the bounded summary size');
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('FMCAD_RESULT '));
  if (!line) fail('WORKFLOW_OBSERVATION_OUTPUT', 'Atomic status response contains no typed result');
  let summary;
  try { summary = JSON.parse(line.slice('FMCAD_RESULT '.length)); }
  catch { fail('WORKFLOW_OBSERVATION_OUTPUT', 'Atomic status result is malformed'); }
  const allowed = new Set(['status', 'accepted', 'completed', 'destroyed', 'cleanupCompleted', 'definitionDeleted',
    'outcome', 'terminationReason', 'idle', 'createdCount', 'executeCount', 'executeCompleted',
    'terminationCompleted', 'notStarted', 'identity', 'unavailableEvidence']);
  const validIdentityPart = value => object(value) && Object.keys(value).length === 3 &&
    ['name', 'creationId', 'fileId'].every(key => Object.hasOwn(value, key)) &&
    typeof value.name === 'string' && value.name.length <= 256 &&
    (value.creationId === null || typeof value.creationId === 'string' && value.creationId.length <= 256) &&
    (value.fileId === null || typeof value.fileId === 'string' && value.fileId.length <= 256);
  const validIdentity = value => object(value) && Object.keys(value).length === 7 &&
    ['commandId', 'runId', 'requestHash', 'backend', 'sessionNonce', 'documentIdentity', 'resolvedIdentity'].every(key => Object.hasOwn(value, key)) &&
    typeof value.commandId === 'string' && value.commandId.length <= 64 &&
    typeof value.runId === 'string' && value.runId.length <= 256 &&
    typeof value.requestHash === 'string' && /^[a-f0-9]{64}$/.test(value.requestHash) &&
    value.backend === 'addin' && typeof value.sessionNonce === 'string' && /^[a-f0-9]{32}$/.test(value.sessionNonce) &&
    object(value.documentIdentity) && Object.keys(value.documentIdentity).length === 3 &&
    Object.hasOwn(value.documentIdentity, 'expected') && Object.hasOwn(value.documentIdentity, 'resolved') &&
    typeof value.documentIdentity.assertionsOnly === 'boolean' && validIdentityPart(value.documentIdentity.expected) &&
    validIdentityPart(value.documentIdentity.resolved) && validIdentityPart(value.resolvedIdentity);
  if (!object(summary) || Object.keys(summary).some(key => !allowed.has(key)) ||
      Buffer.byteLength(JSON.stringify(summary), 'utf8') > 65536 ||
      (summary.status !== undefined && (typeof summary.status !== 'string' || summary.status.length > 128)) ||
      (summary.outcome !== undefined && summary.outcome !== null && !['committed', 'aborted', 'unknown'].includes(summary.outcome)) ||
      (summary.terminationReason !== undefined && summary.terminationReason !== null &&
        !(typeof summary.terminationReason === 'string' && summary.terminationReason.length <= 128) &&
        !(Number.isSafeInteger(summary.terminationReason) && summary.terminationReason >= 0)) ||
      ['accepted', 'completed', 'destroyed', 'cleanupCompleted', 'definitionDeleted', 'idle',
        'executeCompleted', 'terminationCompleted', 'notStarted'].some(key =>
        summary[key] !== undefined && summary[key] !== null && typeof summary[key] !== 'boolean') ||
      ['createdCount', 'executeCount'].some(key => summary[key] !== undefined && summary[key] !== null &&
        (!Number.isSafeInteger(summary[key]) || summary[key] < 0)) ||
      (summary.identity !== undefined && !validIdentity(summary.identity)) ||
      (summary.unavailableEvidence !== undefined && (!Array.isArray(summary.unavailableEvidence) ||
        summary.unavailableEvidence.length > 16 || summary.unavailableEvidence.some(value => typeof value !== 'string' || value.length > 256)))) {
    fail('WORKFLOW_OBSERVATION_OUTPUT', 'Atomic status result is outside the bounded identity-only schema');
  }
  return summary;
}

function validateAtomicRuntimeSourceCompatibility(prepared, originalUnitGroups) {
  if (!prepared?.artifact?.units || !Array.isArray(originalUnitGroups) || originalUnitGroups.some(group => !Array.isArray(group)))
    fail('BUILD_CHANGED', 'Original atomic Python source-unit receipts are unavailable');
  const originalUnits = new Map();
  for (const group of originalUnitGroups) {
    for (const unit of group) {
      if (!object(unit) || typeof unit.filename !== 'string' || typeof unit.sha256 !== 'string') continue;
      if (!atomicRuntimeUnits.has(unit.filename)) continue;
      const previous = originalUnits.get(unit.filename);
      if (previous && previous !== unit.sha256)
        fail('RECEIPT_MISMATCH', `Original atomic source-unit receipts conflict: ${unit.filename}`);
      originalUnits.set(unit.filename, unit.sha256);
    }
  }
  if (!Array.isArray(prepared.sourceCompatibilityUnits) || !same(prepared.sourceCompatibilityUnits, atomicRuntimeAbiUnits()))
    fail('BUILD_CHANGED', 'Atomic ABI provenance changed independently of the executed reader');
  const runtime = prepared.artifact.units.filter(unit => unit.role === 'runtime');
  if (runtime.length !== 1 || runtime[0].filename !== statusRuntimeFilename ||
      runtime[0].sha256 !== digest(fs.readFileSync(path.join(resolveRuntimePaths({ anchor: __filename }).installation, statusRuntimeFilename))))
    fail('BUILD_CHANGED', 'Executed atomic status reader is not the canonical read-only source unit');
  const current = new Map(prepared.sourceCompatibilityUnits.map(unit => [unit.filename, unit.sha256]));
  for (const filename of atomicRuntimeUnits) {
    if (typeof originalUnits.get(filename) !== 'string' || current.get(filename) !== originalUnits.get(filename))
      fail('BUILD_CHANGED', `Atomic status dependency changed since the original dispatch: ${filename}`);
  }
  return true;
}

function bindAtomicRuntimeAbi(prepared, abi) {
  if (!abi || canonicalHash(abi.proof) !== abi.hash || !same(abi.proof.abiPinnedUnits, prepared.sourceCompatibilityUnits))
    fail('BUILD_CHANGED', 'Atomic runtime ABI proof does not bind the canonical pinned source inventory');
  const original = prepared.artifact;
  const mapped = new Set(original.sourceMap.map(entry => entry.unitId));
  const artifact = preparePythonArtifact(original.units.map(unit => ({ ...unit, embedded: !mapped.has(unit.id) })), {
    request: original.request, context: { ...original.context, atomicRuntimeAbiHash: abi.hash },
  });
  return { ...prepared, artifact, script: artifact.script, atomicRuntimeAbi: abi };
}

function reportFiles(root) {
  const names = fs.readdirSync(root).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (!names.length || names.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`)) {
    fail('WORKFLOW_RECEIPT_INCOMPLETE', 'Atomic report history is missing or noncontiguous');
  }
  if (names.length > maxReportFiles) fail('WORKFLOW_RECEIPT_TOO_LARGE', 'Atomic report history exceeds the bounded observation limit');
  let totalBytes = 0;
  return names.map(name => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxReportFileBytes) {
      fail('WORKFLOW_RECEIPT_UNSAFE', 'Atomic report contains a non-regular or oversized journal entry');
    }
    totalBytes += stat.size;
    if (totalBytes > maxReportHistoryBytes) fail('WORKFLOW_RECEIPT_TOO_LARGE', 'Atomic report history exceeds the bounded observation limit');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        fail('WORKFLOW_REPORT_CHANGED', 'Atomic report entry changed while it was being read');
      bytes = fs.readFileSync(fd);
      const after = fs.lstatSync(file);
      if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size)
        fail('WORKFLOW_REPORT_CHANGED', 'Atomic report entry changed while it was being read');
    } finally { fs.closeSync(fd); }
    return { name, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest(bytes), bytes };
  });
}

async function snapshotReport(reportPath) {
  if (!path.isAbsolute(reportPath) || path.resolve(reportPath) !== reportPath) {
    fail('WORKFLOW_REPORT_PATH', 'Atomic report path must be canonical and absolute');
  }
  let dirStat, real;
  try {
    dirStat = await fsp.lstat(reportPath);
    real = await fsp.realpath(reportPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail('WORKFLOW_REPORT_MISSING', 'Atomic report directory is unavailable');
    throw error;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || real !== reportPath) {
    fail('WORKFLOW_REPORT_PATH', 'Atomic report directory must be a real, non-symlink directory');
  }
  const lockPath = path.join(reportPath, 'run.lock');
  let lock = null;
  try {
    const stat = await fsp.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('WORKFLOW_LOCK_UNSAFE', 'Atomic writer lock is not a regular file');
    lock = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest(await fsp.readFile(lockPath)) };
  } catch (error) {
    if (error.code === 'ENOENT') lock = null;
    else throw error;
  }
  const files = reportFiles(reportPath);
  const verifiedDir = await fsp.lstat(reportPath);
  if (!verifiedDir.isDirectory() || verifiedDir.isSymbolicLink() || verifiedDir.dev !== dirStat.dev || verifiedDir.ino !== dirStat.ino)
    fail('WORKFLOW_REPORT_CHANGED', 'Atomic report directory changed while its history was being read');
  const records = files.map(entry => JSON.parse(entry.bytes.toString('utf8')));
  let report;
  try { report = validateAtomicHistory(records); }
  catch (error) { fail('WORKFLOW_RECEIPT_INVALID', `Atomic report identity/history is invalid: ${error.message}`); }
  return {
    dir: reportPath,
    directory: { dev: dirStat.dev, ino: dirStat.ino },
    lock,
    files: files.map(entry => ({ name: entry.name, dev: entry.dev, ino: entry.ino,
      size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 })),
    report,
    fingerprint: digest(files.map(file => `${file.name}:${file.sha256}:${file.size}`).join('\n')),
  };
}

function snapshotStillCurrent(snapshot) {
  try {
    const directory = fs.lstatSync(snapshot.dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== snapshot.directory.dev ||
        directory.ino !== snapshot.directory.ino || fs.realpathSync(snapshot.dir) !== snapshot.dir) return false;
    const lockPath = path.join(snapshot.dir, 'run.lock');
    let lock;
    try { lock = fs.lstatSync(lockPath); }
    catch (error) { if (error.code !== 'ENOENT' || snapshot.lock !== null) return false; }
    if (lock && (!snapshot.lock || !lock.isFile() || lock.isSymbolicLink() || lock.dev !== snapshot.lock.dev ||
        lock.ino !== snapshot.lock.ino || lock.size !== snapshot.lock.size || lock.mtimeMs !== snapshot.lock.mtimeMs ||
        digest(fs.readFileSync(lockPath)) !== snapshot.lock.sha256)) return false;
    const names = fs.readdirSync(snapshot.dir).filter(name => /^\d{8}\.json$/.test(name)).sort();
    if (!same(names, snapshot.files.map(file => file.name))) return false;
    return snapshot.files.every(expected => {
      const file = path.join(snapshot.dir, expected.name);
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
        stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && digest(fs.readFileSync(file)) === expected.sha256;
    });
  } catch { return false; }
}

function validateAtomicReconcileInvocation(invocation, prepared) {
  const invocationKeys = new Set(['version', 'kind', 'operation', 'data', 'doc', 'docId', 'docFileId', 'component', 'projectId', 'purpose', 'preview']);
  if (!object(invocation) || invocation.version !== 1 || invocation.kind !== 'cad' ||
      invocation.operation !== 'batch.reconcile' || !object(invocation.data) ||
      Object.keys(invocation).some(key => !invocationKeys.has(key))) {
    fail('WORKFLOW_TYPE_NOT_ALLOWED', 'Scoped holder observation accepts typed batch.reconcile only');
  }
  const allowedData = new Set(['reportPath', 'operations', 'blockedJobId', 'commandId', 'sessionNonce']);
  if (Object.keys(invocation.data).some(key => !allowedData.has(key)) ||
      invocation.data.reportPath !== prepared.scope.reportPath ||
      (invocation.data.operations !== undefined &&
       (!Array.isArray(invocation.data.operations) || invocation.data.operations.length !== 0))) {
    fail('WORKFLOW_OBSERVATION_NOT_ALLOWED', 'Scoped reconciliation is atomic_status only; no additional operations are admitted');
  }
  const scopedKeys = ['blockedJobId', 'commandId', 'sessionNonce'];
  const scoped = scopedKeys.every(key => typeof invocation.data[key] === 'string' && invocation.data[key].trim());
  if (!scoped) {
    fail('INVALID_WORKFLOW_SCOPE', 'Scoped reconcile requires blockedJobId, commandId and sessionNonce together');
  }
  if (invocation.data.blockedJobId !== prepared.scope.jobId ||
      invocation.data.commandId !== prepared.scope.commandId ||
      invocation.data.sessionNonce !== prepared.scope.sessionNonce) {
    fail('WORKFLOW_IDENTITY_MISMATCH', 'Scoped reconcile fields differ from the validated blocked job/report identity');
  }
  const context = prepared.expectedContext;
  for (const key of ['doc', 'docId', 'docFileId', 'component', 'projectId']) {
    const expected = context[key] ?? null;
    const actual = invocation[key] ?? null;
    if (actual !== expected) fail('WORKFLOW_IDENTITY_MISMATCH', `Reconcile invocation ${key} differs from the exact report pin`);
  }
  if (invocation.preview === true) fail('WORKFLOW_OBSERVATION_NOT_ALLOWED', 'Atomic holder observation cannot be previewed or redirected');
  return true;
}

function verifyAtomicObservationFence({ prepared, jobId, observerJobId, clientId, state, initialState,
  initialActiveIds, activeIds, originalActiveIds = [], inFlight = true, resetActive, owner, expectedOwner, buildHash, expectedBuildHash,
  instance, expectedInstance, instanceAlive, resuming = false, adminTransition = null }) {
  const currentJob = state?.jobs?.[jobId];
  const observerJob = state?.jobs?.[observerJobId];
  if (!prepared || prepared.scope.jobId !== jobId || prepared.scope.clientId !== clientId ||
      !currentJob || currentJob.id !== jobId || currentJob.clientId !== clientId ||
      currentJob.requestId !== prepared.scope.requestId || currentJob.hash !== prepared.jobHash ||
      currentJob.request?.buildHash !== prepared.originalBuildHash ||
      currentJob.state !== 'needs_reconciliation' || (currentJob.dispatch?.rpcCount || 0) !== prepared.originalRpcCount ||
      !observerJob || observerJob.id !== observerJobId || observerJob.state !== 'running' ||
      observerJob.workflowObservation?.targetJobId !== jobId || observerJob.workflowObservation?.observerJobHash !== observerJob.hash ||
      observerJob.clientId !== clientId ||
      prepared.identity.commandId !== prepared.scope.commandId ||
      prepared.identity.sessionNonce !== prepared.scope.sessionNonce ||
      prepared.identity.documentIdentity?.expected?.creationId !== prepared.scope.docId ||
      prepared.identity.documentIdentity?.resolved?.creationId !== prepared.scope.docId) {
    fail('WORKFLOW_IDENTITY_MISMATCH', 'Scoped observation identity changed before SDK admission');
  }
  if (!initialState || typeof initialState.paused !== 'boolean' || !Number.isSafeInteger(initialState.controlGeneration) ||
      !Number.isSafeInteger(initialState.contextEpoch)) {
    fail('WORKFLOW_GATE_STATE_UNAVAILABLE', 'Initial pause/generation/context fence is unavailable');
  }
  if (!state || state.active !== observerJobId || state.blocked?.id !== jobId || initialState?.active !== observerJobId ||
      initialState?.blocked?.id !== jobId || state.paused !== initialState?.paused ||
      (state.controlGeneration || 0) !== initialState?.controlGeneration ||
      (state.contextEpoch || 0) !== initialState?.contextEpoch ||
      !same(state.lease ?? null, initialState?.lease ?? null) || state.controlBlocked || state.localUnknown ||
      !Array.isArray(initialActiveIds) || !Array.isArray(activeIds) || !Array.isArray(originalActiveIds) ||
      !same([...initialActiveIds].sort(), [...originalActiveIds].sort()) ||
      !same([...activeIds].filter(id => originalActiveIds.includes(id)).sort(), [...originalActiveIds].sort()) ||
      (inFlight ? activeIds.length !== originalActiveIds.length + 1 : !same([...activeIds].sort(), [...originalActiveIds].sort())) ||
      resuming || adminTransition) {
    fail('WORKFLOW_GATE_CHANGED', 'Queue holder, pause, reset or active-operation fence changed before observation');
  }
  if (state.paused !== true && state.blocked?.id !== jobId) {
    fail('WORKFLOW_GATE_OPEN', 'Scoped observation requires the original closed admission gate');
  }
  if (resetActive) fail('FUSION_RESET_IN_PROGRESS', 'A guarded Fusion reset owns the broker directory');
  if (!owner || !expectedOwner || !same(owner, expectedOwner)) {
    fail('BROKER_OWNER_CHANGED', 'Broker owner changed before scoped observation');
  }
  if (instanceAlive !== true) fail('INSTANCE_CHANGED', 'Original Fusion PID/birth identity is not currently alive');
  if (buildHash !== prepared.observerBuildHash || buildHash !== expectedBuildHash) fail('BUILD_CHANGED', 'Observer broker build changed before scoped observation');
  if (!same(instance, expectedInstance)) fail('INSTANCE_CHANGED', 'Pinned Fusion instance changed before scoped observation');
  if (!snapshotStillCurrent(prepared.snapshot)) fail('WORKFLOW_REPORT_CHANGED', 'Atomic report changed before scoped observation');
  if (prepared.atomicRuntimeAbi && !require('./atomic-runtime-abi').atomicRuntimeAbiStillCurrent(prepared.atomicRuntimeAbi))
    fail('BUILD_CHANGED', 'Original atomic runtime ABI witness changed before scoped observation');
  const approvedScope = Object.fromEntries(Object.keys(fastenersScope).map(key => [key, prepared.scope[key]]));
  const original = atomicInvocationProjection(currentJob, approvedScope);
  if (!original || canonicalHash(original.invocation) !== prepared.originalInvocationHash ||
      !same(original.sourceEnvelope, prepared.sourceEnvelope) || !sourceEnvelopeStillCurrent(prepared.sourceEnvelope))
    fail('WORKFLOW_INPUT_CHANGED', 'Original accepted atomic invocation/envelope changed before scoped observation');
  return true;
}

async function prepareAtomicHolderObservation(job, scope, { clientId, observerBuildHash, originalBuildHash,
  approvedScope = fastenersScope }) {
  validateScope(scope);
  if (!job || job.id !== scope.jobId || job.requestId !== scope.requestId || job.clientId !== clientId ||
      job.state !== 'needs_reconciliation' || job.kind !== 'command' || job.physicalTurns < 1 ||
      (job.dispatch?.rpcCount || 0) < 1) {
    fail('WORKFLOW_OWNER_OR_JOB_MISMATCH', 'Scoped atomic observation does not match the authenticated unresolved job');
  }
  if (!Object.entries(approvedScope).every(([key, value]) => scope[key] === value))
    fail('WORKFLOW_IDENTITY_MISMATCH', 'Atomic holder observation is restricted to the approved job/report/command/session/document scope');
  if (!job.request || !path.isAbsolute(job.request.cwd) || job.request.cwd !== scope.projectDirectory ||
      typeof originalBuildHash !== 'string' || !originalBuildHash ||
      job.request.buildHash !== originalBuildHash || job.request.backend !== 'addin' ||
      typeof observerBuildHash !== 'string' || !observerBuildHash) {
    fail('BUILD_CHANGED', 'Original dispatch build and current observer build must be independently pinned');
  }
  const projection = atomicInvocationProjection(job, approvedScope);
  const invocation = projection?.invocation;
  if (!invocation) fail('WORKFLOW_TYPE_NOT_ALLOWED', 'Only the exact pinned typed atomic batch invocation permits holder observation');
  const snapshot = await snapshotReport(scope.reportPath);
  const report = snapshot.report;
  const expectedRequest = clone(invocation.data);
  delete expectedRequest.mode;
  delete expectedRequest.reportPath;
  expectedRequest.atomic = true;
  const expectedContext = {
    doc: invocation.doc,
    component: invocation.component ?? null,
    projectId: invocation.projectId ?? null,
    docId: invocation.docId ?? null,
    docFileId: invocation.docFileId ?? null,
    preview: invocation.preview === true,
  };
  const contextKeys = Object.keys(expectedContext);
  const contextMatches = object(report.context) &&
    Object.keys(report.context).every(key => contextKeys.includes(key)) &&
    contextKeys.every(key => (report.context[key] ?? (key === 'preview' ? false : null)) === expectedContext[key]);
  const expectedIdentity = report.documentIdentity?.expected;
  const resolvedIdentity = report.documentIdentity?.resolved;
  const submittedReportPath = path.resolve(job.request.cwd, invocation.data.reportPath);
  const matches = report.outcome === 'unknown' && report.status === 'unknown' &&
    report.reportPath === scope.reportPath && submittedReportPath === scope.reportPath &&
    report.atomic?.effective === true && report.atomic.backend === 'addin' &&
    report.runId === invocation.data.runId && same(report.request, expectedRequest) && contextMatches &&
    report.commandId === scope.commandId && report.sessionNonce === scope.sessionNonce &&
    report.context?.doc === invocation.doc && report.context?.docId === scope.docId &&
    invocation.docId === scope.docId && expectedIdentity?.creationId === scope.docId &&
    resolvedIdentity?.creationId === scope.docId &&
    (report.context?.component ?? null) === (invocation.component ?? null) &&
    (report.context?.projectId ?? null) === (invocation.projectId ?? null) &&
    (report.context?.docFileId ?? null) === (invocation.docFileId ?? null) &&
    expectedIdentity?.name === invocation.doc &&
    expectedIdentity?.fileId === (invocation.docFileId ?? null) &&
    resolvedIdentity?.fileId === (invocation.docFileId ?? null) &&
    report.commandId === scope.commandId && report.sessionNonce === scope.sessionNonce &&
    /^fmcad_atomic_[a-f0-9]{32}$/.test(report.commandId) && /^[a-f0-9]{32}$/.test(report.sessionNonce);
  if (!matches) fail('WORKFLOW_IDENTITY_MISMATCH', 'Atomic report, worker evidence and requested document pins do not match');

  const args = atomicRpcArgs(report, 'atomic_status');
  const { artifact, abiPinnedUnits } = prepareAtomicStatusScript(args);
  const stableSnapshot = {
    dir: snapshot.dir,
    directory: snapshot.directory,
    lock: snapshot.lock,
    files: snapshot.files,
    fingerprint: snapshot.fingerprint,
  };
  return {
    scope: { ...scope, clientId },
    jobHash: job.hash,
    originalRpcCount: job.dispatch.rpcCount,
    originalBuildHash,
    observerBuildHash,
    originalInvocationHash: canonicalHash(invocation),
    sourceEnvelope: projection.sourceEnvelope,
    identity: { commandId: report.commandId, runId: report.runId, requestHash: report.requestHash,
      backend: report.atomic.backend, sessionNonce: report.sessionNonce,
      documentIdentity: report.documentIdentity, resolvedIdentity },
    expectedContext: {
      doc: report.context.doc,
      docId: report.context.docId ?? null,
      docFileId: report.context.docFileId ?? null,
      component: report.context.component ?? null,
      projectId: report.context.projectId ?? null,
    },
    reportFingerprint: snapshot.fingerprint,
    snapshot: stableSnapshot,
    args,
    artifact,
    sourceCompatibilityUnits: abiPinnedUnits,
    script: artifact.script,
    readOnly: true,
  };
}

async function readCurrentAtomicObservationReport(reportPath) {
  const snapshot = await snapshotReport(reportPath);
  const report = snapshot.report;
  if (report.status !== 'unknown' || report.outcome !== 'unknown' || report.atomic?.effective !== true ||
      report.atomic.backend !== 'addin' || !report.documentIdentity?.resolved) {
    fail('WORKFLOW_REPORT_CHANGED', 'Atomic report is no longer the same unresolved add-in workflow');
  }
  return {
    fingerprint: snapshot.fingerprint,
    snapshot: { dir: snapshot.dir, directory: snapshot.directory, lock: snapshot.lock,
      files: snapshot.files, fingerprint: snapshot.fingerprint },
    runId: report.runId,
    requestHash: report.requestHash,
    commandId: report.commandId,
    sessionNonce: report.sessionNonce,
    docId: report.context?.docId,
    identity: {
      commandId: report.commandId,
      runId: report.runId,
      requestHash: report.requestHash,
      backend: report.atomic.backend,
      sessionNonce: report.sessionNonce,
      documentIdentity: report.documentIdentity,
      resolvedIdentity: report.documentIdentity.resolved,
    },
  };
}

module.exports = { atomicStatusSummaryFromReply, deriveAtomicHolderScope, fastenersScope, isAtomicObservationCandidate,
  atomicInvocationProjection, sourceEnvelopeStillCurrent, atomicRuntimeAbiUnits, bindAtomicRuntimeAbi,
  prepareAtomicHolderObservation, readCurrentAtomicObservationReport, validateAtomicReconcileInvocation, validateAtomicRuntimeSourceCompatibility,
  verifyAtomicObservationFence, snapshotStillCurrent };
