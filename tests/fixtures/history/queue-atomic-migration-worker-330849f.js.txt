'use strict';

const path = require('node:path');
const { durable, processBirth, priorProcessAlive, readJson } = require('./queue-instance');

async function main() {
  const audit = process.argv[2];
  const intent = readJson(path.join(audit, 'intent.json'));
  try { durable(path.join(audit, 'worker.json'), { pid: process.pid, birth: processBirth() }, true); }
  catch (error) {
    if (error.code === 'EEXIST' && priorProcessAlive(readJson(path.join(audit, 'worker.json'))) === true) return;
    throw error;
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Migration configuration exceeds 1 MiB');
  }
  const { cfg, nonce } = JSON.parse(input);
  if (nonce !== intent.nonce) throw new Error('Migration nonce changed');
  const broker = await require('./queue-broker').serve({ ...cfg, routing: 'queue', queue: {} }, {
    confirmOwnership: true, autoReconcile: false, atomicMigrationNonce: nonce,
  });
  durable(path.join(audit, 'worker-ready.json'), { buildHash: broker.buildHash,
    owner: readJson(path.join(broker.dir, 'broker.lock')) }, true);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => broker.close().catch(() => {}));
}

if (require.main === module) main().catch(error => {
  try { durable(path.join(process.argv[2], 'worker-error.json'), { code: error.code || 'MIGRATION_START_FAILED' }, true); } catch { /* Remains unknown. */ }
  process.stderr.write('Migration worker failed: ' + (error.code || 'MIGRATION_START_FAILED') + '\n');
  process.exitCode = 1;
});
