'use strict';

const { createOperationCatalog } = require('../dist/core/catalog');
const selectionRules = require('./selection-rules');

const declarations = {
  'selection.rule.define_internal': {
    summary: 'Private broker-authorized selection rule definition turn.',
    required: ['definition', '_trustedBinding'],
    inputs: {
      definition: 'Validated public selection rule definition.',
      _trustedBinding: 'Coordinator-owned operation binding.',
    },
    example: {},
    limitations: ['Private Fusion turn; never exposed as a CLI or MCP operation.'],
    readOnly: true,
    internalOnly: true,
  },
  'selection.rule.inspect_internal': {
    summary: 'Private broker-authorized selection rule inspection turn.',
    required: ['manifest', '_trustedBinding'],
    inputs: {
      manifest: 'Project/document-owned version-1 selection rule manifest.',
      _trustedBinding: 'Coordinator-owned operation binding.',
    },
    example: {},
    limitations: ['Private Fusion turn; never exposed as a CLI or MCP operation.'],
    readOnly: true,
    internalOnly: true,
  },
  'selection.rule.resolve_internal': {
    summary: 'Private broker-authorized current-topology selection rule resolve turn.',
    required: ['manifest', '_trustedBinding'],
    inputs: {
      manifest: 'Project/document-owned version-1 selection rule manifest.',
      _trustedBinding: 'Coordinator-owned operation binding.',
    },
    example: {},
    limitations: ['Private Fusion turn; never exposed as a CLI or MCP operation.'],
    readOnly: true,
    internalOnly: true,
  },
  'selection.rule.check_internal': {
    summary: 'Private broker-authorized current-topology selection rule check turn.',
    required: ['manifest', '_trustedBinding'],
    inputs: {
      manifest: 'Project/document-owned version-1 selection rule manifest.',
      _trustedBinding: 'Coordinator-owned operation binding.',
    },
    example: {},
    limitations: ['Private Fusion turn; never exposed as a CLI or MCP operation.'],
    readOnly: true,
    internalOnly: true,
  },
};

const authorized = new WeakMap();
const privateCatalog = createOperationCatalog(declarations, {
  services: {},
  validators: [(operation, data) => {
    if (!data._trustedBinding || data._trustedBinding.version !== 1 ||
        data._trustedBinding.service !== 'selection-rules') {
      throw new Error('Invalid selection-rule coordinator binding');
    }
    if (operation === 'selection.rule.define_internal') selectionRules.definition(data.definition);
    else if (!data.manifest || typeof data.manifest !== 'object' || Array.isArray(data.manifest)) {
      throw new Error('Selection-rule internal operation requires a manifest object');
    }
  }],
});

function isInternal(operation) {
  return Object.hasOwn(privateCatalog.contracts, operation);
}

function authorize(operation, data) {
  if (!isInternal(operation) || !data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid private selection-rule turn');
  authorized.set(data, operation);
}

function validateInternal(operation, data) {
  if (!data || authorized.get(data) !== operation)
    throw new Error('Private selection-rule turns require an owned coordinator capability');
  return privateCatalog.validate(operation, data);
}

module.exports = { isInternal, authorize, validateInternal };
