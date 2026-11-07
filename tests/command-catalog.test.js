'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationCatalog, projectMcpTools, indexCommandRoutes } = require('../src/dist/core/catalog');
const { catalog, contracts, validateCad, mcpTools, byMcpName, mcpInvocation } = require('../src/catalog');
const { commands, findCommand } = require('../src/commands');
const { detail } = require('../src/help');

test('one declaration projects identical CLI/help/MCP schemas, requirements and aliases', () => {
  const publicOperations = Object.keys(catalog).filter(operation => !catalog[operation].internalOnly).sort();
  assert.deepEqual(commands.filter(command => command.kind === 'cad').map(command => command.target).sort(), publicOperations);
  assert.deepEqual(mcpTools.map(tool => tool._meta.fmcad.operation).sort(), publicOperations);
  assert.equal(byMcpName.size, publicOperations.length);
  assert.equal(require('../src/cad').validateCad, validateCad);
  for (const command of commands.filter(command => command.kind === 'cad')) {
    const contract = command.contract;
    const tool = mcpTools.find(tool => tool._meta.fmcad.operation === command.target);
    assert.deepEqual(tool.inputSchema.properties.data, contract.schema);
    assert.deepEqual(tool._meta.fmcad.requirements, contract.requirements);
    assert.equal(contract.declaration, catalog[command.target]);
    assert.equal(command.requiresDoc, contract.requirements.document);
    assert.deepEqual(contract.schema.required, catalog[command.target].required);
    assert.deepEqual(Object.keys(contract.schema.properties), Object.keys(catalog[command.target].inputs));
    assert.equal(tool._meta.fmcad.readOnlyEnforced, false);
    assert.equal(tool.annotations.readOnlyHint, catalog[command.target].readOnly);
    assert.match(detail(...command.key.split(' ')), /Neither capability nor successful execution certifies geometry or cloud access/);
    for (const alias of [command.key, ...contract.cli.aliases]) assert.equal(findCommand(alias.split(' ')), command);
  }
  assert.equal(byMcpName.has('fmcad_cad_document_save_native'), false);
  assert.equal(mcpTools.some(tool => /keychain/.test(tool.name)), false);
});

test('negative outer-schema cases fail through the same validator for every operation', () => {
  for (const [operation, entry] of Object.entries(catalog)) {
    for (const invalid of [null, [], 'object', 1, false]) assert.throws(() => validateCad(operation, invalid), /CAD data must be an object/);
    assert.throws(() => validateCad(operation, { ...entry.example, _notAnInput: true }), /Unknown CAD inputs/);
    for (const key of entry.required) {
      const data = { ...entry.example };
      delete data[key];
      assert.throws(() => validateCad(operation, data), /Missing CAD inputs/);
    }
  }
  assert.throws(() => validateCad('missing.operation', {}), /Unknown CAD operation/);
  assert.throws(() => validateCad('curve.inspect', { ...catalog['curve.inspect'].example, schemaVersion: '1' }), /schemaVersion/);
  assert.throws(() => validateCad('batch.reconcile', { reportPath: 'report', operations: [{ operation: 'check', data: {}, extra: true }] }), /at most 100/);
});

test('core rejects malformed declarations, missing services and alias collisions offline', () => {
  const entry = { summary: 'Test', inputs: {}, required: [], example: {}, limitations: [], readOnly: true };
  assert.throws(() => createOperationCatalog({ 'test.op': { ...entry, required: ['missing'] } }, { services: {} }), /Invalid CAD declaration/);
  assert.throws(() => createOperationCatalog({ 'test.op': { ...entry, nodeOnly: true } }, { services: {} }), /Missing CAD service/);
  assert.throws(() => createOperationCatalog({ 'model.test': entry, test: entry }, { services: {} }), /Duplicate CAD spelling/);
  assert.throws(() => createOperationCatalog({ 'test.op': entry }, { services: {}, reservedCliKeys: ['cad test op'] }), /Duplicate CAD spelling/);
  let called = 0;
  const shared = createOperationCatalog({ 'test.op': entry }, { services: {}, validators: [() => { called++; }] });
  shared.validate('test.op', {});
  assert.equal(called, 1);
  assert.equal(projectMcpTools(shared.contracts)[0].inputSchema.properties.data, shared.contracts['test.op'].schema);
  assert.throws(() => indexCommandRoutes([{ key: 'local', aliases: ['alias'] }, { key: 'alias' }]), /Duplicate command spelling/);
  const routes = [{ key: 'local' }, { key: 'local inspect', aliases: ['inspect'] }];
  const lookup = indexCommandRoutes(routes);
  assert.equal(lookup(['local', 'inspect', '--json']), routes[1]);
  assert.equal(lookup(['inspect']), routes[1]);
  assert.equal(lookup(['unknown']), undefined);
});

test('MCP invocation adaptation produces typed application input and matching broker guard metadata', () => {
  for (const tool of mcpTools) {
    const operation = tool._meta.fmcad.operation;
    const input = { data: catalog[operation].example, doc: 'Model', preview: true, purpose: 'Inspect contract',
      ...(operation === 'capabilities.probe' || catalog[operation].documentPin
        ? { docId: catalog[operation].example?.scope?.document?.creationId || 'creation-id' }
        : {}) };
    const invocation = mcpInvocation(tool.name, input);
    assert.equal(invocation.operation, operation);
    assert.equal(invocation.invocation.operation, operation);
    assert.deepEqual(invocation.invocation.data, input.data);
    assert.equal(findCommand(invocation.argv).target, operation);
    assert.ok(invocation.argv.includes('--preview'));
  }
  const name = 'fmcad_cad_entity_list';
  for (const args of [null, [], { data: {}, extra: true }, { data: {} }, { data: {}, doc: 5 },
    { data: {}, doc: 'Model', preview: 'true' }, { data: {}, doc: 'Model', purpose: 'bad\nmetadata' }]) {
    assert.throws(() => mcpInvocation(name, args));
  }
  assert.throws(() => mcpInvocation('fusion_mcp_update', {}), /Unknown catalog MCP tool/);
  assert.throws(() => mcpInvocation('fmcad_cad_batch_summary', { data: { reportPath: 'report' }, docId: 'pin' }), /pins require doc/);
});

test('local requirements and coordinator bindings are explicit, not capability claims', async () => {
  for (const operation of ['batch.summary', 'batch.validate', 'batch.preview', 'definition.inspect', 'definition.expand', 'reference.layout', 'drawing.check']) {
    assert.equal(contracts[operation].requirements.sdk, 'none', operation);
    assert.equal(contracts[operation].service.kind, 'local', operation);
  }
  assert.equal(contracts['document.status'].service.kind, 'python');
  assert.equal(contracts['document.save.once'].service.handler, 'document-publication');
  assert.deepEqual(contracts['ui.inspect'].requirements.backends, ['addin']);
  for (const contract of Object.values(contracts)) {
    assert.equal(contract.requirements.cloudAccess, 'not-implied');
    assert.equal(contract.requirements.purpose, 'optional');
  }
  assert.equal(contracts['document.save.once'].requirements.cloud, 'required');
  assert.equal(contracts['batch.summary'].requirements.cloud, 'none');
  assert.equal(contracts['document.status'].requirements.cloud, 'unknown');
  const result = await require('../src/cad').executeCad(null, 'definition.inspect', catalog['definition.inspect'].example, {});
  assert.equal(result.success, true);
});
