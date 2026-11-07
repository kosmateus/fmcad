'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
module.exports = function syntheticProbes(api, dir, jobId, buildHash, pointer) {
  const instance = { ...pointer.currentInstance, documentState: { status: 'complete', state: { identity: pointer.document } } };
  for (const phase of ['preflight', 'postflight']) {
    const binding = { jobId, rpcId: randomUUID(), requestHash: 'f'.repeat(64), buildHash };
    const receipt = path.join(dir, phase + '-' + binding.rpcId + '.receipt.json');
    api.durable(path.join(dir, phase + '-start.json'), { version: 2, jobId, buildHash, binding, receipt, instance: pointer.currentInstance }, true);
    api.durable(path.join(dir, phase + '-result.json'), { stage: 'instance_probe', failed: false,
      text: 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify(instance) + '\n' }, true);
    api.durable(path.join(dir, phase + '.json'), phase === 'preflight'
      ? { version: 2, jobId, buildHash, completed: true, instance } : instance, true);
    api.durable(receipt, { ...binding, terminal: true, outcome: 'succeeded', instance: pointer.currentInstance }, true);
  }
};
