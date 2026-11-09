'use strict';
// Node composition of declaration providers and specialist preflight. The pure
// core owns schemas, alias resolution, requirements and service contracts.
const fs = require('node:fs');
const path = require('node:path');
const { createOperationCatalog, projectMcpTools, decodeCatalogInvocation, catalogPolicyArguments,
  inspectCapabilities, validateCapabilitySearchInput, validateCapabilityProbeInput,
  validateCapabilityProbeIdentity, probeCapability } = require('../dist/core/catalog');
const modules = Object.fromEntries([
  'data-import', 'entity-query', 'sketch', 'datum', 'curve', 'surface', 'reference',
  'drawing-package', 'drawing-check', 'drawing-export', 'spring', 'thread', 'cam',
  'seal', 'fastener', 'feature-rework', 'ui', 'references-refresh',
  'document-publication', 'externalization',
].map(name => [name, require('../' + name)]));
const brepBaseline = require('./brep-baseline');
const brepBaselineInternal = require('./brep-baseline-internal');
const regionalGeometry = require('./regional-geometry');
const sectionWitness = require('./section-witness');
const selectionRules = require('./selection-rules');
const selectionRulesInternal = require('./selection-rules-internal');
const semanticModelState = require('./semantic-model-state');
const nativeDrive = require('./native-drive');
const catalog = {};
for (const name of ['data-import', 'curve', 'surface', 'spring', 'thread', 'cam',
  'seal', 'fastener', 'drawing-package', 'drawing-check', 'drawing-export']) {
  Object.assign(catalog, modules[name].descriptors);
}
for (const file of fs.readdirSync(__dirname).sort()) {
  if (!file.endsWith('.json')) continue;
  for (const [operation, entry] of Object.entries(require('./' + file))) {
    if (catalog[operation]) throw new Error('Duplicate CAD operation: ' + operation);
    catalog[operation] = entry;
  }
}
for (const name of ['datum', 'surface', 'reference', 'references-refresh']) modules[name].configure(catalog);

const services = {};
for (const name of ['reference', 'drawing-package', 'drawing-check', 'drawing-export', 'ui']) {
  for (const operation of Object.keys(modules[name].descriptors || {})) {
    if (catalog[operation]?.nodeOnly) services[operation] = name;
  }
}
for (const operation of modules['document-publication'].OPERATIONS) services[operation] = 'document-publication';
for (const operation of modules.ui.operations) services[operation] = 'ui';
Object.assign(services, {
  'component.externalize': 'externalization', 'references.refresh': 'references-refresh',
  'batch.summary': 'batch-summary', 'batch.reconcile': 'batch-atomic', 'batch.finalize': 'batch-atomic',
  'definition.instantiate': 'batch', 'capabilities.inspect': 'capabilities', 'capabilities.probe': 'capabilities',
});
for (const operation of ['measure.baseline.capture', 'measure.baseline.inspect', 'measure.baseline.compare']) {
  services[operation] = 'brep-baseline';
}
for (const operation of selectionRules.RULE_OPERATIONS) services[operation] = 'selection-rules';
for (const [operation, entry] of Object.entries(catalog)) {
  if (entry.batchMode || entry.definitionMode) services[operation] = 'batch';
}
function specialistValidation(operation, data) {
  if (operation === 'inspect.pack') require('../dist/core/application/inspection').planInspection(data, operationCatalog.contracts, operationCatalog.validate);
  nativeDrive.validate(operation, data);
  brepBaseline.validate(operation, data);
  regionalGeometry.validate(operation, data);
  sectionWitness.validate(operation, data);
  selectionRules.validate(operation, data);
  semanticModelState.validate(operation, data);
  if (operation === 'capabilities.inspect') validateCapabilitySearchInput(data);
  if (operation === 'capabilities.probe') validateCapabilityProbeInput(data);
  modules.ui.validate(operation, data);
  modules['references-refresh'].validate(data, operation);
  modules['document-publication'].validate(operation, data);
  if (operation === 'component.externalize') modules.externalization.validate(data);
  if (operation === 'batch.reconcile' && data.operations !== undefined &&
      (!Array.isArray(data.operations) || data.operations.length > 100 || data.operations.some(item =>
        !item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['operation', 'data'].includes(key)) ||
        typeof item.operation !== 'string' || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)))) {
    throw new Error('batch reconcile operations must be an array of at most 100 {operation,data} objects');
  }
  if (operation === 'definition.instantiate') require('../batch').validateBatchMode(data);
  modules['feature-rework'].validate(operation, data);
  if (catalog[operation].dataImport) modules['data-import'].prepare(operation, data);
  for (const name of ['entity-query', 'sketch', 'datum', 'curve', 'surface', 'reference',
    'drawing-package', 'drawing-check', 'drawing-export', 'spring', 'thread', 'cam', 'seal', 'fastener']) {
    modules[name].validate(operation, data);
  }
}
// Legacy reserved spellings are supplied only when projecting CLI routes. They
// are deliberately not imported here (commands -> catalog must stay acyclic).
const operationCatalog = createOperationCatalog(catalog, { services, validators: [specialistValidation] });
function validateCad(operation, data) {
  if (brepBaselineInternal.isInternal(operation)) return brepBaselineInternal.validateInternal(operation, data);
  if (selectionRulesInternal.isInternal(operation)) return selectionRulesInternal.validateInternal(operation, data);
  return operationCatalog.validate(operation, data);
}
function cliContracts(reservedCliKeys) {
  return Object.fromEntries(Object.entries(createOperationCatalog(catalog, { services, reservedCliKeys }).contracts)
    .filter(([, contract]) => !contract.declaration.internalOnly));
}
const mcpTools = projectMcpTools(operationCatalog.contracts);
const byMcpName = new Map(mcpTools.map(tool => [tool.name, tool]));
if (byMcpName.size !== mcpTools.length) throw new Error('Duplicate projected MCP tool name');

// MCP and workers consume the same typed application input. argv is compatibility
// metadata for existing broker route/document guards, never worker execution.
function mcpInvocation(name, args = {}) {
  const tool = byMcpName.get(name);
  if (!tool) throw new Error('Unknown catalog MCP tool: ' + name);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Catalog MCP arguments must be an object');
  const schema = tool.inputSchema;
  const missing = schema.required.filter(key => !Object.hasOwn(args, key));
  const unknown = Object.keys(args).filter(key => !Object.hasOwn(schema.properties, key));
  if (missing.length) throw new Error('Missing catalog MCP arguments: ' + missing.join(', '));
  if (unknown.length) throw new Error('Unknown catalog MCP arguments: ' + unknown.join(', '));
  const operation = tool._meta.fmcad.operation;
  const invocation = validateInvocation({ version: 1, kind: 'cad', operation, ...args });
  return { operation, invocation, argv: catalogPolicyArguments(invocation) };
}

function validateInvocation(value) {
  const input = decodeCatalogInvocation(value);
  const contract = operationCatalog.contracts[input.operation];
  if (contract?.declaration.internalOnly) throw new Error('Internal CAD operation is not public: ' + input.operation);
  const entry = operationCatalog.validate(input.operation, input.data);
  if (entry.requiresDoc !== false && !input.doc) throw new Error(input.operation + ' requires doc');
  if (entry.dataImport && input.data.inspectModel === true && !input.doc) throw new Error(input.operation + ' with inspectModel requires doc');
  if (input.operation === 'capabilities.probe' && !input.docId && !input.docFileId) {
    throw new Error('capabilities.probe requires --doc-id or --doc-file-id to pin the target identity');
  }
  if (input.operation === 'capabilities.probe') {
    validateCapabilityProbeIdentity({ docId: input.docId, docFileId: input.docFileId });
  }
  if (operationCatalog.contracts[input.operation]?.declaration.documentPin && !input.docId && !input.docFileId) {
    throw new Error(input.operation + ' requires --doc-id or --doc-file-id to pin the target document identity');
  }
  if (input.operation === 'snapshot.capture_v2') {
    const document = input.data.scope.document;
    if ((input.docId && document.creationId !== input.docId) ||
        (input.docFileId && document.fileId !== input.docFileId)) {
      throw new Error('snapshot.capture_v2 scope.document must match the pinned document identity');
    }
  }
  return input;
}

function localInvocation(input) {
  const spec = catalog[input.operation];
  return !!(spec.offline || input.preview || modules['data-import'].isOffline(input.operation, input.data) ||
    (input.operation === 'references.refresh' && input.data.phase === 'inspect') ||
    ['validate', 'preview'].includes(spec.batchMode) ||
    (input.operation === 'definition.instantiate' && input.data.mode && input.data.mode !== 'run'));
}

function executeCapability(operation, data, context = {}, ports = {}) {
  if (operation === 'capabilities.inspect') return inspectCapabilities(operationCatalog.contracts, data);
  if (operation !== 'capabilities.probe') throw new Error('Unknown capability operation: ' + operation);
  validateCapabilityProbeInput(data);
  const target = operationCatalog.contracts[data.capabilityId];
  if (!target || target.declaration.internalOnly) {
    return { success: false, status: 'missing', operation,
      result: { capabilityId: data.capabilityId, reason: 'notRegistered' } };
  }
  if (target.requirements.sdk === 'none') {
    return { success: false, status: 'unsupported', operation,
      result: { capabilityId: data.capabilityId, reason: 'sdkNotRequired' } };
  }
  if (!context.docId && !context.docFileId) {
    throw new Error('capabilities.probe requires a pinned document identity');
  }
  const backend = ports.backend;
  if (!['mcp', 'addin'].includes(backend)) {
    throw new Error('capabilities.probe requires an explicit selected backend');
  }
  return probeCapability(ports.brokerSdkProbePort, {
    capabilityId: data.capabilityId,
    backend,
    documentIdentity: {
      ...(context.docId ? { docId: context.docId } : {}),
      ...(context.docFileId ? { docFileId: context.docFileId } : {}),
    },
  }).then(result => ({ success: result.status === 'pass', status: result.status, operation, result }));
}

module.exports = { catalog, contracts: operationCatalog.contracts, validateCad,
  cliContracts, mcpTools, byMcpName, mcpInvocation, validateInvocation, localInvocation,
  executeCapability, catalogPolicyArguments, selectionRulesInternal, semanticModelState };
