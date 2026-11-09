'use strict';
const path = require('node:path');
const { processBirth, readJson } = require('./queue-instance');
const { exclusive } = require('./queue-atomic-migration-files');

async function main() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Successor worker configuration bound exceeded');
  }
  const { cfg, dir, audit, nonce } = JSON.parse(text);
  const owner = { pid: process.pid, birth: processBirth(), nonce };
  exclusive(path.join(audit, 'worker-claim.json'), owner);
  try {
    const broker = await require('./queue-broker').serve(cfg, { dir, confirmOwnership: true,
      deadEpochSuccessorNonce: nonce, autoReconcile: false });
    const marker = readJson(path.join(dir, 'broker.lock'));
    exclusive(path.join(audit, 'worker-ready.json'), { nonce, owner: marker,
      buildHash: broker.buildHash, sdkRequestsSent: 0 });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      broker.close().catch(error => process.stderr.write('Broker remains reserved: ' + (error.code || 'CLOSE_REFUSED') + '\n'));
    });
  } catch (error) {
    exclusive(path.join(audit, 'worker-error.json'), { nonce, code: error.code || 'SUCCESSOR_START_FAILED' });
    throw error;
  }
}
main().catch(error => { process.stderr.write((error.code || error.message) + '\n'); process.exitCode = 1; });
