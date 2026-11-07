'use strict';
const { queueDirectory } = require('./queue-connection');
const { redactDiagnostic } = require('./diagnostics');
const { jsonLines, responseTaskError } = require('./dist/core');
const read = require('./dist/node-adapters/console/response').createResponseReader({ taskError: responseTaskError, jsonLines });
function openResponse(row, snapshot, { dir = queueDirectory(), cfg = {} } = {}) {
  return read(row, snapshot, { dir, redact: text => redactDiagnostic(text, cfg),
    responsePath: require('./queue-response-files').responsePath });
}
module.exports = { openResponse, jsonLines };
