'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash, prepareReceiptScript } = require('./queue-instance');
const { preparePythonArtifact, pythonArtifactManifest, retainPythonOrigin } = require('./python');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const literal = value => value === null ? 'None' : value === true ? 'True' : value === false ? 'False' :
  Array.isArray(value) ? '[' + value.map(literal).join(', ') + ']' : typeof value === 'object'
    ? '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ': ' + literal(v)).join(', ') + '}' : JSON.stringify(value);

function prepareRecoveryAudit(installation, identity, context) {
  const filename = 'runtime/python/recovery/atomic_audit.py';
  const file = path.join(installation, filename), bytes = fs.readFileSync(file);
  const artifact = preparePythonArtifact([
    { id: 'atomic-recovery-audit', filename, role: 'runtime', source: bytes.toString('utf8') },
    { id: 'wrapper', filename: '<fmcad-recovery-audit>', role: 'wrapper', source: `
_AA_REQUEST: AaObject = ${literal({ identity })}
def run(_context: str) -> None:
    import adsk.core
    value = atomic_recovery_audit(_aa_cast(AaApplication, adsk.core.Application.get()), _AA_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(value, allow_nan=False))
` },
  ], { request: { identity }, context: { kind: 'atomic-recovery-audit-v1', ...context } });
  return { artifact, sourceFile: file, sourceSha256: hash(bytes) };
}

function prepareRecoveryAuditWire({ payload, reader, receipt, instance, buildHash, jobId, auditBinding, rpcId = randomUUID() }) {
  const origin = pythonArtifactManifest(reader.artifact);
  const code = payload.params.arguments.code;
  const binding = { jobId, rpcId, requestHash: hash(JSON.stringify(payload)), buildHash,
    sourceHash: hash(code), purpose: auditBinding.purpose || 'atomic-recovery-audit-v1',
    auditBindingHash: canonicalHash(auditBinding), pythonOriginHash: origin.artifactHash,
    ...(auditBinding.currentInstance ? { auditExpectedInstance: auditBinding.currentInstance } : {}),
    ...(auditBinding.expectedProcess ? { auditExpectedProcess: auditBinding.expectedProcess } : {}),
    ...(auditBinding.expectedDocument ? { auditExpectedDocument: auditBinding.expectedDocument } : {}),
    ...(auditBinding.expectedSavedDocument ? { auditExpectedSavedDocument: auditBinding.expectedSavedDocument } : {}),
    ...(auditBinding.firstSave === true ? { auditFirstSave: true } : {}) };
  const artifact = retainPythonOrigin(prepareReceiptScript(code, false, receipt, binding), origin);
  const outgoing = structuredClone(payload);
  outgoing.id = 'fmcad:' + rpcId;
  outgoing.params.arguments.code = artifact.script;
  return { outgoing, artifact, record: { binding, instance, receipt }, certificate: null };
}

const { auditSummary } = require('./dist/core/application/cad/recovery-audit');

// Private adapter composition; no independent process or SDK authority.
const { createRecoveryAudit: createTypedRecoveryAudit } = require('./dist/node-adapters/execution/recovery-audit');
const createRecoveryAudit = ports => createTypedRecoveryAudit(ports, {
  prepareReader: prepareRecoveryAudit,
  prepareWire: prepareRecoveryAuditWire,
});

async function auditAtomic(client, { jobId, observationJobId, requestId, buildHash }) {
  const status = await client.call('queue-summary');
  if (status.features?.atomicRecoveryAudit !== true) fail('AUDIT_UNSUPPORTED', 'Installed broker has no scoped recovery audit; nothing submitted');
  const control = status.control;
  if (!control || control.buildHash !== buildHash) fail('BUILD_CHANGED', 'Audit CLI and broker must have the same approved build');
  return client.call('audit-atomic', { jobId, observationJobId, requestId, control: {
    instanceId: control.instanceId, buildHash: control.buildHash,
    generation: control.generation, contextEpoch: control.contextEpoch,
  } });
}

module.exports = { createRecoveryAudit, prepareRecoveryAudit, prepareRecoveryAuditWire, auditSummary, auditAtomic };
