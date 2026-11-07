const path = require('node:path');
const { pythonValue, pythonLiteral, prepareCadBundle } = require('./python');
const { resolveRuntimePaths, detectPlatform, toWindowsPath } = require('./dist/config-platform');
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
const { planCadScript } = require('./dist/core/application/cad/prepare');

function fusionPath(value) {
  if (typeof value !== 'string') throw new Error('File path must be a string');
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(value)) return value;
  const absolute = path.resolve(value);
  return toWindowsPath(absolute, detectPlatform());
}

function mapCadPaths(operation, data) {
  const out = structuredClone(data);
  if (operation.startsWith('export.') || operation.startsWith('checkpoint.') || operation === 'import.file') {
    if (out.path) out.path = fusionPath(out.path);
    if (out.directory) out.directory = fusionPath(out.directory);
    if (out.parts) for (const part of out.parts) part.path = fusionPath(part.path);
  }
  if (operation === 'shot.pack') for (const shot of out.shots) shot.path = fusionPath(shot.path);
  if (operation === 'view.compare') for (const field of ['left', 'right']) out[field] = fusionPath(out[field]);
  if (operation === 'texture.heightmap' && out.path) out.path = fusionPath(out.path);
  if (['motion.sample', 'animation.joints', 'explode.render'].includes(operation)) {
    if (out.directory) out.directory = fusionPath(out.directory);
    if (out.frameFiles) out.frameFiles = out.frameFiles.map(fusionPath);
  }
  if (operation === 'animation.export') {
    if (out.frames) out.frames = out.frames.map(fusionPath);
    if (out.output) out.output = fusionPath(out.output);
  }
  return out;
}

function prepareCadScript(operation, data, context) {
  const entry = validateCad(operation, data);
  if (operation === 'inspect.pack') data = require('./dist/core/application/inspection').planInspection(data, contracts, validateCad);
  if (entry.curve) data = curve.prepare(operation, data);
  if (entry.dataImport) {
    data = dataImport.prepare(operation, data);
    const models = operation === 'cots.replace' ? [data.result.model] : (data.result.items || []).map(r => r.model).filter(Boolean);
    for (const model of models) model.fusionPath = fusionPath(model.path);
  }
  const plan = planCadScript(operation, mapCadPaths(operation, data), context, entry, pythonLiteral);
  return prepareCadBundle(resolveRuntimePaths({ anchor: __filename }).installation, plan.wrapper,
    { request: plan.request, context: plan.context }, plan.profile);
}

function buildCadScript(operation, data, context) { return prepareCadScript(operation, data, context).script; }

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

const REFERENCE_READ_ACTIONS = new Set(['graph', 'preflight']);
function buildReferencesActionScript(action, data) {
  if (!['graph', 'preflight', 'sdkUpdate', 'nativeUpdate', 'save', 'coldVerify'].includes(action)) {
    throw new Error('Unsupported internal references.refresh SDK action');
  }
  const request = pythonLiteral({ action, data });
  return prepareCadBundle(resolveRuntimePaths({ anchor: __filename }).installation,
    `\n\n_FMCAD_REFERENCE_REQUEST: JsonObject = ${request}\ndef run(_context: str) -> None:\n    import json\n    _request = _FMCAD_REFERENCE_REQUEST\n    _result = _references_refresh_internal(_request['action'], _request['data'])\n    print('FMCAD_RESULT ' + json.dumps(_cad_json(_result), allow_nan=False))\n`, { request: { action, data } }).script;
}

async function executeReferencesAction(client, action, data, input) {
  if (!client) throw new Error(`references.refresh ${action} requires the selected Fusion backend`);
  const scriptData = { ...data };
  const nativeRpcTimeoutMs = action === 'nativeUpdate' ? scriptData.nativeRpcTimeoutMs : null;
  delete scriptData.nativeRpcTimeoutMs;
  const script = buildReferencesActionScript(action, scriptData);
  const readOnly = REFERENCE_READ_ACTIONS.has(action) && (input.lifecycle ?? 'existingOnly') === 'existingOnly';
  const server = client.server;
  const previousTimeoutMs = server?.timeoutMs;
  const timeoutAdjusted = Number.isFinite(nativeRpcTimeoutMs) && nativeRpcTimeoutMs > 0 &&
    server && Number.isFinite(previousTimeoutMs);
  if (timeoutAdjusted) server.timeoutMs = Math.min(previousTimeoutMs, nativeRpcTimeoutMs);
  let output;
  try {
    output = await client.callTool({ featureType: 'script', object: { script, readOnly } });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes('RPC not submitted:')) return { status: 'notStarted', notStarted: true, error: message };
    error.unknown = true;
    throw error;
  } finally {
    if (timeoutAdjusted) server.timeoutMs = previousTimeoutMs;
  }
  if (output.uiGuard?.notStarted === true) return { status: 'blocked', notStarted: true,
    activeCommand: output.uiGuard.activeCommand ?? null, error: output.text ?? 'Fusion command preflight rejected the script before user code.' };
  const line = String(output.text ?? '').split(/\r?\n/).find(value => value.startsWith('FMCAD_RESULT '));
  if (output.failed || !line) {
    const message = String(output.text ?? '');
    if (message.includes('RPC not submitted:')) return { status: 'notStarted', notStarted: true, error: message };
    const error = new Error(`references.refresh ${action} failed; inspect before retry. ${message}`);
    error.unknown = true;
    throw error;
  }
  return JSON.parse(line.slice('FMCAD_RESULT '.length));
}

async function executeExternalizationAction(client, action, data, readOnly) {
  if (!client) throw new Error('component.externalize requires the selected Fusion backend');
  if (!['inspect','perform'].includes(action)) throw new Error('Invalid private externalization action');
  const previous = client.server?.timeoutMs;
  const scriptData={...data,copyRpcBudgetMs:Math.min(previous ?? 180000,data.remainingMs ?? 180000)};
  const script = prepareCadBundle(resolveRuntimePaths({ anchor: __filename }).installation,
    `\n_EXTERNAL_REQUEST: JsonObject = ${pythonLiteral({action,data:scriptData})}\ndef run(_context: str) -> None:\n    _result = _external_refresh_internal(_EXTERNAL_REQUEST['action'], _EXTERNAL_REQUEST['data'])\n    print('FMCAD_RESULT ' + json.dumps(_cad_json(_result), allow_nan=False))\n`, { request: { action, data: scriptData } }).script;
  if (Number.isFinite(data.remainingMs) && data.remainingMs < 1000) return {status:'pending',
    receipt:{cursor:0,reason:'budgetExhausted',stopReason:'budgetExhausted'},notStarted:true};
  if (client.server && Number.isFinite(data.remainingMs)) client.server.timeoutMs = Math.min(previous ?? 180000, data.remainingMs);
  try {
    const output = await client.callTool({featureType:'script',object:{script,readOnly:action==='inspect' && readOnly===true}});
    if(output.uiGuard?.notStarted)return {status:'blocked',notStarted:true,receipt:{cursor:0,reason:'interactiveCommandActive'}};
    const line=String(output.text ?? '').split(/\r?\n/).find(row=>row.startsWith('FMCAD_RESULT '));
    if(output.failed || !line)throw new Error('External native outcome unknown; inspect existing operation. '+(output.text ?? ''));
    return JSON.parse(line.slice('FMCAD_RESULT '.length));
  } finally { if(client.server) {if(previous===undefined)delete client.server.timeoutMs;else client.server.timeoutMs=previous;} }
}

module.exports = { catalog, validateCad, buildCadScript, prepareCadScript, buildReferencesActionScript, executeReferencesAction, executeExternalizationAction,
  executeCad, mapCadPaths };
