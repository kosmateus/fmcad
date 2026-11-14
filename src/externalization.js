const { execute } = require('./dist/node-adapters/persistence/externalization-workflow');
const { validate, manifest } = require('./dist/core/application/documents/externalization-input');
const { restoreKnownPendingEvidence, preserveKnownCursor, restoreBlockedCheckpoints } = require('./dist/core/application/documents/externalization-evidence');
const { initial, slot, completeMigration } = require('./dist/core/application/documents/externalization');


module.exports={validate,manifest,initial,slot,completeMigration,restoreKnownPendingEvidence,
  preserveKnownCursor,restoreBlockedCheckpoints,execute};
