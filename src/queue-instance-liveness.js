'use strict';
const { priorProcessAlive, sameInstance } = require('./queue-instance');
const processTuple = value => ({ pid: value.pid, birth: value.birth, version: value.version });

function requireInstanceProcess(instance, expected = 'live', observe = priorProcessAlive, label = 'Original Fusion') {
  if (!['live', 'terminated'].includes(expected)) throw Object.assign(new Error('Unknown process expectation'), { code: 'INVALID_INSTANCE_EXPECTATION' });
  const live = observe(instance);
  if (live !== true && live !== false) throw Object.assign(new Error(label + ' PID/birth liveness could not be established'),
    { code: 'INSTANCE_LIVENESS_UNAVAILABLE' });
  if (live !== (expected === 'live')) throw Object.assign(new Error(expected === 'live'
    ? label + ' PID/birth is not live' : label + ' process is not proven terminated'), { code: 'INSTANCE_CHANGED' });
  return { pid: instance.pid, birth: instance.birth, version: instance.version, live, observedAt: new Date().toISOString() };
}

function processLossAudit(upgrade) { return ['atomic-recovery-process-loss-audit-upgrade-v1',
  'isolated-scratch-epoch-upgrade-v1', 'atomic-audit-facts-recovery-upgrade-v1'].includes(upgrade?.purpose); }

function requireRecoveryProcesses(original, upgrade, observe = priorProcessAlive) {
  const lost = processLossAudit(upgrade);
  const historical = requireInstanceProcess(original, lost ? 'terminated' : 'live', observe);
  let current = null;
  if (lost) {
    if (sameInstance(original, upgrade.currentInstance))
      throw Object.assign(new Error('A process-loss audit cannot relabel the original instance as current'), { code: 'INSTANCE_CHANGED' });
    current = requireInstanceProcess(upgrade.currentInstance, 'live', observe, 'Selected current Fusion');
  }
  return { historical, current, historicalOutcome: 'unknown', endpointVerified: false };
}

module.exports = { requireInstanceProcess, requireRecoveryProcesses, processLossAudit, processTuple };
