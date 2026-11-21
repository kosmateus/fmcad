'use strict';

// Host wiring only; the typed adapter owns reset and recovery decisions.
module.exports = require('./dist/node-adapters/execution/fusion-reset').createFusionReset({
  QueueClient: require('./queue-client').QueueClient,
  QueueState: require('./queue-state').QueueState,
  buildHash: require('./queue-instance').buildHash,
  processBirth: require('./queue-instance').processBirth,
  ensureBroker: (...args) => require('./queue-autostart').ensureBroker(...args),
  reclaim: (...args) => require('./queue-broker').reclaim(...args),
  createBrokerControl: (...args) => require('./dist/core/application/broker-control').createBrokerControl(...args),
  createBrokerControlPort: (...args) => require('./dist/node-adapters/broker-ipc/control').createBrokerControlPort(...args),
});
