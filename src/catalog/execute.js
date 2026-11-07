'use strict';
const { validateInvocation, localInvocation } = require('./index');

/** Shared CAD execution, independent of argv parsing, stdio framing or queue IO.
 * Workers inject only a broker-capability backend; direct MCP injects its backend. */
async function executeInvocation(value, client, onOutcome = () => {}, internal = {}) {
  const input = validateInvocation(value);
  if (!localInvocation(input) && !client) throw new Error('Catalog invocation requires a backend');
  return require('../invocation').context.run({ description: input.purpose }, async () => {
    const result = await require('../cad').executeCad(client, input.operation, input.data, {
      doc: input.doc, docId: input.docId, docFileId: input.docFileId,
      component: input.component, projectId: input.projectId, preview: input.preview === true,
    }, internal);
    onOutcome(result);
    return result;
  });
}

function invocationFailed(result, operation) {
  return require('../dist/core/application/cad/worker-command').cadCommandFailed(result, operation);
}

module.exports = { executeInvocation, invocationFailed };
