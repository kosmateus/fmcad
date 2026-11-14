'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { buildHash, durable, readJson, processBirth } = require('./queue-instance');
async function main() {
  const audit = process.argv[2], intent = readJson(path.join(audit, 'intent.json'));
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.nonce !== intent.nonce || buildHash() !== intent.approval.buildHash ||
      fs.realpathSync(audit) !== audit || path.basename(audit) !== require('./queue-instance').hash(intent.approval.requestId))
    throw new Error('Exact qualified epoch-runtime startup intent required');
  // No losing worker publishes an error or starts a broker.
  durable(path.join(audit, 'worker.json'), { pid: process.pid, birth: processBirth() }, true);
  try {
    const broker = await require('./queue-broker').serve(input.cfg, {
      dir: path.dirname(path.dirname(audit)), confirmOwnership: true, autoReconcile: false,
      stateOptions: intent.approval.stateOptions,
      epochRuntimeUpgradeNonce: intent.nonce,
    });
    durable(path.join(audit, 'worker-ready.json'), { buildHash: broker.buildHash,
      owner: readJson(path.join(broker.dir, 'broker.lock')) }, true);
  } catch (error) {
    durable(path.join(audit, 'worker-error.json'), { code: error.code || 'EPOCH_UPGRADE_START_FAILED', message: error.message }, true);
    throw error;
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
