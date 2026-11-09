'use strict';

// Preserve the public installation anchor while the typed adapter owns behavior.
module.exports = require('./dist/node-adapters/execution/queue-instance').createQueueInstance(
  __filename, require('./dist/config-platform'),
);
