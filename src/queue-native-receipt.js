'use strict';
const { readJson, sameInstance, nativeWorkflowIdentity } = require('./queue-instance');
module.exports = require('./dist/node-adapters/execution/native-receipt').createNativeReceipts({
  readJson, sameInstance, identity: nativeWorkflowIdentity,
});
