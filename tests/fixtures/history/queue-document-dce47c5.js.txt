'use strict';
const { parseFlags } = require('./cli');
const { findCommand } = require('./commands');
const { selectDocument, compareDocumentState } = require('./dist/core/domain/document');

function documentSelector(job) {
  if (job.kind === 'rpc') {
    return selectDocument({ kind: 'rpc', rpcMethod: job.request.payload?.method });
  }
  const { rest } = parseFlags(job.request.argv);
  const entry = findCommand(rest);
  const intent = { kind: entry?.kind || 'command', target: entry?.target };
  for (const [flag, key] of [['--doc', 'name'], ['--doc-id', 'creationId'], ['--doc-file-id', 'fileId']]) {
    const index = rest.indexOf(flag);
    if (index >= 0 && rest[index + 1]) intent[key] = rest[index + 1];
  }
  return selectDocument(intent);
}

module.exports = { documentSelector, compareDocumentState };
