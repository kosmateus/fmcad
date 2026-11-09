'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { QueueDomain, terminal, validateQueueOptions } = require('./dist/core/domain/queue');
const { createSnapshotStore } = require('./dist/node-adapters/persistence/records');
function monotonicEpoch() { const epoch = Date.now(), start = performance.now(); return () => Math.floor(epoch + performance.now() - start); }

// Transitional Node composition: transitions and decoding belong to QueueDomain.
class QueueState extends QueueDomain {
  constructor(dir, options = {}) {
    const now = options.now === undefined ? monotonicEpoch() : options.now;
    validateQueueOptions({ ...options, now });
    const store = createSnapshotStore(dir);
    let serialized = store.restore(), snapshot;
    if (serialized !== null) {
      try { snapshot = JSON.parse(serialized); }
      catch (error) { throw Object.assign(new Error(`Cannot restore queue snapshot: ${error.message}`), { code: 'CORRUPT_STATE' }); }
    }
    if (options.expectedSnapshotHash && createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') !== options.expectedSnapshotHash)
      throw Object.assign(new Error('Migration escrow snapshot changed before construction'), { code: 'MIGRATION_FENCE_CHANGED' });
    super({ ...options, snapshot, now,
      newId: () => randomUUID(), hash: text => createHash('sha256').update(text).digest('hex'),
      commit(draft) {
        const text = JSON.stringify(draft);
        if (text !== serialized) {
          store.commit(text); serialized = text;
          try { options.onCommittedSnapshot?.(draft, path.resolve(dir)); } catch { /* Passive transition telemetry. */ }
        }
      } });
    this.dir = path.resolve(dir); this.file = path.join(this.dir, 'queue-state.json');
  }
}

module.exports = { QueueState, terminal };
