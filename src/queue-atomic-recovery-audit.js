'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash, durable, readJson, prepareReceiptScript } = require('./queue-instance');
const { preparePythonArtifact, pythonArtifactManifest, retainPythonOrigin, verifyPythonArtifact } = require('./python');
const canonicalHash = value => require('./dist/core/application/cad/json').hash(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === 'string' && !!value.trim() && value.length <= 180;
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

function auditSummary(reply, identity) {
  let text = reply?.result?.content?.find(row => row.type === 'text')?.text;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) fail('AUDIT_OUTPUT_INVALID', 'Missing bounded audit output');
  try { const wrapped = JSON.parse(text); if (typeof wrapped.stdout === 'string') text = wrapped.stdout; } catch { /* Plain result line. */ }
  const line = text.split(/\r?\n/).find(row => row.startsWith('FMCAD_RESULT '));
  let value;
  try { value = JSON.parse(line.slice(13)); } catch { fail('AUDIT_OUTPUT_INVALID', 'Malformed audit result'); }
  const keys = ['version', 'purpose', 'profile', 'requestIdentity', 'nativeOutcome', 'modelValidation',
    'rollbackVerification', 'modulePresent', 'ui', 'commandDefinition', 'document', 'snapshot', 'fingerprint'];
  if (!value || Object.keys(value).some(k => !keys.includes(k)) || value.version !== 1 ||
      value.purpose !== 'atomic-recovery-audit-v1' || value.profile !== 'atomic-recovery-counts-v1' ||
      canonicalHash(value.requestIdentity) !== canonicalHash(identity) || typeof value.modulePresent !== 'boolean' ||
      value.nativeOutcome !== 'unknown' || value.modelValidation !== 'not_performed' || value.rollbackVerification !== 'not_performed')
    fail('AUDIT_OUTPUT_INVALID', 'Audit facts cannot assert historical outcome or change scope');
  for (const [field, allowed] of Object.entries({
    ui: ['activeCommand', 'idle', 'status', 'errorType'],
    commandDefinition: ['status', 'idMatches', 'isNative', 'isValid', 'errorType'],
    document: ['status', 'identity', 'matches', 'errorType'],
    snapshot: ['identity', 'version', 'isSaved', 'isModified', 'bodies', 'sketches', 'occurrences', 'parameters', 'timeline', 'references'],
  })) {
    const row = value[field];
    if (row !== null && (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => !allowed.includes(k))))
      fail('AUDIT_OUTPUT_INVALID', 'Audit contains unapproved fields');
  }
  for (const row of [value.document, value.snapshot]) {
    if (row?.identity && canonicalHash(row.identity) !== canonicalHash(identity.resolvedIdentity))
      fail('AUDIT_OUTPUT_INVALID', 'Audit returned facts about a different document');
  }
  const errorType = row => typeof row?.errorType === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.errorType);
  const ui = value.ui, definition = value.commandDefinition, document = value.document;
  for (const row of [ui, definition, document]) {
    if (row?.errorType !== undefined && !errorType(row)) fail('AUDIT_OUTPUT_INVALID', 'Invalid getter error type');
    for (const key of ['idle', 'idMatches', 'isNative', 'isValid'])
      if (row?.[key] !== undefined && typeof row[key] !== 'boolean') fail('AUDIT_OUTPUT_INVALID', 'Non-boolean audit fact');
  }
  if (ui?.activeCommand !== undefined && (typeof ui.activeCommand !== 'string' || ui.activeCommand.length > 256) ||
      document?.matches !== undefined && (!Number.isSafeInteger(document.matches) || document.matches < 0 || document.matches > 256))
    fail('AUDIT_OUTPUT_INVALID', 'Unbounded audit facts');
  if (!(ui && (ui.status === 'unavailable' ? errorType(ui) : ui.status === undefined &&
      typeof ui.activeCommand === 'string' && ui.activeCommand.length <= 256 &&
      ui.idle === ['', 'SelectCommand'].includes(ui.activeCommand))))
    fail('AUDIT_OUTPUT_INVALID', 'Invalid bounded UI facts');
  if (!(definition && (definition.status === 'absent' ||
      definition.status === 'unavailable' && errorType(definition) ||
      ['owned', 'foreign_or_invalid'].includes(definition.status) &&
      ['idMatches', 'isNative', 'isValid'].every(k => typeof definition[k] === 'boolean') &&
      (definition.status !== 'owned' || definition.idMatches && !definition.isNative && definition.isValid))))
    fail('AUDIT_OUTPUT_INVALID', 'Invalid owned-definition facts');
  if (!(document && (document.status === 'observed' && document.identity ||
      document.status === 'unavailable' && errorType(document) ||
      ['absent', 'ambiguous'].includes(document.status) && Number.isSafeInteger(document.matches) &&
      document.matches >= 0 && document.matches <= 256)))
    fail('AUDIT_OUTPUT_INVALID', 'Invalid exact document facts');
  if (value.snapshot !== null) {
    const s = value.snapshot;
    if (!s || value.document?.status !== 'observed' ||
        !['bodies', 'sketches', 'occurrences', 'parameters', 'timeline', 'references'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) ||
        typeof s.isSaved !== 'boolean' || typeof s.isModified !== 'boolean' ||
        !(s.version === null || Number.isSafeInteger(s.version) && s.version >= 0) || canonicalHash(s) !== value.fingerprint)
      fail('AUDIT_OUTPUT_INVALID', 'Audit snapshot/fingerprint is incomplete or inconsistent');
  } else if (value.fingerprint !== null) fail('AUDIT_OUTPUT_INVALID', 'Fingerprint without a complete snapshot');
  return value;
}

// Composition ports are private broker objects, never caller-supplied options.
// No independent process/lifecycle/SDK authority. Private typed compositions may
// authorize one fixed scratch operation; the same gate/physical port still owns it.
function createRecoveryAudit(p) {
  const kind = p.kind || 'atomic-recovery-audit';
  const publication = require('./dist/core/application/execution').createReceiptPublication(
    (result, prior, receipt) => p.publishComplete(result, prior, receipt));
  async function publishComplete(result, prior, receipt) {
    if (!p.publishComplete) return;
    // Polls for one authenticated receipt join its original publication. A
    // different job/owner must never inherit that activation or its failure.
    return publication(receipt, result, prior, receipt);
  }
  async function handle(message, clientId) {
    const identifiers = p.priorObservationRequired === false ? [message.jobId, message.requestId]
      : [message.jobId, message.observationJobId, message.requestId];
    if (Object.keys(message).some(k => !['action', 'auth', 'jobId', 'observationJobId', 'requestId', 'control', ...(p.extraKeys || [])].includes(k)) ||
        !identifiers.every(identifier) || (p.priorObservationRequired === false && message.observationJobId !== undefined))
      fail('INVALID_REQUEST', 'Audit requires target, prior observation and one stable request ID');
    p.assertOwner(message.jobId, message.observationJobId, clientId);
    const directory = path.join(p.jobDirectory(message.jobId), kind);
    if (fs.existsSync(directory)) require('./queue-atomic-migration-files').directory(directory);
    const intentFile = path.join(directory, 'intent.json'), resultFile = path.join(directory, 'result.json');
    const key = p.priorObservationRequired === false ? { jobId: message.jobId, requestId: message.requestId, clientId }
      : { jobId: message.jobId, observationJobId: message.observationJobId, requestId: message.requestId, clientId };
    if (fs.existsSync(intentFile)) {
      const prior = readJson(intentFile);
      if (canonicalHash(prior.key) !== canonicalHash(key)) fail('AUDIT_ALREADY_REQUESTED', 'The original audit cannot be replayed under another request');
      if (!fs.existsSync(resultFile)) return { kind, ...key, status: 'pending', receipt: resultFile };
      const result = readJson(resultFile);
      if (result.kind !== kind || Object.entries(key).some(([k, v]) => result[k] !== v) ||
          result.nativeOutcome !== 'unknown' || result.modelValidation !== 'not_performed' || result.rollbackVerification !== 'not_performed')
        fail('AUDIT_RESULT_CHANGED', 'Stored audit result differs from its owner/purpose binding');
      if (result.status === 'complete') {
        (p.parseSummary || auditSummary)({ result: { content: [{ type: 'text',
          text: 'FMCAD_RESULT ' + JSON.stringify(result.summary) }] } }, prior.identity, prior.binding);
        const activation = await publishComplete(result, prior, resultFile);
        if (activation) return { ...result, activation };
      }
      return result;
    }
    const prepared = await p.inspect(message, clientId);
    const reader = (p.prepareReader || prepareRecoveryAudit)(p.installation, prepared.identity, prepared.binding,
      { directory, key });
    p.fence(prepared, false);
    fs.mkdirSync(directory, { mode: 0o700 });
    durable(intentFile, { version: 1, key, binding: prepared.binding, identity: prepared.identity, sourceSha256: reader.sourceSha256,
      sourceArtifactHash: reader.artifact.artifactHash }, true);
    let begun = false;
    try { p.begin(); begun = true; } catch (error) {
      durable(resultFile, { kind, ...key, status: 'failed', code: error.code,
        sdkRequestsSent: 0, nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' }, true);
      throw error;
    }
    const scope = { expectedCode: reader.artifact.script + '\n\nrun("")\n', origin: pythonArtifactManifest(reader.artifact), sent: false, summary: null };
    scope.post = async (payload, sessionId) => {
      if (['initialize', 'notifications/initialized'].includes(payload?.method))
        return p.admit(() => { p.fence(prepared, true); return p.post(payload, sessionId); });
      if (scope.sent || payload?.method !== 'tools/call' || payload.params?.name !== 'execute_python' ||
          payload.params.arguments?.code !== scope.expectedCode || payload.params.arguments.persistent !== false ||
          Object.keys(payload.params.arguments).some(k => !['code', 'persistent'].includes(k)))
        fail('AUDIT_REQUEST_INVALID', 'Only the exact broker-derived administrative script may use this grant');
      return require('./dist/core/application/execution').dispatchPrepared({
        prepare() {
          const rpcId = randomUUID();
          return prepareRecoveryAuditWire({ payload, reader, rpcId, receipt: path.join(directory, 'remote-' + rpcId + '.json'),
            instance: prepared.instance, buildHash: p.buildHash, jobId: key.jobId, auditBinding: prepared.binding });
        },
        async check(value) { value.certificate = await p.check(value.outgoing, value.artifact); },
        admit: p.admit,
        fence(value) {
          p.fence(prepared, true);
          if (hash(fs.readFileSync(reader.sourceFile)) !== reader.sourceSha256) fail('BUILD_CHANGED', 'Audit source changed after checking');
          verifyPythonArtifact(value.artifact);
          if (value.outgoing.params.arguments.code !== value.artifact.script) fail('AUDIT_BYTES_CHANGED', 'Audit wire changed after checking');
          value.certificate.fence(value.outgoing);
          if (scope.sent || fs.existsSync(path.join(directory, 'start.json'))) fail('AUDIT_ALREADY_SENT', 'No replay after an audit start');
          durable(path.join(directory, 'wire.json'), { outgoing: value.outgoing, artifact: pythonArtifactManifest(value.artifact) }, true);
          durable(path.join(directory, 'start.json'), { ...value.record, pythonCheck: value.certificate.report,
            originArtifactHash: reader.artifact.artifactHash }, true);
          scope.sent = true;
        },
        send: value => p.post(value.outgoing, sessionId),
        settle(value, response) {
          const reply = p.match(response, value.outgoing), receipt = p.remoteReceipt(value.record);
          if (reply.error || reply.result?.isError || receipt.outcome !== 'succeeded') fail('AUDIT_TRANSPORT_FAILED', 'Audit did not return a successful bound receipt');
          scope.summary = (p.parseSummary || auditSummary)(reply, prepared.identity, prepared.binding);
          durable(path.join(directory, 'response.json'), { version: 1, binding: value.record.binding,
            wireId: value.outgoing.id, callerId: payload.id, reply, summary: scope.summary }, true);
          // The physical receipt/matcher must see the unique wire ID, but the
          // enclosing real McpClient still expects its original id (normally 2).
          // Do not return the wire reply unchanged and manufacture EPROTO after
          // successful validation. Keep the original wire reply durably above.
          const callerReply = { ...reply, id: payload.id };
          return typeof response.raw === 'string' ? { ...response, raw: JSON.stringify(callerReply) } : callerReply;
        },
        unknown() { /* Retain uncertainty; a scratch operation may have run. Never replay. */ },
      });
    };
    setImmediate(async () => {
      let result;
      try {
        await p.sendScript(scope, reader.artifact.script);
        if (!scope.summary) fail('AUDIT_RECEIPT_UNAVAILABLE', 'Audit returned without bound facts');
        p.fence(prepared, false);
        result = { status: 'complete', summary: scope.summary };
      } catch (error) { result = { status: 'failed', code: error.code || 'AUDIT_UNKNOWN',
      ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}) }; }
      finally {
        try { const published = { kind, ...key, ...result, sdkRequestsSent: scope.sent ? 1 : 0,
          ...(prepared.binding.currentInstance ? { currentInstance: prepared.binding.currentInstance,
            historicalInstance: prepared.binding.historicalInstance, historicalProcessState: 'terminated',
            endpointVerified: result.status === 'complete', currentModelingAdmission: 'blocked' } : {}),
          nativeOutcome: 'unknown', modelValidation: 'not_performed', rollbackVerification: 'not_performed' };
          durable(resultFile, published, true);
          if (published.status === 'complete') await publishComplete(published,
            { key, identity: prepared.identity, binding: prepared.binding }, resultFile);
        }
        catch { /* Intent/start remain unresolved. Never replay or crash the broker on publication loss. */ }
        finally { if (begun) p.end(); }
      }
    });
    return { kind, ...key, status: 'pending', receipt: resultFile };
  }
  return { handle };
}

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
