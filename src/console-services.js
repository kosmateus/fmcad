'use strict';
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const missing = error => ['ENOENT', 'ECONNREFUSED', 'QUEUE_NOT_RUNNING'].includes(error.code);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

function createServices({ cfg, control, fs = require('node:fs'), readJson = require('./queue-instance').readJson,
  ensureBroker = require('./queue-autostart').ensureBroker, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), requestID = randomUUID, timeoutMs = 30000 }) {
  let pending = false;
  const optional = (file, maxBytes) => {
    try { return readJson(file, maxBytes); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  function fences(before, capability) {
    if (!before || before.protocol !== 1 || !identifier(before.instanceId) || !identifier(before.buildHash) ||
        !Number.isSafeInteger(before.generation) || before.generation < 0 || before.capabilities?.[capability] !== true) {
      fail('UNSUPPORTED_BROKER', 'Broker does not expose compatible explicit console actions');
    }
    const requestId = requestID();
    if (!identifier(requestId)) fail('INVALID_REQUEST', 'Invalid console request ID');
    return { requestId, instanceId: before.instanceId, expectedGeneration: before.generation };
  }
  async function observeError(error) {
    control.current = null;
    try { await control.read(); } catch { /* Observe status only; never retry the action. */ }
    throw error;
  }
  function clearOwnership(dir) {
    // lstat detects malformed files and dangling symlinks as ownership conflicts too.
    for (const name of ['broker.lock', 'autostart.lock', 'recovery.lock']) {
      try { fs.lstatSync(path.join(dir, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      fail('OWNERSHIP_CONFLICT', 'An ownership marker is present; no startup or recovery was attempted');
    }
    const saved = optional(path.join(dir, 'queue-state.json'), 128 * 1024 * 1024);
    if (saved && (saved.version !== 1 || typeof saved.paused !== 'boolean' || !saved.jobs ||
        typeof saved.jobs !== 'object' || Array.isArray(saved.jobs) ||
         saved.active !== null || saved.blocked != null || saved.lease != null || saved.controlBlocked != null || saved.localUnknown != null ||
        Object.values(saved.jobs).some(job => !job || !['queued', 'succeeded', 'failed', 'cancelled', 'expired'].includes(job.state)))) {
      fail('RECONCILIATION_REQUIRED', 'Persisted queue ownership or unfinished execution is uncertain');
    }
  }
  async function exclusive(run) {
    if (cfg.routing !== 'queue') fail('UNSUPPORTED_ROUTING', 'Explicit console service actions require queue routing');
    if (pending) fail('STATE_CONFLICT', 'A console service action is already pending');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) fail('INVALID_TIMEOUT', 'Console action deadline must be 1..600000 ms');
    pending = true;
    try { return await run(); } finally { pending = false; }
  }
  async function shared(action) {
    return exclusive(async () => {
      const before = await control.read();
      const fence = fences(before, action);
      const { createBrokerControl } = require('./dist/core/application/broker-control');
      const { createBrokerControlPort } = require('./dist/node-adapters/broker-ipc/control');
      const ipc = createBrokerControlPort(control.client);
      try { return await createBrokerControl(ipc).execute(action, fence); }
      catch (error) { return observeError(error); }
    });
  }
  const services = {
    pause: () => shared('pause'),
    drain: () => shared('drain'),
    resume: () => shared('resume'),
    stop: () => shared('stop'),
    inspect() {
      return exclusive(async () => {
        const before = await control.read();
        const request = fences(before, 'inspect');
        try { return await control.client.call('console-inspect', { control: request }); }
        catch (error) { return observeError(error); }
      });
    },
    restart({ action = 'restart', requireStopped = false } = {}) {
      return exclusive(async () => {
        let before;
        try { before = await control.read(); }
        catch (error) { if (!missing(error)) throw error; }
        const client = control.client;
        if (!client || typeof client.dir !== 'string' || !client.auth) fail('CLIENT_UNAVAILABLE', 'Queue client authentication and state directory are required');
        if (before) {
          if (requireStopped) fail('BROKER_ALREADY_RUNNING', 'Start is only valid for an absent broker; resume is separate');
          const request = fences(before, action);
          if (before.unresolved || before.activeOperations !== 0 || before.phase === 'RESUMING') fail('RECONCILIATION_REQUIRED', 'Broker must have no active or unresolved calls');
          let ack;
          try { ack = await client.call('console-' + action, { control: request }); }
          catch (error) { return observeError(error); }
          const digest = createHash('sha256').update(request.requestId).digest('hex');
          const releaseFile = path.join(client.dir, 'console-release-' + digest + '.json');
          if (!ack || ack.acknowledged !== true || ack.requestId !== request.requestId ||
              ack.instanceId !== before.instanceId || ack.buildHash !== before.buildHash || ack.releaseFile !== releaseFile) {
            fail('RECEIPT_MISMATCH', 'Restart acknowledgement is not bound to this request and broker');
          }
          const deadline = now() + timeoutMs;
          for (;;) {
            const receipt = optional(releaseFile);
            if (receipt) {
              if (receipt.terminal !== true || receipt.requestId !== request.requestId ||
                  receipt.instanceId !== before.instanceId || receipt.buildHash !== before.buildHash) fail('RECEIPT_MISMATCH', 'Release receipt binding is invalid');
              if (receipt.outcome !== 'released') fail('BROKER_RETAINED', 'Broker did not prove release; no replacement was started');
              break;
            }
            if (now() >= deadline) fail('RELEASE_UNKNOWN', 'Original broker release is unproven; no restart request was replayed');
            await sleep(Math.min(50, Math.max(1, deadline - now())));
          }
        }
        clearOwnership(client.dir);
        // ensureBroker atomically claims startup and refuses a racing foreign owner.
        await ensureBroker({ ...cfg, queue: { ...cfg.queue, autoStart: true, autoRecover: false,
          startPaused: true, exclusiveStart: true } }, client.auth);
        const after = await control.read();
        if (!after || after.protocol !== 1 || !identifier(after.instanceId) || !identifier(after.buildHash) ||
            !Number.isSafeInteger(after.generation) || after.generation < 0 ||
            before && after.instanceId === before.instanceId) fail('INSTANCE_CHANGED', 'A new compatible broker instance/build identity was not observed');
        if (after.phase === 'RECOVERY_BLOCKED' || after.unresolved) fail('RECONCILIATION_REQUIRED', 'New broker remains recovery-blocked');
        if (after.phase !== 'PAUSED' || after.gateClosed !== true || after.activeOperations !== 0) fail('START_NOT_PAUSED', 'New broker did not confirm paused startup');
        return { restarted: !!before, started: true, control: after };
      });
    }
  };
  services.start = () => services.restart({ requireStopped: true });
  services.reload = () => services.restart({ action: 'reload' });
  return services;
}
module.exports = { createServices };
