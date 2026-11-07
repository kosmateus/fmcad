'use strict';

const { randomUUID } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { id } = require('./dist/core/domain/contracts');
const { createArtifactStore } = require('./dist/node-adapters/persistence/artifact-store');
const { createSelectionRuleArtifactClient } = require('./dist/node-adapters/persistence/selection-rules');
const { projectDirectory } = require('./queue-response-files');
const { selectionRulesInternal } = require('./catalog');

const publicOperations = new Set([
  'selection.rule.define',
  'selection.rule.inspect',
  'selection.rule.resolve',
  'selection.rule.check',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(label + ' must be an object');
  return value;
}

function result(value) {
  const output = object(value, 'Selection-rule Fusion result');
  return object(output.result ?? output, 'Selection-rule Fusion payload');
}

function requestContext(owner, invocation) {
  return {
    version: 1,
    clientId: id('client', 'fmcad-selection-rules'),
    requestId: id('request', randomUUID()),
    sessionId: null,
    projectId: id('project', owner.projectId),
    documentId: id('document', owner.documentFileId),
    instanceId: id('instance', randomUUID()),
    purpose: invocation.purpose || null,
  };
}

function assertInvocationOwner(context, reference) {
  for (const [key, actual, expected] of [
    ['projectId', context.projectId, reference.projectId],
    ['docFileId', context.docFileId, reference.documentFileId],
    ['docId', context.docId, reference.documentCreationId],
  ]) {
    if (actual !== undefined && actual !== null && expected !== undefined &&
        expected !== null && actual !== expected)
      throw new Error('Selection rule ownership conflict: pinned ' + key + ' differs');
  }
}

function cleanResolution(payload, reference, updatedReference) {
  const { manifest, ...publicPayload } = payload;
  return {
    success: payload.success === true,
    operation: payload.operation,
    result: {
      ...publicPayload,
      artifact: updatedReference ?? reference,
    },
  };
}

async function execute(client, operation, data, context, ports) {
  if (!publicOperations.has(operation)) throw new Error('Unknown selection rule operation');
  if (!client) throw new Error(operation + ' requires the selected Fusion backend');
  if (!context?.docId && !context?.docFileId)
    throw new Error(operation + ' requires a pinned --doc-id or --doc-file-id');
  if (operation !== 'selection.rule.define' && !context?.docFileId)
    throw new Error(operation + ' requires --doc-file-id for exact artifact ownership');

  const root = realpathSync(
    ports.projectDirectory ||
      ports.stageDependencies?.owner?.scope?.project ||
      process.cwd(),
  );
  const projectRoot = projectDirectory(root) || root;
  const artifactClient = createSelectionRuleArtifactClient(createArtifactStore(projectRoot));
  const executeNative = async (internalOperation, payload) => {
    selectionRulesInternal.authorize(internalOperation, payload);
    return result(await ports.executeNative(internalOperation, payload, context));
  };

  if (operation === 'selection.rule.define') {
    const binding = { version: 1, service: 'selection-rules', operation };
    const native = await executeNative('selection.rule.define_internal', {
      definition: data,
      _trustedBinding: binding,
    });
    const manifest = object(native.manifest, 'Defined selection rule manifest');
    assertInvocationOwner(context, {
      projectId: manifest.owner?.projectId,
      documentFileId: manifest.owner?.documentFileId,
      documentCreationId: manifest.owner?.documentCreationId,
    });
    const storeContext = requestContext(manifest.owner, context);
    const artifact = await artifactClient.write(storeContext, manifest);
    return {
      success: native.success === true,
      operation,
      result: {
        schemaVersion: 1,
        status: native.status,
        ruleId: native.ruleId,
        count: native.count,
        refs: native.refs,
        entities: native.entities,
        excludedCount: native.excludedCount,
        artifact,
        provenance: native.provenance,
        method: native.method,
        limitations: native.limitations,
      },
    };
  }

  const reference = data.artifact;
  assertInvocationOwner(context, reference);
  const owner = {
    projectId: reference.projectId,
    documentFileId: reference.documentFileId,
    documentCreationId: reference.documentCreationId,
  };
  const storeContext = requestContext(owner, context);
  const manifest = await artifactClient.read(storeContext, reference);
  if (manifest === null) {
    return {
      success: false,
      operation,
      result: { schemaVersion: 1, status: 'missing', ruleId: null, artifact: reference },
    };
  }

  const internalOperation = operation + '_internal';
  const native = await executeNative(internalOperation, {
    manifest,
    _trustedBinding: { version: 1, service: 'selection-rules', operation },
  });
  if (operation === 'selection.rule.inspect')
    return cleanResolution(native, reference, null);

  let updatedReference = null;
  if (native.status === 'resolved' && native.manifest &&
      JSON.stringify(native.manifest) !== JSON.stringify(manifest)) {
    updatedReference = await artifactClient.write(storeContext, native.manifest);
  }
  return cleanResolution(native, reference, updatedReference);
}

module.exports = { execute, publicOperations };
