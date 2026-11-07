'use strict';
const instance = require('./queue-instance');
const { resolveRuntimePaths, resolveChildEntrypoint } = require('./dist/config-platform');
const { PhasedWorkers: NodePhasedWorkers } = require('./dist/node-adapters/execution/phased-workers');

class PhasedWorkers extends NodePhasedWorkers {
  constructor(options) {
    super({ ...options, durable: instance.durable, readResult: instance.readJson,
      prepareRequest: require('./composition/execution-request').prepareRequest,
      processBirth: instance.processBirth, workflowNonterminal: instance.workflowNonterminal,
      responsePath: require('./queue-response-files').responsePath,
      entrypoint: resolveChildEntrypoint(resolveRuntimePaths({ anchor: __filename }), 'queue-worker') });
  }
}
module.exports = { PhasedWorkers };
