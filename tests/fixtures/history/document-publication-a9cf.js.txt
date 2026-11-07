const service = require('./dist/core/application/documents/save');
const { openSaveJournal } = require('./dist/node-adapters/persistence/document-save');
const { readOperationJournal, writeOperationRecord } = require('./batch-atomic');
const { hash } = require('./batch');

async function execute(client, operation, data, context, executeCad, dependencies = {}) {
  return service.execute(operation, data, context, {
    ...(dependencies.stages ? { stages: dependencies.stages } : {}),
    open: (request, binding, create) => openSaveJournal(request, binding, create, {
      read: (directory, identity) => readOperationJournal(directory, identity, dependencies.fs),
      write: (directory, identity, sequence, value) => writeOperationRecord(directory, identity, sequence, value, dependencies.fs), hash,
    }, dependencies.fs),
    async status(target) {
      const response = await executeCad(client, 'document.status', {}, target);
      if (!response?.success || !response.result || typeof response.result !== 'object' || Array.isArray(response.result))
        throw new Error('document.status readback did not return a scoped snapshot');
      return response.result;
    },
    async save(request, target, targetContext) {
      const response = await executeCad(client, 'document.save_native', {
        requestId: request.requestId, operationId: request.operationId,
        projectId: target.projectId, fileId: target.fileId, creationId: target.creationId,
        version: target.version, description: request.description ?? ('Authorized fmcad save ' + request.operationId),
      }, targetContext);
      const result = response?.result;
      return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
    },
    now: dependencies.now ?? (() => performance.now()),
    sleep: dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  });
}
module.exports = { OPERATIONS: service.OPERATIONS, validate: service.validate, execute };
