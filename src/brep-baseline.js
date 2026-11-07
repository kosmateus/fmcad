'use strict';

const { randomUUID } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { createBrepBaselineService } = require('./dist/core/application/cad/brep-baseline');
const { brepBaselineArtifacts, createBrepBaselineStage } = require('./dist/node-adapters/persistence/brep-baseline');
const { projectDirectory } = require('./queue-response-files');
const { authorize } = require('./catalog/brep-baseline-internal');

const publicOperations = new Set([
  'measure.baseline.capture',
  'measure.baseline.inspect',
  'measure.baseline.compare',
]);

async function execute(client, operation, data, context, ports) {
  if (!publicOperations.has(operation)) throw new Error('Unknown BRep baseline service operation');
  if (operation !== 'measure.baseline.inspect') {
    if (!client) throw new Error(operation + ' requires the selected Fusion backend');
    if (!context?.docId && !context?.docFileId) {
      throw new Error(operation + ' requires a pinned --doc-id or --doc-file-id');
    }
  }
  const cwd = realpathSync(
    ports.projectDirectory ||
      ports.stageDependencies?.owner?.scope?.project ||
      process.cwd(),
  );
  const root = projectDirectory(cwd) || cwd;
  const coordinator = createBrepBaselineService({
    artifacts: brepBaselineArtifacts(root),
    stage: count => createBrepBaselineStage(root, count, ports.toFusionPath),
    newSession: randomUUID,
    executeNative: (action, payload, context) => {
      authorize(payload);
      return ports.executeNative(action, payload, context);
    },
  });
  return coordinator.execute(operation, data, context || {});
}

module.exports = { execute, publicOperations };
