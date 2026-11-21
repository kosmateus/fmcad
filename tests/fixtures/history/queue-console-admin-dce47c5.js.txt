'use strict';
const path = require('node:path');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function createAdmin({ state, gate, dir, marker, buildHash, getContext, setBusy, resumeCheck,
  observeControlCompletion, close, diagnostics, durable, readJson, hash }) {
  const accepts = action => ['console-inspect', 'console-restart', 'console-reload', 'console-stop'].includes(action);
  const optional = file => {
    try { return readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  function unlock() {
    gate.adminTransition = null;
    setBusy(false);
    diagnostics();
  }
  async function handle(message, clientId) {
    if (!object(message) || !Object.hasOwn(message, 'action') || !accepts(message.action) || !identifier(clientId)) fail('INVALID_REQUEST', 'Invalid authenticated console action');
    const c = Object.hasOwn(message, 'control') ? message.control : null;
    if (!object(c) || !['requestId', 'instanceId', 'expectedGeneration'].every(key => Object.hasOwn(c, key)) ||
        !identifier(c.requestId) || !identifier(c.instanceId) || !Number.isSafeInteger(c.expectedGeneration) || c.expectedGeneration < 0) {
      fail('INVALID_REQUEST', 'Console actions require requestId, instanceId and a nonnegative safe control generation');
    }
    if (c.instanceId !== marker.nonce || c.instanceId !== gate.instanceId) fail('INSTANCE_CHANGED', 'Read the current broker instance');
    const digest = hash(c.requestId);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) fail('INVALID_HASH', 'Expected a SHA256 request hash');
    const file = path.join(dir, 'console-admin-' + digest + '.json');
    const binding = { action: message.action, clientId, requestId: c.requestId, instanceId: c.instanceId,
      expectedGeneration: c.expectedGeneration, buildHash };
    const prior = optional(file);
    if (prior) {
      if (!Object.keys(binding).every(key => prior[key] === binding[key])) fail('REQUEST_CONFLICT', 'Request ID already has a different console action or fence');
      if (prior.error) fail(prior.error.code, prior.error.message);
      if (prior.result) return prior.result;
      fail('REQUEST_PENDING', 'The original console action has no published outcome; observe its original receipt without replay');
    }
    if (c.expectedGeneration !== (state.data.controlGeneration || 0)) fail('STATE_CONFLICT', 'Broker control generation changed');
    const context = getContext();
    const summary = state.summary();
    if (context.stopping || context.busy || gate.resuming || gate.adminTransition || gate.active.size) fail('BROKER_BUSY', 'Another broker operation is in progress');
    if (context.active || summary.active || summary.blocked || summary.lease || state.data.localUnknown) fail('RECONCILIATION_REQUIRED', 'Active work, model blocks and sequence leases must settle first');
    if (context.held && !state.data.controlBlocked) fail('RECONCILIATION_REQUIRED', 'Broker ownership is held for recovery');
    if (message.action !== 'console-inspect' && state.data.controlBlocked) fail('RECONCILIATION_REQUIRED', 'Observe the original unresolved administrative receipt first');
    if (message.action !== 'console-inspect' && Object.values(state.data.jobs || {}).some(job =>
      !['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state))) fail('QUEUE_BUSY', 'Idle-only lifecycle changes cannot abandon queued or unfinished local work');
    setBusy(true);
    gate.adminTransition = message.action === 'console-inspect' ? 'inspect' : 'restart';
    let deferred = false;
    try {
      // Publish before any physical probe. An interrupted intent is never replayed.
      durable(file, { ...binding, status: 'prepared' }, true);
      if (message.action !== 'console-inspect') {
        state.pause(true, c.requestId);
        const releaseFile = path.join(dir, 'console-release-' + digest + '.json');
        const result = { acknowledged: true, requestId: c.requestId, instanceId: c.instanceId, buildHash, releaseFile };
        durable(file, { ...binding, status: 'accepted', result });
        // close()/drain() requires busy=false. The durable pause prevents queue grants.
        setBusy(false);
        deferred = true;
        setImmediate(async () => {
          try {
            try {
              await close();
              durable(releaseFile, { terminal: true, outcome: 'released', requestId: c.requestId,
                instanceId: c.instanceId, buildHash });
            } catch (error) {
              durable(releaseFile, { terminal: true, outcome: 'retained', requestId: c.requestId,
                instanceId: c.instanceId, buildHash, code: error.code || 'CLOSE_FAILED' });
            }
          } catch { /* Missing durable release proof remains an explicit unknown outcome. */ }
          finally { unlock(); }
        });
        return result;
      }
      let observation;
      let reconciled = false;
      if (state.data.controlBlocked) {
        // This callback validates the ORIGINAL record/receipt and never sends SDK traffic.
        state.pause(true, c.requestId);
        const receipt = await observeControlCompletion();
        if (!receipt || receipt.terminal !== true || !['succeeded', 'failed'].includes(receipt.outcome)) fail('RECEIPT_MISMATCH', 'Original administrative terminal receipt is unavailable');
        state._commit(d => { delete d.controlBlocked; return null; });
        if (receipt.outcome === 'failed') fail('INSPECTION_FAILED', 'The original administrative RPC completed with a failed receipt');
        observation = receipt.instance;
        reconciled = true;
      } else {
        observation = await gate.administrative(resumeCheck);
      }
      if (!observation || !Number.isSafeInteger(observation.pid) || observation.pid <= 0 ||
          !identifier(observation.birth) || !identifier(observation.version)) fail('INSTANCE_UNAVAILABLE', 'Inspection returned no complete process identity');
      const result = { at: Date.now(), instanceId: c.instanceId, requestId: c.requestId, instance: observation, reconciled };
      durable(path.join(dir, 'console-fusion-observation.json'), result);
      durable(file, { ...binding, status: 'completed', result });
      return result;
    } catch (error) {
      // resumeCheck owns the receipt-bound controlBlocked record. Never fabricate or erase it here.
      // Pause even on publication faults: absence of an observation is not evidence of idle.
      try { state.pause(true, c.requestId); } catch { /* QueueState retains its storage fault. */ }
      try { durable(file, { ...binding, status: 'failed', error: {
        code: error.code || 'ADMIN_UNKNOWN', message: error.code ? error.message : 'Administrative outcome is unknown; inspect original durable receipts' } }); }
      catch { /* An existing prepared intent still prevents replay. */ }
      throw error;
    } finally { if (!deferred) unlock(); }
  }
  return { accepts, handle };
}
module.exports = { createAdmin };
