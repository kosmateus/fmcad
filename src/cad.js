const { runBatchEntry, definitionInstantiate, definitionInspect, readBatchSummary } = require('./batch');
const { failedOutcome } = require('./outcome');
const dataImport = require('./data-import');
const sketch = require('./sketch');
const curve = require('./curve');
const surface = require('./surface');
const reference = require('./reference');
const drawingPackage = require('./drawing-package');
const drawingCheck = require('./drawing-check');
const drawingExport = require('./drawing-export');
const ui = require('./ui');
const referencesRefresh = require('./references-refresh');
const externalization = require('./externalization');
const documentPublication = require('./document-publication');

const { catalog, contracts, validateCad } = require('./catalog');
const cadApplication = require('./dist/core/application/cad/execute');
const { fusionPath, mapCadPaths, prepareCadScript, buildCadScript } = require('./dist/composition/cad');

async function executeCad(client, operation, data, context, internal = {}) {
  return cadApplication.executeCad(operation, data, context, {
    validate: validateCad,
    prepare: prepareCadScript,
    execution: { execute: ({ artifact, readOnly }) => client.callTool({ featureType: 'script',
      object: { script: artifact.script, readOnly } }, 'fusion_mcp_execute', require('./python').pythonArtifactManifest(artifact)) },
    dispatch: (operation, data, context, entry) => dispatchCad(client, operation, data, context, entry, internal),
    sketchValidates: sketch.validates,
    failed: failedOutcome,
  });
}

function dispatchCad(client, operation, data, context, entry, internal = {}) {
  const executeWithInternal = (targetClient, targetOperation, targetData, targetContext) =>
    executeCad(targetClient, targetOperation, targetData, targetContext, internal);
  if (entry.curve && context.preview) return { success: true, status: 'notEvaluated', operation, mutation: false,
    plan: curve.prepare(operation, data), limitations: ['Input preflight only; native geometry and kernel not evaluated.'] };
  if (operation === 'mechanism.drive-test' && context.preview) return {
    success: true, operation, state: 'input-validated-only', mutation: false,
    document: context.doc, data,
    nativeCapability: { status: 'unknown', qualified: false },
    limitations: ['Bounded driver/follower input structure and math preflight only; no entity resolution, native reads, motion, restore or solver/coupling qualification occurred.'],
  };
  if (entry.dataImport && (context.preview || dataImport.isOffline(operation, data))) return dataImport.offlineResult(dataImport.prepare(operation, data), !!context.preview);
  if (entry.definitionMode) return definitionInspect(data, catalog, operation);
  if (context.preview && (operation === 'definition.instantiate' || entry.batchMode)) {
    const result = operation === 'definition.instantiate'
      ? definitionInstantiate(client, data, context, executeWithInternal, catalog, internal.stageDependencies?.batch)
      : runBatchEntry(client, { ...data, mode: entry.batchMode }, context, executeWithInternal, catalog, internal.stageDependencies?.batch);
    return Promise.resolve(result).then(result => ({ ...result, mutation: false }));
  }
  if (context.preview) return undefined;
  if (entry.nodeOnly) {
    const service = contracts[operation].service.handler;
    if (service === 'brep-baseline') {
      return require('./brep-baseline').execute(client, operation, data, context, {
        projectDirectory: internal.projectDirectory || internal.stageDependencies?.owner?.scope?.project,
        stageDependencies: internal.stageDependencies,
        executeNative: (action, payload, targetContext) =>
          executeCad(client, `measure.baseline.${action}_internal`, payload, targetContext, internal),
        toFusionPath: fusionPath,
      });
    }
    if (service === 'selection-rules') {
      return require('./selection-rules').execute(client, operation, data, context, {
        projectDirectory: internal.projectDirectory || internal.stageDependencies?.owner?.scope?.project,
        stageDependencies: internal.stageDependencies,
        executeNative: (nativeOperation, payload, targetContext) =>
          executeCad(client, nativeOperation, payload, targetContext, internal),
      });
    }
    if (service === 'capabilities') {
      if (operation === 'capabilities.inspect') return require('./catalog').executeCapability(operation, data);
      return require('./catalog').executeCapability(operation, data, context, {
        backend: client?.capabilities?.backend ?? client?.server?.backend,
        brokerSdkProbePort: client?.brokerSdkProbePort ?? client?.capabilities?.brokerSdkProbePort,
      });
    }
    if (service === 'ui') return ui.execute(client, operation, data, context);
    if (service === 'document-publication') {
      return documentPublication.execute(client, operation, data, context, executeCad, {
        stages: internal.stageDependencies?.document?.stages,
      });
    }
    if (service === 'externalization') return externalization.execute(client, data, context, {
      step: (action, payload, readOnly) => executeExternalizationAction(client, action, payload, readOnly),
      refresh: request => executeCad(client, 'references.refresh', request, {}),
    });
    if (service === 'references-refresh') return referencesRefresh.execute(client, data, context, {
      step: (action, payload, input, targetContext) => executeReferencesAction(client, action, payload, input, targetContext),
      inspectUi: (targetClient, request, targetContext) => {
        ui.validate('ui.inspect', request);
        return ui.execute(targetClient, 'ui.inspect', request, targetContext);
      },
      armWatcher: (targetClient, request) => ui.armWatcher(targetClient, request),
      backend: client?.capabilities?.backend ?? null,
    });
    if (service === 'reference') return reference.execute(operation, data);
    if (service === 'drawing-package') return drawingPackage.execute(operation, data);
    if (service === 'drawing-check') return drawingCheck.execute(operation, data);
    if (service === 'drawing-export') return drawingExport.execute(operation, data);
    if (service === 'batch-summary') return readBatchSummary(data);
    if (service === 'batch-atomic') {
      const atomic = require('./batch-atomic');
      atomic.setObserveReadOnlyCatalog(catalog);
      if (!client) throw new Error(`${operation} requires the selected addin backend; no offline result is available`);
      if (operation === 'batch.reconcile') return atomic.reconcileAtomicBatch(client, data.reportPath, data.operations ?? []);
      return atomic.finalizeAtomicBatch(client, data.reportPath);
    }
    if (operation === 'definition.instantiate') return definitionInstantiate(client, data, context, executeWithInternal, catalog, internal.stageDependencies?.batch);
    if (entry.batchMode) return runBatchEntry(client, { ...data, mode: entry.batchMode }, context, executeWithInternal, catalog, internal.stageDependencies?.batch);
    throw new Error('Unknown Node-only CAD operation: ' + operation);
  }
  return undefined;
}

const { buildReferencesActionScript, executeReferencesAction, executeExternalizationAction } = require('./dist/python/native-actions');

module.exports = { catalog, validateCad, buildCadScript, prepareCadScript, buildReferencesActionScript, executeReferencesAction, executeExternalizationAction,
  executeCad, mapCadPaths };
